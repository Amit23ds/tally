import { APICallError, stepCountIs, streamText, tool, type LanguageModel } from 'ai';
import { z } from 'zod';
import type { Source, StreamEvent } from './events.ts';
import { TOKEN_BUDGET, tokensToChars } from './budget.ts';
import { debug, stopwatch } from './log.ts';
import { RateLimitedError, rootError, smart } from './models.ts';
import { ANSWER_SYSTEM_PROMPT, WEB_SEARCH_TOOL_DESCRIPTION, answerContext, type AnswerContext } from './prompts.ts';
import { normalizeUrl, relevantExcerpt, type SearchProvider, type SearchResult } from './search.ts';

// The planner's searches run before the answer starts. The model may then
// search for gaps itself, at most twice: a bounded follow-up instead of an
// open-ended agent loop, so latency stays predictable.
const MAX_EXTRA_SEARCHES = 2;
// Two extra searches take at most two tool rounds, then a final writing step.
const MAX_STEPS = MAX_EXTRA_SEARCHES + 1;
export const RESULTS_PER_SEARCH = 5;
// Input length is the main lever on time to first token. All results in one
// answer, planned and follow-up, share one budget, so six queries get shorter
// excerpts than two instead of six times the text. Each result keeps at least
// a usable snippet, and room for the follow-up searches' snippets is set aside
// before the planned results are sized, so the cap holds either way.
const SEARCH_BUDGET_CHARS = tokensToChars(TOKEN_BUDGET.searchContext);
const MIN_RESULT_CHARS = 400;
const MAX_RESULT_CHARS = tokensToChars(TOKEN_BUDGET.searchResult);

export interface PreSearch {
  query: string;
  // Set when results were limited to pages published on or after this date.
  startDate?: string;
  results: SearchResult[];
}

export interface AnswerOptions {
  // Conversation so far, ending with the user's new message.
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  // Date, timezone, recalled record; search results are added from `searches`.
  context: Omit<AnswerContext, 'searchResults'>;
  // Searches the planner already ran for this message.
  searches: PreSearch[];
  // False for small talk: the model must answer without searching.
  allowSearch: boolean;
  search: SearchProvider;
  emit: (event: StreamEvent) => Promise<void>;
  signal: AbortSignal;
  // Injected by tests; defaults to the strong model.
  model?: LanguageModel;
}

export interface Answer {
  text: string;
  sources: Source[];
  // Time from the start of answer() to the first streamed token.
  firstTokenMs?: number;
}

