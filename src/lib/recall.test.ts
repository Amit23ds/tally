import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { seedHistory } from '../test/fixtures.ts';
import { estimateTokens } from './budget.ts';
import { claimChecks, formatRecord, keywords, mergeRecalled, recall } from './recall.ts';
import { resolveDates } from './time.ts';

const IST = 'Asia/Kolkata';
const WEDNESDAY_11_NOV = new Date('2026-11-11T06:30:00Z');

function recallFor(message: string, terms: string[] = []) {
  const { db, currentMessageId } = seedHistory(message);
  const dates = resolveDates(message, IST, WEDNESDAY_11_NOV);
  return recall({ db, terms, dates, beforeMessageId: currentMessageId, todayIso: '2026-11-11' });
}

describe('recall()', () => {
  it('finds the exchange on a named date, with the claims made in it', () => {
    const recalled = recallFor('What did I ask you on 3 November?');
    assert.equal(recalled.turns.length, 1);
    assert.equal(recalled.turns[0]!.via, 'date');
    assert.equal(recalled.turns[0]!.question.content, 'Which Postgres hosting is cheapest for a side project?');
    assert.deepEqual(recalled.turns[0]!.claims.map((c) => c.entity), ['Neon', 'Supabase']);
    assert.deepEqual(recalled.missing, []);
  });

  it('reports a named date with no conversations as missing', () => {
    const recalled = recallFor('What did I ask you on 5 November?');
    assert.deepEqual(recalled.turns, []);
    assert.deepEqual(recalled.missing.map((m) => m.label), ['Thursday 5 November 2026']);
  });

  it('counts an ambiguous date as recorded if either reading has something', () => {
    // On Wed 11 Nov, "last Tuesday" is the 10th (nothing) or the 3rd (Postgres).
    const recalled = recallFor('Last Tuesday I asked you about Postgres hosting');
    assert.deepEqual(recalled.missing, []);
    assert.equal(recalled.turns[0]?.question.conversation_title, 'Postgres hosting');
  });

  it('searches all conversations by topic, not just the current one', () => {
    const recalled = recallFor('Has Neon changed its pricing?', ['neon']);
    assert.deepEqual(recalled.turns.map((t) => [t.via, t.question.conversation_title]), [['match', 'Postgres hosting']]);
  });

  it('never recalls the message being answered, and has no "no record" for today', () => {
    const recalled = recallFor('What have I asked you today?');
    assert.deepEqual(recalled.turns, []);
    assert.deepEqual(recalled.missing, []);
  });

  it('merges passes without duplicates, dated turns first', () => {
    const byDate = recallFor('on 3 November');
    const byTopic = recallFor('crm and postgres', ['crm', 'postgres']);
    const merged = mergeRecalled(byDate, byTopic);
    assert.deepEqual(merged.turns.map((t) => [t.via, t.question.conversation_title]), [
      ['date', 'Postgres hosting'],
      ['match', 'CRM shortlist'],
    ]);
  });
});

describe('formatRecord()', () => {
  it('keeps the record within ~1,500 tokens, dated turns first, and says what it left out', () => {
    const at = (day: number) => `2026-11-0${day}T09:00:00Z`;
    const hit = (id: number, role: 'user' | 'assistant', content: string, day: number) => ({
      id,
      conversation_id: 'c',
      conversation_title: `Chat ${id}`,
      role,
      content,
      created_at: at(day),
    });
    const turn = (n: number, via: 'date' | 'match') => ({
      via,
      question: hit(n * 2, 'user', `Question ${n} ${'detail '.repeat(60)}`, (n % 9) + 1),
      answer: hit(n * 2 + 1, 'assistant', 'A long answer. '.repeat(100), (n % 9) + 1),
      claims: Array.from({ length: 6 }, (_, c) => ({
        id: c,
        message_id: n * 2 + 1,
        created_at: at(1),
        entity: `Vendor ${c}`,
        attribute: 'price',
        value: `$${c}9 per month`,
        source_url: `https://vendor${c}.com/pricing`,
        as_of: '2026-11-01',
      })),
    });
    const turns = [turn(1, 'date'), ...[2, 3, 4, 5, 6, 7, 8].map((n) => turn(n, 'match'))];
    const record = formatRecord({ turns, missing: [] }, { timeZone: IST, intent: 'memory' })!;
    assert.ok(estimateTokens(record) <= 1_500, `record is ${estimateTokens(record)} tokens`);
    assert.match(record, /User: Question 1 /);
    assert.match(record, /more matching exchanges were left out for length/);
  });

  it('lists turns with local times and claims, without stale citation numbers', () => {
    const record = formatRecord(recallFor('What did I ask you on 3 November?'), { timeZone: IST, intent: 'memory' })!;
    assert.match(record, /^# Your record of past conversations/);
    assert.match(record, /## Tuesday 3 November 2026, 14:30 · "Postgres hosting"/);
    assert.match(record, /User: Which Postgres hosting is cheapest/);
    assert.match(record, /You: Neon Launch costs \$19 per month\. Supabase Pro is \$25 per month\./);
    assert.match(record, /- Neon · Launch plan price: \$19 per month \(as of 2026-11-03; source: https:\/\/neon\.com\/pricing\)/);
  });

  it('says NO RECORD for a named date with nothing on it', () => {
    const record = formatRecord(recallFor('What did I ask you on 5 November?'), { timeZone: IST, intent: 'memory' })!;
    assert.match(record, /NO RECORD for Thursday 5 November 2026/);
  });

  it('says NO RECORD when a memory question matches nothing at all', () => {
    const record = formatRecord(recallFor('What did we say about Kubernetes?', ['kubernetes']), { timeZone: IST, intent: 'memory' })!;
    assert.match(record, /NO RECORD of any earlier conversation matching this message/);
  });

  it('adds nothing for a lookup with no history', () => {
    assert.equal(formatRecord(recallFor('What does Fly.io cost?', ['fly']), { timeZone: IST, intent: 'lookup' }), undefined);
  });

  it('leaves topic matches out of small talk', () => {
    assert.equal(formatRecord(recallFor('thanks, neon sounds good', ['neon']), { timeZone: IST, intent: 'chat' }), undefined);
  });
});

describe('keywords()', () => {
  it('keeps topic words and drops filler and date words', () => {
    assert.deepEqual(keywords('What did I ask you on 3 November about Postgres hosting? Is it still correct?'), ['postgres', 'hosting']);
  });

  it('splits like the FTS tokenizer, so "Fly.io" becomes "fly" and "io" (too short to keep)', () => {
    assert.deepEqual(keywords('Is Fly.io cheaper than Render?'), ['fly', 'cheaper', 'render']);
  });
});

describe('claimChecks()', () => {
  it('turns recalled claims into searches limited to pages newer than the old answer', () => {
    assert.deepEqual(claimChecks(recallFor('on 3 November'), IST, 6), [
      { query: 'Neon Launch plan price', startDate: '2026-11-03' },
      { query: 'Supabase Pro plan price', startDate: '2026-11-03' },
    ]);
  });

  it('respects the limit', () => {
    assert.equal(claimChecks(recallFor('on 3 November'), IST, 1).length, 1);
  });
});
