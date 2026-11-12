import { google, type GoogleLanguageModelOptions } from '@ai-sdk/google';
import { groq, type GroqLanguageModelChatOptions } from '@ai-sdk/groq';
import { APICallError, RetryError, wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from 'ai';

// The only file that knows which providers and models are used. Everything
// else asks for a tier and passes along the settings that come with it.

export type Provider = 'gemini' | 'groq';

const DEFAULT_MODELS: Record<Provider, { fast: string; smart: string }> = {
  gemini: { fast: 'gemini-3.5-flash-lite', smart: 'gemini-3.8-flash' },
  groq: { fast: 'openai/gpt-oss-20b', smart: 'openai/gpt-oss-120b' },
};

export const PROVIDER: Provider = parseProvider(process.env.LLM_PROVIDER);
// MODEL_FAST / MODEL_SMART name models of the selected provider.
const FAST_MODEL = process.env.MODEL_FAST || DEFAULT_MODELS[PROVIDER].fast;
const SMART_MODEL = process.env.MODEL_SMART || DEFAULT_MODELS[PROVIDER].smart;

export const API_KEY_VARIABLE: Record<Provider, string> = {
  gemini: 'GOOGLE_GENERATIVE_AI_API_KEY',
  groq: 'GROQ_API_KEY',
};

export function parseProvider(value: string | undefined): Provider {
  const name = (value ?? '').trim().toLowerCase();
  if (name === '' || name === 'gemini' || name === 'google') return 'gemini';
  if (name === 'groq') return 'groq';
  throw new Error(`LLM_PROVIDER must be "gemini" or "groq", not "${value}".`);
}

// Keys the selected provider needs; the server and scripts refuse to start without them.
export function requiredKeys(): string[] {
  return [API_KEY_VARIABLE[PROVIDER], 'TAVILY_API_KEY'];
}

// Settings for both providers ride along on every call; each provider reads
// only its own key, so a call that falls back to Groq keeps its settings.
type ProviderOptions = { google: GoogleLanguageModelOptions; groq: GroqLanguageModelChatOptions };

export interface Tier {
  model: () => LanguageModel;
  providerOptions: ProviderOptions;
}

// Gemini 3 models take a thinking level; earlier ones a token budget. Either
// way the fast tier thinks little: it routes and extracts on or near the
// critical path, where every second of reasoning is a second of waiting.
function geminiLowThinking(modelId: string): GoogleLanguageModelOptions['thinkingConfig'] {
  return /^gemini-([3-9]|\d{2,})/.test(modelId) ? { thinkingLevel: 'low' } : { thinkingBudget: 512 };
}

// Only Groq's reasoning models accept a reasoning effort; others reject it.
function groqLowReasoning(modelId: string): GroqLanguageModelChatOptions {
  return /^(openai\/gpt-oss|qwen\/)/.test(modelId) ? { reasoningEffort: 'low' } : {};
}

// The fast tier's Groq settings must suit whichever Groq model actually runs:
// the configured one, or the default one used for a fallback.
const groqFastModel = PROVIDER === 'groq' ? FAST_MODEL : DEFAULT_MODELS.groq.fast;

// Planning and claim extraction.
export const fast: Tier = {
  model: () => build(FAST_MODEL, DEFAULT_MODELS.groq.fast),
  providerOptions: {
    google: PROVIDER === 'gemini' ? { thinkingConfig: geminiLowThinking(FAST_MODEL) } : {},
    groq: groqLowReasoning(groqFastModel),
  },
};

// Writes the answer the user reads, so it keeps the model's default thinking.
export const smart: Tier = {
  model: () => build(SMART_MODEL, DEFAULT_MODELS.groq.smart),
  providerOptions: { google: {}, groq: {} },
};

function build(modelId: string, groqFallbackId: string): LanguageModel {
  if (PROVIDER === 'groq') return withGroqBackoff(groq(modelId));
  const model = google(modelId);
  // Without a Groq key a Gemini quota error surfaces as usual.
  if (!process.env.GROQ_API_KEY) return model;
  return wrapLanguageModel({ model, middleware: fallbackOnQuota(withGroqBackoff(groq(groqFallbackId))) });
}

type ProviderModel = ReturnType<typeof groq>;

// --- Gemini → Groq fallback ----------------------------------------------------

// A Gemini call that fails for quota reasons is retried once on Groq. Only
// quota: an overloaded model (503), a bad key or a bad request are not fixed
// by switching provider, and silently doing so would hide them.
export function fallbackOnQuota(backup: ProviderModel): LanguageModelMiddleware {
  const warn = (model: { modelId: string }, error: unknown) =>
    console.warn(`Gemini quota exhausted on ${model.modelId} (${shortError(error)}); retrying this call on Groq ${backup.modelId}.`);
  return {
    specificationVersion: 'v4',
    // Caught here, inside the SDK's retry loop, so a quota error goes to Groq
    // at once instead of being retried against the exhausted quota first.
    wrapGenerate: async ({ doGenerate, params, model }) => {
      try {
        return await doGenerate();
      } catch (error) {
        if (!isQuotaError(error)) throw error;
        warn(model, error);
        return backup.doGenerate(params);
      }
    },
    wrapStream: async ({ doStream, params, model }) => {
      try {
        return await doStream();
      } catch (error) {
        if (!isQuotaError(error)) throw error;
        warn(model, error);
        return backup.doStream(params);
      }
    },
  };
}

export function isQuotaError(error: unknown): boolean {
  if (!APICallError.isInstance(error)) return false;
  return error.statusCode === 429 || /RESOURCE_EXHAUSTED|quota/i.test(`${error.message} ${error.responseBody ?? ''}`);
}

// --- Groq rate limits ----------------------------------------------------------

// The longest wait worth making a user sit through. A longer Retry-After
// means the per-minute budget is spent; better to say so straight away.
const MAX_BACKOFF_MS = 15_000;
// When Groq doesn't say how long to wait.
const DEFAULT_BACKOFF_MS = 2_000;

// Groq's free tier allows a few thousand tokens a minute, so 429s are
// expected. Wait once as long as Groq asks, retry, and if that fails too, stop
// with an error the user can act on.
export class RateLimitedError extends Error {
  readonly retryAfterSeconds: number | undefined;
  constructor(retryAfterSeconds: number | undefined, options?: { cause?: unknown }) {
    super(`Rate-limited by Groq${retryAfterSeconds !== undefined ? `; retry after ${retryAfterSeconds}s` : ''}`, options);
    this.name = 'RateLimitedError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function withGroqBackoff(model: ProviderModel, sleep: (ms: number, signal?: AbortSignal) => Promise<void> = delay): ProviderModel {
  async function once<T>(call: () => PromiseLike<T>, signal: AbortSignal | undefined): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (!isRateLimit(error)) throw error;
      const waitMs = retryAfterMs(error);
      if (waitMs > MAX_BACKOFF_MS) throw new RateLimitedError(Math.ceil(waitMs / 1000), { cause: error });
      console.warn(`Groq rate limit on ${model.modelId}; retrying once in ${Math.round(waitMs / 100) / 10}s.`);
      await sleep(waitMs, signal);
      try {
        return await call();
      } catch (second) {
        // Thrown as a plain error, which the SDK does not retry again.
        if (isRateLimit(second)) throw new RateLimitedError(Math.ceil(retryAfterMs(second) / 1000), { cause: second });
        throw second;
      }
    }
  }
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: 'v4',
      wrapGenerate: ({ doGenerate, params }) => once(doGenerate, params.abortSignal),
      wrapStream: ({ doStream, params }) => once(doStream, params.abortSignal),
    },
  }) as ProviderModel;
}

function isRateLimit(error: unknown): error is APICallError {
  return APICallError.isInstance(error) && error.statusCode === 429;
}

// Retry-After is seconds (or an HTTP date); Groq also sends retry-after-ms on some limits.
export function retryAfterMs(error: APICallError): number {
  const headers = error.responseHeaders ?? {};
  const ms = Number(headers['retry-after-ms']);
  if (Number.isFinite(ms) && ms >= 0) return ms;
  const value = headers['retry-after'];
  if (value !== undefined) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(value);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  }
  return DEFAULT_BACKOFF_MS;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(timer), reject(signal.reason)), { once: true });
  });
}

// --- Errors for people ---------------------------------------------------------

// The SDK wraps repeated failures in a RetryError; the last attempt says why.
export function rootError(error: unknown): unknown {
  return RetryError.isInstance(error) ? error.lastError : error;
}

function shortError(error: unknown): string {
  return APICallError.isInstance(error) ? `${error.statusCode ?? '?'}` : error instanceof Error ? error.message : String(error);
}