export async function answer({ messages, context, searches, allowSearch, search, emit, signal, model }: AnswerOptions): Promise<Answer> {
  const elapsed = stopwatch();
  const sources = new SourceList();
  // Numbered first, so pre-search results are [1], [2], ... and later searches continue the sequence.
  const budget = new SearchBudget(SEARCH_BUDGET_CHARS);
  const resultCount = searches.reduce((sum, s) => sum + s.results.length, 0);
  // Follow-up searches only happen when searching is allowed.
  const reserve = allowSearch ? MAX_EXTRA_SEARCHES * RESULTS_PER_SEARCH * MIN_RESULT_CHARS : 0;
  const perResult = budget.perResult(resultCount, reserve);
  const searchResults = searches
    .map(({ query, startDate, results }) => {
      const heading = `## Query: ${query}${startDate ? ` (only pages published since ${startDate})` : ''}`;
      return `${heading}\n${budget.spend(formatResults(numbered(sources, results), perResult, query))}`;
    })
    .join('\n\n');
  let extraSearches = 0;
  let firstTokenMs: number | undefined;

  const webSearch = tool({
    description: WEB_SEARCH_TOOL_DESCRIPTION,
    inputSchema: z.object({
      query: z.string().min(2).max(300).describe('A specific search query, e.g. "Neon Postgres pricing".'),
    }),
    execute: async ({ query }) => {
      if (extraSearches >= MAX_EXTRA_SEARCHES) {
        return 'Search limit reached for this answer. Answer with the results you already have.';
      }
      extraSearches++;
      await emit({ type: 'status', text: `Searching: ${query}` });
      const timer = stopwatch();
      try {
        const results = await search.search({ query, maxResults: RESULTS_PER_SEARCH, signal });
        debug('extra search %dms, %d results: %s', timer(), results.length, query);
        return budget.spend(formatResults(numbered(sources, results), budget.perResult(results.length), query));
      } catch (error) {
        if (signal.aborted) throw error;
        console.warn(`Search failed for "${query}":`, error instanceof Error ? error.message : error);
        // Returned rather than thrown, so the model can say it couldn't check
        // instead of the whole answer failing.
        return 'The search failed. Tell the user you could not check this right now; do not guess.';
      }
    },
  });

  const result = streamText({
    model: model ?? smart.model(),
    // Gemini reuses the longest repeated prefix of a request. The system
    // prompt never changes, and the stored history only grows, so both stay a
    // stable prefix. Everything that varies per request (date, recalled
    // record, search results) rides in the newest user turn instead: Gemini
    // accepts system text only at the start, where it would break the prefix.
    instructions: ANSWER_SYSTEM_PROMPT,
    messages: [
      ...messages.slice(0, -1),
      {
        role: 'user',
        content: [
          { type: 'text', text: answerContext({ ...context, ...(searchResults && { searchResults }) }) },
          { type: 'text', text: messages.at(-1)!.content },
        ],
      },
    ],
    // The only tool is our own web_search: Gemini's built-in Google Search is
    // deliberately not enabled, so we control queries, dates and source text.
    // It stays declared even when searching is off, keeping the prefix stable.
    tools: { web_search: webSearch },
    toolChoice: allowSearch ? 'auto' : 'none',
    stopWhen: stepCountIs(MAX_STEPS),
    // Once the extra searches are used up, or on the last allowed step, the
    // model must write. Without this it can spend a whole round trip asking
    // for a search that would be refused.
    prepareStep: ({ stepNumber }) =>
      stepNumber === MAX_STEPS - 1 || extraSearches >= MAX_EXTRA_SEARCHES ? { toolChoice: 'none' } : undefined,
    maxOutputTokens: 16_000,
    abortSignal: signal,
    // Errors arrive as stream parts and are rethrown below for the caller to
    // log once; the SDK's default handler would print each one a second time.
    onError: () => {},
    providerOptions: smart.providerOptions,
  });

  let text = '';
  let newStep = false;
  const citations = new CitationRewriter();
  const write = async (chunk: string) => {
    if (!chunk) return;
    // Text from separate steps would otherwise run together mid-word.
    const delta = newStep && text ? `\n\n${chunk}` : chunk;
    newStep = false;
    firstTokenMs ??= elapsed();
    text += delta;
    await emit({ type: 'token', text: delta });
  };
  for await (const part of result.stream) {
    switch (part.type) {
      case 'start-step':
        await write(citations.flush());
        newStep = true;
        if (sources.size > 0 && !text) await emit({ type: 'status', text: `Reading ${sources.size} sources…` });
        break;
      case 'text-delta':
        await write(citations.push(part.text));
        break;
      case 'error':
        throw part.error;
      case 'finish':
        debug('answer %dms, %d extra searches, finish=%s, usage %o', elapsed(), extraSearches, part.finishReason, part.totalUsage);
        break;
    }
  }

  await write(citations.flush());
  const cited = sources.cited(text);
  if (cited.length > 0) await emit({ type: 'sources', sources: cited });
  return { text, sources: cited, ...(firstTokenMs !== undefined && { firstTokenMs }) };
}

// Numbers are assigned once per answer, in the order sources are first seen,
// so the same page keeps the same [n] across searches.
export class SourceList {
  readonly #byKey = new Map<string, Source>();

  get size(): number {
    return this.#byKey.size;
  }

  add(result: SearchResult): Source {
    const key = normalizeUrl(result.url);
    let source = this.#byKey.get(key);
    if (!source) {
      source = {
        n: this.#byKey.size + 1,
        title: result.title,
        url: result.url,
        ...(result.publishedDate && { published: result.publishedDate }),
      };
      this.#byKey.set(key, source);
    }
    return source;
  }

  // Only cited sources are shown: the list under an answer should back up
  // what it says, not list everything that was read.
  cited(text: string): Source[] {
    const numbers = citedNumbers(text);
    return [...this.#byKey.values()].filter((source) => numbers.has(source.n));
  }
}

// OpenAI's open models (gpt-oss, on Groq) cite as 【3】 or 【3†L10-L12】
// whatever the prompt says. This rewrites them to [3] as the text streams,
// holding back only an open 【…】 until it closes, so the user sees exactly
// what is stored and a citation split across chunks is still caught.
export class CitationRewriter {
  #held = '';

