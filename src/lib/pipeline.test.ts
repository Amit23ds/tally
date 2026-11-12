import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { MockLanguageModelV4 } from 'ai/test';
import { seedHistory } from '../test/fixtures.ts';
import { structuredModel, textStep } from '../test/models.ts';
import type { Db } from './db.ts';
import type { StreamEvent } from './events.ts';
import { respond } from './pipeline.ts';
import type { SearchProvider } from './search.ts';

const IST = 'Asia/Kolkata';

// Records every query and how many ran at the same time.
function trackingSearch(delayMs = 15, { emptyWhenDated = false } = {}) {
  const queries: string[] = [];
  const startDates: Array<string | undefined> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const provider: SearchProvider = {
    async search({ query, startDate }) {
      queries.push(query);
      startDates.push(startDate);
      if (emptyWhenDated && startDate) return [];
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      inFlight--;
      return [{ title: `Result for ${query}`, url: `https://example.com/${encodeURIComponent(query)}`, content: query, excerpt: '' }];
    },
  };
  return { provider, queries, startDates, maxInFlight: () => maxInFlight };
}

async function run(message: string, plan: object | Error, options: { search?: SearchProvider; db?: (db: Db) => Db; during?: () => Promise<void> } = {}) {
  const history = seedHistory(message);
  const smart = new MockLanguageModelV4({ doStream: [textStep('Answer [1].')] });
  const search = options.search ?? trackingSearch().provider;
  const events: StreamEvent[] = [];
  const result = await respond({
    db: options.db ? options.db(history.db) : history.db,
    search,
    conversationId: history.currentConversation,
    userMessageId: history.currentMessageId,
    message,
    timeZone: IST,
    emit: async (event) => {
      events.push(event);
    },
    signal: new AbortController().signal,
    models: { fast: structuredModel(plan, options.during), smart },
  });
  return { result, events, smart, prompt: JSON.stringify(smart.doStreamCalls[0]?.prompt) };
}

const lookup = { intent: 'lookup', needs_search: true, entities: ['Neon'], since: '', queries: ['Neon pricing', 'Supabase pricing', 'Render pricing'] };

