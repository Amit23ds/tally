import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { APICallError, Output, RetryError, generateText, streamText, wrapLanguageModel } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import { textStep } from '../test/models.ts';
import { describeError } from './answer.ts';
import { ExtractedSchema } from './extract.ts';
import { RateLimitedError, fallbackOnQuota, isQuotaError, parseProvider, retryAfterMs, withGroqBackoff } from './models.ts';
import { PlanSchema } from './plan.ts';

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};
const reply = (text: string) => ({
  content: [{ type: 'text' as const, text }],
  finishReason: { unified: 'stop' as const, raw: undefined },
  usage,
  warnings: [],
});

function apiError(statusCode: number, body: string, headers: Record<string, string> = {}, url = 'https://generativelanguage.googleapis.com/v1beta/x') {
  return new APICallError({
    message: body,
    url,
    requestBodyValues: {},
    statusCode,
    responseHeaders: headers,
    responseBody: body,
    isRetryable: statusCode === 429 || statusCode >= 500,
  });
}

// A model whose doGenerate answers with `outcomes` in turn: an error is thrown, a string returned.
function scripted(outcomes: Array<Error | string>, modelId = 'mock') {
  let call = 0;
  const model = new MockLanguageModelV4({
    modelId,
    doGenerate: async () => {
      const outcome = outcomes[Math.min(call++, outcomes.length - 1)]!;
      if (outcome instanceof Error) throw outcome;
      return reply(outcome);
    },
  });
  return { model, calls: () => call };
}

// The fallback target is typed as a Groq model; a mock stands in for it.
type Backup = Parameters<typeof fallbackOnQuota>[0];
const quiet = <T>(fn: () => Promise<T>): Promise<T> => {
  const warn = console.warn;
  console.warn = () => {};
  return fn().finally(() => (console.warn = warn));
};

describe('Gemini → Groq fallback', () => {
  const quota = apiError(429, '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"You exceeded your current quota"}}');

  it('retries a quota error once on Groq, without first retrying Gemini', async () => {
    const gemini = scripted([quota]);
    const groq = scripted(['from groq']);
    const model = wrapLanguageModel({ model: gemini.model, middleware: fallbackOnQuota(groq.model as unknown as Backup) });
    const { text } = await quiet(() => generateText({ model, prompt: 'hi' }));
    assert.equal(text, 'from groq');
    assert.equal(gemini.calls(), 1);
    assert.equal(groq.calls(), 1);
  });

  it('falls back for a streamed answer too', async () => {
    const gemini = new MockLanguageModelV4({
      doStream: async () => {
        throw quota;
      },
    });
    const groq = new MockLanguageModelV4({ doStream: [textStep('streamed from groq')] });
    const model = wrapLanguageModel({ model: gemini, middleware: fallbackOnQuota(groq as unknown as Backup) });
    const result = streamText({ model, prompt: 'hi', onError: () => {} });
    assert.equal(await quiet(async () => result.text), 'streamed from groq');
  });

  it('does not fall back on other errors, such as an overloaded model', async () => {
    const busy = apiError(503, 'This model is currently experiencing high demand.');
    const gemini = scripted([busy]);
    const groq = scripted(['from groq']);
    const model = wrapLanguageModel({ model: gemini.model, middleware: fallbackOnQuota(groq.model as unknown as Backup) });
    await assert.rejects(generateText({ model, prompt: 'hi', maxRetries: 0 }), /high demand/);
    assert.equal(groq.calls(), 0);
  });

  it('recognises quota errors by status or by message', () => {
    assert.equal(isQuotaError(quota), true);
    assert.equal(isQuotaError(apiError(400, 'RESOURCE_EXHAUSTED: quota')), true);
    assert.equal(isQuotaError(apiError(503, 'overloaded')), false);
    assert.equal(isQuotaError(new Error('429')), false);
  });
});

