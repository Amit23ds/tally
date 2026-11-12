import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { structuredModel } from '../test/models.ts';
import { FALLBACK_PLAN, makePlan, normalizePlan, smallTalkPlan } from './plan.ts';
import { resolveDates } from './time.ts';

const IST = 'Asia/Kolkata';
const dates = resolveDates('Has anything changed since Monday?', IST, new Date('2026-11-11T06:30:00Z')); // Monday = 2026-11-09

const raw = {
  intent: 'lookup' as const,
  needs_search: true,
  entities: [' Neon ', 'neon', 'Supabase'],
  since: '',
  queries: ['Neon pricing', 'neon pricing', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8'],
};

describe('normalizePlan()', () => {
  it('trims and de-duplicates, and caps queries at 6', () => {
    const plan = normalizePlan(raw, dates);
    assert.deepEqual(plan.entities, ['Neon', 'Supabase']);
    assert.deepEqual(plan.queries, ['Neon pricing', 'q3', 'q4', 'q5', 'q6', 'q7']);
  });

  it('never searches for chat, whatever the model said', () => {
    const plan = normalizePlan({ ...raw, intent: 'chat' }, dates);
    assert.equal(plan.needs_search, false);
    assert.deepEqual(plan.queries, []);
  });

  it('drops queries when no search is needed', () => {
    assert.deepEqual(normalizePlan({ ...raw, intent: 'memory', needs_search: false }, dates).queries, []);
  });

  it('keeps "since" only when it is one of the dates resolved from the message', () => {
    assert.equal(normalizePlan({ ...raw, since: '2026-11-09' }, dates).since, '2026-11-09');
    // A date the model worked out itself is not trusted.
    assert.equal(normalizePlan({ ...raw, since: '2026-11-02' }, dates).since, undefined);
    assert.equal(normalizePlan({ ...raw, since: '2026-11-09' }, []).since, undefined);
  });
});

describe('makePlan()', () => {
  // The planner reads today's date from the clock; pin it to match `dates`.
  const original = process.env.NOW;
  before(() => {
    process.env.NOW = '2026-11-11T06:30:00Z';
  });
  after(() => {
    if (original === undefined) delete process.env.NOW;
    else process.env.NOW = original;
  });

  const options = { message: 'Has anything changed since Monday?', recent: [], dates, timeZone: IST, signal: new AbortController().signal };

  it('returns the validated plan from the fast model', async () => {
    const plan = await makePlan({ ...options, model: structuredModel({ ...raw, since: '2026-11-09', queries: ['Neon changelog November 2026'] }) });
    assert.equal(plan.intent, 'lookup');
    assert.equal(plan.since, '2026-11-09');
    assert.deepEqual(plan.queries, ['Neon changelog November 2026']);
  });

  it('gives the planner the resolved dates and today, with low thinking', async () => {
    const model = structuredModel(raw);
    await makePlan({ ...options, model });
    const call = model.doGenerateCalls[0]!;
    const prompt = JSON.stringify(call.prompt);
    // JSON-escaped quotes: the prompt line is '"since Monday" = 2026-11-09 (...)'.
    assert.match(prompt, /since Monday\\" = 2026-11-09 \(since Monday 9 November 2026\)/);
    assert.match(prompt, /Today: Wednesday 11 November 2026 \(2026-11-11\), timezone Asia\/Kolkata/);
    assert.deepEqual(call.providerOptions?.google?.thinkingConfig, { thinkingLevel: 'low' });
    assert.equal(call.responseFormat?.type, 'json');
  });

  it('falls back instead of failing when the planner errors', async () => {
    const original = console.warn;
    console.warn = () => {};
    try {
      assert.deepEqual(await makePlan({ ...options, model: structuredModel(new Error('overloaded')) }), FALLBACK_PLAN);
      assert.deepEqual(await makePlan({ ...options, model: structuredModel({ intent: 'nonsense' }) }), FALLBACK_PLAN);
    } finally {
      console.warn = original;
    }
  });

  it('does not fall back when the user cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(makePlan({ ...options, signal: controller.signal, model: structuredModel(new Error('aborted')) }));
  });
});

describe('smallTalkPlan()', () => {
  it('recognises obvious small talk', () => {
    for (const text of ['hi', 'Thanks!', 'thanks so much', 'ok cool', 'Good morning']) {
      assert.equal(smallTalkPlan(text)?.intent, 'chat', text);
    }
  });

  it('leaves anything that might need a search to the planner', () => {
    for (const text of ['thanks, what about Neon?', 'hi, what does Neon cost', 'ok compare HubSpot and Close', 'thanks for the 3 links', 'Neon?', 'thanks what about Neon']) {
      assert.equal(smallTalkPlan(text), undefined, text);
    }
  });
});
