import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openDb } from './db.ts';
import { SearchError, createTavily, normalizeUrl, relevantExcerpt, withCache } from './search.ts';

function fakeFetch(status: number, body: unknown, calls: RequestInit[] = []): typeof fetch {
  return async (_url, init) => {
    calls.push(init ?? {});
    return new Response(JSON.stringify(body), { status });
  };
}

describe('createTavily()', () => {
  it('sends the query options Tavily expects', async () => {
    const calls: RequestInit[] = [];
    const tavily = createTavily('tvly-test', fakeFetch(200, { results: [] }, calls));
    await tavily.search({ query: 'neon pricing', maxResults: 3, startDate: '2026-11-09' });

    const body = JSON.parse(String(calls[0]?.body));
    assert.equal(body.query, 'neon pricing');
    assert.equal(body.max_results, 3);
    assert.equal(body.start_date, '2026-11-09');
    assert.equal(body.include_raw_content, 'markdown');
    assert.equal((calls[0]?.headers as Record<string, string>).Authorization, 'Bearer tvly-test');
  });

  it('omits start_date when none is given', async () => {
    const calls: RequestInit[] = [];
    await createTavily('k', fakeFetch(200, { results: [] }, calls)).search({ query: 'x' });
    assert.equal('start_date' in JSON.parse(String(calls[0]?.body)), false);
  });

  it('drops duplicate URLs, keeping the first (highest ranked)', async () => {
    const tavily = createTavily(
      'k',
      fakeFetch(200, {
        results: [
          { title: 'Pricing', url: 'https://neon.com/pricing', content: 'first', published_date: '2026-11-02' },
          { title: 'Pricing again', url: 'http://www.neon.com/pricing/?utm_source=x', content: 'dup' },
          { title: 'Docs', url: 'https://neon.com/docs', content: 'other', raw_content: null },
        ],
      }),
    );
    const results = await tavily.search({ query: 'neon' });
    assert.deepEqual(
      results.map((r) => [r.title, r.publishedDate]),
      [
        ['Pricing', '2026-11-02'],
        ['Docs', undefined],
      ],
    );
  });

  it('throws a SearchError carrying the HTTP status', async () => {
    const tavily = createTavily('bad', fakeFetch(401, { detail: { error: 'Unauthorized' } }));
    await assert.rejects(tavily.search({ query: 'x' }), (error: unknown) => error instanceof SearchError && error.status === 401);
  });
});

describe('normalizeUrl()', () => {
  it('treats protocol, www, trailing slash, fragments and tracking params as the same page', () => {
    const key = normalizeUrl('https://neon.com/pricing');
    assert.equal(normalizeUrl('http://www.Neon.com/pricing/#plans'), key);
    assert.equal(normalizeUrl('https://neon.com/pricing?utm_campaign=x&gclid=y'), key);
  });

  it('keeps meaningful query parameters', () => {
    assert.notEqual(normalizeUrl('https://x.com/page?id=1'), normalizeUrl('https://x.com/page?id=2'));
  });
});

describe('relevantExcerpt()', () => {
  const page = [
    'Home | Product | Pricing | Docs | Blog | Careers | Log in | Sign up',
    'We are a serverless Postgres company founded by database people.',
    'Launch plan: $19 per month, includes 10 GB of storage and autoscaling.',
    'Footer: © 2026 Neon, Inc. All rights reserved. Privacy policy and terms.',
  ].join('\n\n');

  it('prefers paragraphs that match the query and mention prices', () => {
    const excerpt = relevantExcerpt(page, 'neon launch plan price', 120);
    assert.match(excerpt, /\$19 per month/);
    assert.doesNotMatch(excerpt, /Careers/);
  });

  it('stays within the character budget', () => {
    assert.ok(relevantExcerpt(page.repeat(20), 'plan storage postgres', 300).length <= 300);
  });

  it('returns an empty string for an empty page', () => {
    assert.equal(relevantExcerpt('', 'anything', 100), '');
  });
});

describe('withCache()', () => {
  function counting() {
    let calls = 0;
    const provider = {
      async search() {
        calls++;
        return [{ title: 'T', url: 'https://t.com', content: '', excerpt: '' }];
      },
    };
    return { provider, calls: () => calls };
  }

  it('serves a repeated query from the cache, ignoring case and spacing', async () => {
    const { provider, calls } = counting();
    const cached = withCache(provider, openDb(':memory:'));
    await cached.search({ query: 'Neon pricing' });
    await cached.search({ query: '  neon   PRICING ' });
    assert.equal(calls(), 1);
  });

  it('keeps queries with different options apart', async () => {
    const { provider, calls } = counting();
    const cached = withCache(provider, openDb(':memory:'));
    await cached.search({ query: 'neon', startDate: '2026-11-01' });
    await cached.search({ query: 'neon' });
    assert.equal(calls(), 2);
  });

  it('does not cache failures', async () => {
    let attempts = 0;
    const flaky = {
      async search() {
        if (attempts++ === 0) throw new SearchError('down', 503);
        return [];
      },
    };
    const cached = withCache(flaky, openDb(':memory:'));
    await assert.rejects(cached.search({ query: 'x' }));
    assert.deepEqual(await cached.search({ query: 'x' }), []);
  });
});