describe('Groq rate limits', () => {
  const limited = (retryAfter: string) =>
    apiError(429, 'Rate limit reached for model openai/gpt-oss-120b: tokens per minute', { 'retry-after': retryAfter }, 'https://api.groq.com/openai/v1/chat/completions');

  it('waits as long as Retry-After asks, then retries once', async () => {
    const groq = scripted([limited('3'), 'ok']);
    const waits: number[] = [];
    const model = withGroqBackoff(groq.model as unknown as Backup, async (ms) => void waits.push(ms));
    const { text } = await quiet(() => generateText({ model, prompt: 'hi' }));
    assert.equal(text, 'ok');
    assert.deepEqual(waits, [3000]);
    assert.equal(groq.calls(), 2);
  });

  it('gives up after one retry with an error the SDK does not retry again', async () => {
    const groq = scripted([limited('1')]);
    const model = withGroqBackoff(groq.model as unknown as Backup, async () => {});
    const error = await quiet(() => generateText({ model, prompt: 'hi' }).then(() => undefined, (e: unknown) => e));
    assert.ok(error instanceof RateLimitedError);
    assert.equal(groq.calls(), 2);
    assert.match(describeError(error), /rate-limited.*try again in a few seconds/i);
  });

  it("doesn't make the user sit through a long wait", async () => {
    const groq = scripted([limited('45')]);
    const waits: number[] = [];
    const model = withGroqBackoff(groq.model as unknown as Backup, async (ms) => void waits.push(ms));
    const error = await generateText({ model, prompt: 'hi' }).then(() => undefined, (e: unknown) => e);
    assert.ok(error instanceof RateLimitedError);
    assert.deepEqual(waits, []);
    assert.equal(groq.calls(), 1);
    assert.match(describeError(error), /try again in 45 seconds/);
  });

  it('reads retry-after-ms, seconds and missing headers', () => {
    assert.equal(retryAfterMs(apiError(429, '', { 'retry-after-ms': '250' })), 250);
    assert.equal(retryAfterMs(apiError(429, '', { 'retry-after': '2.5' })), 2500);
    assert.equal(retryAfterMs(apiError(429, '')), 2000);
  });
});

describe('describeError()', () => {
  it('looks inside the RetryError the SDK wraps repeated failures in', () => {
    const busy = apiError(503, 'high demand');
    const wrapped = new RetryError({ message: 'Failed after 3 attempts', reason: 'maxRetriesExceeded', errors: [busy, busy, busy] });
    assert.match(describeError(wrapped), /busy right now/);
  });

  it('names the key of the provider that rejected it', () => {
    assert.match(describeError(apiError(401, 'Invalid API Key', {}, 'https://api.groq.com/openai/v1/chat/completions')), /GROQ_API_KEY/);
    assert.match(describeError(apiError(400, 'API key not valid')), /GOOGLE_GENERATIVE_AI_API_KEY/);
  });
});

describe('parseProvider()', () => {
  it('defaults to Gemini and rejects unknown names', () => {
    assert.equal(parseProvider(undefined), 'gemini');
    assert.equal(parseProvider(' Groq '), 'groq');
    assert.throws(() => parseProvider('openai'), /gemini" or "groq/);
  });
});

// Groq's strict structured outputs (constrained decoding) accept only objects
// whose properties are all required, with additionalProperties false, and no
// unsupported keywords. The planner and extractor schemas must stay inside that.
describe('structured output schemas work with Groq strict mode', () => {
  const unsupported = ['oneOf', 'allOf', 'not', 'if', 'pattern', 'format', 'minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems'];

  function assertStrict(schema: Record<string, unknown>, path = '$'): void {
    for (const key of unsupported) assert.ok(!(key in schema), `${path} uses "${key}"`);
    if (schema.type === 'object') {
      const properties = Object.keys((schema.properties ?? {}) as object);
      assert.deepEqual([...((schema.required ?? []) as string[])].sort(), properties.sort(), `${path}: every property must be required`);
      assert.equal(schema.additionalProperties, false, `${path}: additionalProperties must be false`);
      for (const [name, child] of Object.entries(schema.properties as Record<string, Record<string, unknown>>)) assertStrict(child, `${path}.${name}`);
    }
    if (schema.type === 'array') assertStrict(schema.items as Record<string, unknown>, `${path}[]`);
  }

  for (const [name, schema] of [['plan', PlanSchema], ['claims', ExtractedSchema]] as const) {
    it(`the ${name} schema`, () => assertStrict(z.toJSONSchema(schema) as Record<string, unknown>));
  }

  it('the planner schema round-trips through structured output', async () => {
    const plan = { intent: 'lookup', needs_search: true, entities: ['Neon'], since: '', queries: ['Neon pricing'] };
    const model = scripted([JSON.stringify(plan)]);
    const { output } = await generateText({ model: model.model, prompt: 'plan', output: Output.object({ schema: PlanSchema }) });
    assert.deepEqual(output, plan);
  });
});