  push(chunk: string): string {
    let out = '';
    for (const char of chunk) {
      if (this.#held) {
        this.#held += char;
        if (char === '】') out += this.#rewrite();
        // Not a citation after all (or never closed): let it through as is.
        else if (this.#held.length > 40) out += this.flush();
      } else if (char === '【') {
        this.#held = char;
      } else {
        out += char;
      }
    }
    return out;
  }

  flush(): string {
    const held = this.#held;
    this.#held = '';
    return held;
  }

  #rewrite(): string {
    const inner = this.#held.slice(1, -1);
    this.#held = '';
    const numbers = inner.match(/^\s*(\d+(?:\s*,\s*\d+)*)/)?.[1];
    return numbers ? `[${numbers}]` : `【${inner}】`;
  }
}

// Accepts [3], [1][4] and the occasional [1, 4].
export function citedNumbers(text: string): Set<number> {
  const numbers = new Set<number>();
  for (const [, group] of text.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) {
    for (const n of group!.split(',')) numbers.add(Number(n));
  }
  return numbers;
}

export interface Numbered {
  n: number;
  result: SearchResult;
  // Already shown earlier in this answer's results.
  repeat: boolean;
}

function numbered(sources: SourceList, results: SearchResult[]): Numbered[] {
  return results.map((result) => {
    const before = sources.size;
    const { n } = sources.add(result);
    return { n, result, repeat: sources.size === before };
  });
}

// What is left of the search budget for this answer.
export class SearchBudget {
  #remaining: number;
  constructor(chars: number) {
    this.#remaining = chars;
  }

  // Characters each of `count` results may use, keeping `reserve` for later.
  perResult(count: number, reserve = 0): number {
    return clamp(Math.floor((this.#remaining - reserve) / Math.max(count, 1)), MIN_RESULT_CHARS, MAX_RESULT_CHARS);
  }

  spend(text: string): string {
    this.#remaining = Math.max(0, this.#remaining - text.length);
    return text;
  }
}

// Each result gets at most `maxChars` of text: the provider's snippet first
// (it is query-focused), then the most query-relevant part of the page that fits.
export function formatResults(results: Numbered[], maxChars: number, query: string): string {
  if (results.length === 0) return 'No results.';
  return results
    .map(({ n, result, repeat }) => {
      // The same page often answers several queries; its text is sent once.
      if (repeat) return `[${n}] ${result.title} (same page as above)`;
      const snippet = clip(result.content, Math.ceil(maxChars / 2));
      const excerpt = trimExcerpt(result.excerpt, query, maxChars - snippet.length);
      return [
        `[${n}] ${result.title}`,
        `URL: ${result.url}`,
        result.publishedDate && `Published: ${result.publishedDate}`,
        snippet && `Snippet: ${snippet}`,
        excerpt && `Page excerpt: ${excerpt}`,
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');
}

// Excerpts are already the page's most relevant passages, in page order and
// joined by "…". Cutting one to fit keeps the passages that best match this
// query rather than whichever come first on the page.
function trimExcerpt(excerpt: string, query: string, max: number): string {
  if (max <= 1) return '';
  if (excerpt.length <= max) return excerpt;
  return relevantExcerpt(excerpt.replaceAll('\n…\n', '\n\n'), query, max) || clip(excerpt, max);
}

function clip(text: string, max: number): string {
  if (max <= 1) return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function describeError(error: unknown): string {
  const root = rootError(error);
  if (root instanceof RateLimitedError) {
    const wait = root.retryAfterSeconds && root.retryAfterSeconds > 5 ? `${root.retryAfterSeconds} seconds` : 'a few seconds';
    return `I'm being rate-limited right now. Please try again in ${wait}.`;
  }
  if (APICallError.isInstance(root)) {
    const groqCall = /groq\.com/.test(root.url);
    // Google reports a bad key as 400 "API key not valid", not as 401.
    if (root.statusCode === 401 || root.statusCode === 403 || /API key not valid|invalid api key/i.test(root.responseBody ?? root.message)) {
      return groqCall
        ? 'The Groq API key was rejected. Check GROQ_API_KEY in .env.'
        : 'The Gemini API key was rejected. Check GOOGLE_GENERATIVE_AI_API_KEY in .env.';
    }
    if (root.statusCode === 429) return "I'm being rate-limited right now. Please try again in a few seconds.";
    if ((root.statusCode ?? 0) >= 500) return 'The model is busy right now. Please try again in a moment.';
  }
  return 'Something went wrong while answering. Please try again.';
}
