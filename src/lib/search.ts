import { z } from 'zod';
import { TOKEN_BUDGET, tokensToChars } from './budget.ts';

export interface SearchRequest {
  query: string;
  maxResults?: number;
  // YYYY-MM-DD. Tavily filters by publish date, so undated pages (most pricing
  // pages) drop out; callers retry without it when nothing comes back.
  startDate?: string;
  signal?: AbortSignal;
}

export interface SearchResult {
  title: string;
  url: string;
  // The provider's query-relevant snippet.
  content: string;
  // The most query-relevant passages of the full page, trimmed.
  excerpt: string;
  publishedDate?: string;
}

// The seam between the agent and whichever search API sits behind it.
export interface SearchProvider {
  search(request: SearchRequest): Promise<SearchResult[]>;
}

export interface SearchCache {
  getCachedSearch(key: string, maxAgeMs: number): SearchResult[] | undefined;
  putCachedSearch(key: string, results: SearchResult[], maxAgeMs: number): void;
}

// Prices and changelogs don't move by the minute, and the same query often
// comes back within a session ("and what about Neon?"). Six hours trades a
// little freshness for skipping a network round trip and a search credit.
const SEARCH_CACHE_MS = 6 * 60 * 60 * 1000;

export function withCache(provider: SearchProvider, cache: SearchCache, maxAgeMs = SEARCH_CACHE_MS): SearchProvider {
  return {
    async search(request) {
      const key = JSON.stringify([
        request.query.trim().toLowerCase().replace(/\s+/g, ' '),
        request.maxResults ?? null,
        request.startDate ?? null,
      ]);
      const cached = cache.getCachedSearch(key, maxAgeMs);
      if (cached) return cached;
      // Failures throw before this point, so errors are never cached.
      const results = await provider.search(request);
      cache.putCachedSearch(key, results, maxAgeMs);
      return results;
    },
  };
}

export class SearchError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'SearchError';
    this.status = status;
  }
}

const TAVILY_URL = 'https://api.tavily.com/search';
const TIMEOUT_MS = 10_000;
// The most relevant ~600 tokens of each page; the answer trims further when
// many results share its budget.
const EXCERPT_CHARS = tokensToChars(TOKEN_BUDGET.searchResult);

// Only the fields we use; anything else Tavily adds is ignored.
const TavilyResponse = z.object({
  results: z.array(
    z.object({
      title: z.string().default(''),
      url: z.string(),
      content: z.string().default(''),
      raw_content: z.string().nullish(),
      published_date: z.string().nullish(),
    }),
  ),
});

export function createTavily(apiKey: string, fetchImpl: typeof fetch = fetch): SearchProvider {
  return {
    async search({ query, maxResults = 5, startDate, signal }) {
      const timeout = AbortSignal.timeout(TIMEOUT_MS);
      const response = await fetchImpl(TAVILY_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
          max_results: maxResults,
          search_depth: 'basic',
          // Markdown keeps pricing tables intact; we cut it down ourselves below.
          include_raw_content: 'markdown',
          include_published_date: true,
          ...(startDate && { start_date: startDate }),
        }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok) {
        throw new SearchError(`Tavily responded ${response.status}: ${await response.text()}`, response.status);
      }

      const { results } = TavilyResponse.parse(await response.json());
      const seen = new Set<string>();
      const unique: SearchResult[] = [];
      for (const result of results) {
        const key = normalizeUrl(result.url);
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push({
          title: result.title.trim() || result.url,
          url: result.url,
          content: collapse(result.content),
          excerpt: relevantExcerpt(result.raw_content ?? '', query, EXCERPT_CHARS),
          ...(result.published_date && { publishedDate: result.published_date }),
        });
      }
      return unique;
    },
  };
}

// The same page often comes back as http/https, with or without "www.", a
// trailing slash, or tracking parameters. Those are one source, not several.
export function normalizeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|ref$)/i.test(key)) url.searchParams.delete(key);
    }
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const path = url.pathname.replace(/\/+$/, '');
    return `${host}${path}${url.search}`;
  } catch {
    return raw.trim();
  }
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// Full pages are mostly navigation and boilerplate, and the start of a page is
// rarely the part that answers the question. Keep the paragraphs that mention
// the most query terms (prices count extra), in page order, within budget.
export function relevantExcerpt(raw: string, query: string, maxChars: number): string {
  const paragraphs = raw
    .split(/\n\s*\n/)
    .map(collapse)
    .filter((p) => p.length >= 30);
  if (paragraphs.length === 0) return '';

  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])];
  const scored = paragraphs.map((text, index) => {
    const lower = text.toLowerCase();
    const hits = terms.filter((term) => lower.includes(term)).length;
    const hasPrice = /[$€£₹]\s?\d/.test(text) ? 1 : 0;
    return { text: truncate(text, maxChars / 2), index, score: hits + hasPrice };
  });

  const ranked = scored.filter((p) => p.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
  if (ranked.length === 0) return truncate(paragraphs.join(' '), maxChars);

  const picked: typeof scored = [];
  let used = 0;
  for (const paragraph of ranked) {
    if (used + paragraph.text.length > maxChars) continue;
    picked.push(paragraph);
    used += paragraph.text.length;
  }
  return picked
    .sort((a, b) => a.index - b.index)
    .map((p) => p.text)
    .join('\n…\n');
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut}…`;
}