describe('respond()', () => {
  // Dates in messages resolve against the clock; pin it to the fixture's "now".
  const original = process.env.NOW;
  before(() => {
    process.env.NOW = '2026-11-11T06:30:00Z';
  });
  after(() => {
    if (original === undefined) delete process.env.NOW;
    else process.env.NOW = original;
  });

  it('recalls while the planner request is in flight', async () => {
    const log: string[] = [];
    const spy = (db: Db): Db => ({
      ...db,
      searchMessages: (...args) => (log.push('recall'), db.searchMessages(...args)),
      messagesBetween: (...args) => (log.push('recall'), db.messagesBetween(...args)),
    });
    const during = async () => {
      log.push('plan request sent');
      await new Promise((resolve) => setTimeout(resolve, 10));
      log.push('plan received');
    };
    await run('Last Tuesday I asked you about Postgres hosting', lookup, { db: spy, during });
    assert.equal(log[0], 'plan request sent');
    assert.ok(log.indexOf('recall') < log.indexOf('plan received'), log.join(' > '));
  });

  it('runs all planned queries in parallel before the answer starts', async () => {
    const search = trackingSearch();
    const { events, prompt } = await run('Compare Neon, Supabase and Render pricing', lookup, { search: search.provider });
    assert.deepEqual(search.queries, ['Neon pricing', 'Supabase pricing', 'Render pricing']);
    assert.equal(search.maxInFlight(), 3);
    const statusAt = events.findIndex((e) => e.type === 'status' && e.text === 'Searching: Neon pricing · Supabase pricing · Render pricing');
    const firstToken = events.findIndex((e) => e.type === 'token');
    assert.ok(statusAt >= 0 && statusAt < firstToken);
    for (const query of search.queries) assert.match(prompt, new RegExp(`## Query: ${query}`));
  });

  it('skips search entirely for small talk', async () => {
    const search = trackingSearch();
    const { smart, events } = await run('thanks, that was helpful', { ...lookup, intent: 'chat' }, { search: search.provider });
    assert.deepEqual(search.queries, []);
    assert.equal(smart.doStreamCalls[0]?.toolChoice?.type, 'none');
    assert.equal(events.some((e) => e.type === 'status'), false);
  });

  it('re-checks each old claim against pages published since the old answer', async () => {
    const search = trackingSearch();
    const plan = { intent: 'memory_then_verify', needs_search: true, entities: [], since: '', queries: ['Postgres hosting prices November 2026'] };
    const { prompt } = await run('What did I ask you on 3 November? Is your answer still correct today?', plan, { search: search.provider });
    // Claim checks first, dated; the planner's own query fills the room left.
    assert.deepEqual(search.queries, ['Neon Launch plan price', 'Supabase Pro plan price', 'Postgres hosting prices November 2026']);
    assert.deepEqual(search.startDates, ['2026-11-03', '2026-11-03', undefined]);
    assert.match(prompt, /## Query: Neon Launch plan price \(only pages published since 2026-11-03\)/);
    assert.match(prompt, /## Tuesday 3 November 2026, 14:30 · \\"Postgres hosting\\"/);
    assert.match(prompt, /Neon · Launch plan price: \$19 per month/);
    assert.match(prompt, /# Re-checking your earlier answer/);
    assert.match(prompt, /one-line verdict/);
  });

  it('retries a dated claim check without the date when it finds nothing', async () => {
    const search = trackingSearch(1, { emptyWhenDated: true });
    const plan = { intent: 'memory_then_verify', needs_search: true, entities: [], since: '', queries: [] };
    const { prompt } = await run('What did I ask you on 3 November? Still correct?', plan, { search: search.provider });
    assert.deepEqual(search.startDates, ['2026-11-03', '2026-11-03', undefined, undefined]);
    assert.match(prompt, /## Query: Neon Launch plan price\\n/);
    assert.doesNotMatch(prompt, /## Query: [^\\]*\(only pages published since/);
  });

  it('does not switch to verification when there is nothing to verify', async () => {
    const plan = { intent: 'memory_then_verify', needs_search: true, entities: [], since: '', queries: ['Neon pricing'] };
    const { prompt } = await run('Is what you told me on 5 November still right?', plan);
    assert.doesNotMatch(prompt, /# Re-checking your earlier answer/);
    assert.match(prompt, /NO RECORD for Thursday 5 November 2026/);
  });

  it('tells the model plainly when a named date has no record', async () => {
    const plan = { intent: 'memory', needs_search: false, entities: [], since: '', queries: [] };
    const { prompt } = await run('What did I ask you on 5 November?', plan);
    assert.match(prompt, /NO RECORD for Thursday 5 November 2026/);
  });

  it('passes the "since" date chosen from the message to the answer', async () => {
    const plan = { ...lookup, since: '2026-11-09' };
    const { prompt, result } = await run('Has Neon shipped anything since Monday?', plan);
    assert.match(prompt, /what changed since Monday 9 November 2026/);
    assert.equal(result.plan.since, '2026-11-09');
  });

  it('answers obvious small talk without a planner round trip', async () => {
    const planner = structuredModel(new Error('the planner should not be called'));
    const history = seedHistory('thanks!');
    const smart = new MockLanguageModelV4({ doStream: [textStep("You're welcome!")] });
    const result = await respond({
      db: history.db,
      search: trackingSearch().provider,
      conversationId: history.currentConversation,
      userMessageId: history.currentMessageId,
      message: 'thanks!',
      timeZone: IST,
      emit: async () => {},
      signal: new AbortController().signal,
      models: { fast: planner, smart },
    });
    assert.equal(planner.doGenerateCalls.length, 0);
    assert.equal(result.plan.intent, 'chat');
    assert.equal(result.timings.plan, 0);
  });

  it('still answers when planning fails', async () => {
    const original = console.warn;
    console.warn = () => {};
    try {
      const search = trackingSearch();
      const { result, smart } = await run('What does Neon cost?', new Error('planner down'), { search: search.provider });
      assert.equal(result.text, 'Answer [1].');
      assert.deepEqual(search.queries, []);
      // No pre-search, but the answer model may still search for itself.
      assert.equal(smart.doStreamCalls[0]?.toolChoice?.type, 'auto');
    } finally {
      console.warn = original;
    }
  });

  it('reports timings for every stage', async () => {
    const { result } = await run('What does Neon cost?', lookup);
    const { plan, recall, search, firstToken, total } = result.timings;
    for (const ms of [plan, recall, search, firstToken!, total]) assert.ok(Number.isFinite(ms) && ms >= 0);
    assert.ok(total >= firstToken!);
  });
});
