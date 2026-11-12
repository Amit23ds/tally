import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { structuredModel } from '../test/models.ts';
import { openDb } from './db.ts';
import type { Source } from './events.ts';
import { extractClaims, normalizeClaims, rememberClaims } from './extract.ts';

const sources: Source[] = [
  { n: 1, title: 'Neon pricing', url: 'https://neon.com/pricing' },
  { n: 3, title: 'Supabase blog: new Pro plan', url: 'https://supabase.com/blog/pro', published: 'Mon, 02 Nov 2026 10:00:00 GMT' },
];

const options = {
  question: 'Which Postgres hosting is cheapest?',
  answer: 'Neon Launch is $19 per month [1]. Supabase Pro is now $20 per month [3].',
  sources,
  answeredOn: '2026-11-03',
};

describe('normalizeClaims()', () => {
  it('links each claim to its cited source and dates it', () => {
    const claims = normalizeClaims(
      [
        { entity: 'Neon', attribute: 'Launch plan price', value: '$19 per month', source: 1 },
        { entity: 'Supabase', attribute: 'Pro plan price', value: '$20 per month', source: 3 },
      ],
      sources,
      '2026-11-03',
    );
    assert.deepEqual(claims, [
      // An undated pricing page: true as of the day it was read.
      { entity: 'Neon', attribute: 'Launch plan price', value: '$19 per month', source_url: 'https://neon.com/pricing', as_of: '2026-11-03' },
      // A dated article: true as of its publish date.
      { entity: 'Supabase', attribute: 'Pro plan price', value: '$20 per month', source_url: 'https://supabase.com/blog/pro', as_of: '2026-11-02' },
    ]);
  });

  it('never invents a source: unknown citation numbers become null', () => {
    const [claim] = normalizeClaims([{ entity: 'Render', attribute: 'price', value: '$7', source: 9 }], sources, '2026-11-03');
    assert.equal(claim?.source_url, null);
  });

  it('drops empty and duplicate claims', () => {
    const claims = normalizeClaims(
      [
        { entity: 'Neon', attribute: 'Launch plan price', value: '$19', source: 1 },
        { entity: ' neon ', attribute: 'launch plan price', value: '$20', source: 1 },
        { entity: '', attribute: 'x', value: 'y', source: 0 },
      ],
      sources,
      '2026-11-03',
    );
    assert.deepEqual(claims.map((c) => c.value), ['$19']);
  });

  it('ignores publish dates it cannot parse', () => {
    const odd: Source[] = [{ n: 1, title: 't', url: 'https://t.com', published: 'last week' }];
    assert.equal(normalizeClaims([{ entity: 'T', attribute: 'a', value: 'v', source: 1 }], odd, '2026-11-03')[0]?.as_of, '2026-11-03');
  });
});

describe('extractClaims()', () => {
  it('sends the question, answer and numbered sources, with low thinking', async () => {
    const model = structuredModel({ claims: [{ entity: 'Neon', attribute: 'Launch plan price', value: '$19 per month', source: 1 }] });
    const claims = await extractClaims({ ...options, model });
    assert.equal(claims[0]?.source_url, 'https://neon.com/pricing');
    const call = model.doGenerateCalls[0]!;
    const prompt = JSON.stringify(call.prompt);
    assert.match(prompt, /Which Postgres hosting is cheapest/);
    assert.match(prompt, /\[3\] Supabase blog: new Pro plan \(https:\/\/supabase.com\/blog\/pro, published Mon, 02 Nov 2026/);
    assert.deepEqual(call.providerOptions?.google?.thinkingConfig, { thinkingLevel: 'low' });
  });
});

describe('rememberClaims()', () => {
  function answered() {
    const db = openDb(':memory:');
    const id = randomUUID();
    db.ensureConversation(id, 'q');
    db.addMessage(id, 'user', options.question);
    return { db, messageId: db.addMessage(id, 'assistant', options.answer, sources) };
  }

  it('stores the claims against the answer', async () => {
    const { db, messageId } = answered();
    const model = structuredModel({ claims: [{ entity: 'Neon', attribute: 'Launch plan price', value: '$19 per month', source: 1 }] });
    assert.equal(await rememberClaims(db, messageId, { ...options, model }), 1);
    assert.deepEqual(db.claimsForMessages([messageId]).map((c) => [c.entity, c.value, c.as_of]), [['Neon', '$19 per month', '2026-11-03']]);
  });

  it('skips answers without sources, without calling the model', async () => {
    const { db, messageId } = answered();
    const model = structuredModel({ claims: [] });
    assert.equal(await rememberClaims(db, messageId, { ...options, sources: [], model }), 0);
    assert.equal(model.doGenerateCalls.length, 0);
  });
});
