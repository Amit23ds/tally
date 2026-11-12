import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { openDb } from './db.ts';

it('creates a conversation on first message and lists the most recent first', () => {
  const db = openDb(':memory:');
  const first = randomUUID();
  const second = randomUUID();
  db.ensureConversation(first, 'Postgres hosting options\nfor a small team');
  db.addMessage(first, 'user', 'Postgres hosting options');
  db.ensureConversation(second, 'CRM tools');
  db.addMessage(second, 'user', 'CRM tools');
  // A second ensure must not rename an existing conversation.
  db.ensureConversation(first, 'something else');

  assert.deepEqual(db.listConversations().map((c) => c.title), ['CRM tools', 'Postgres hosting options']);
  assert.equal(db.getConversation(first)?.messages.length, 1);
  assert.equal(db.getConversation(randomUUID()), undefined);
  db.close();
});

it('upgrades a database created before messages had a sources column', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'tally-')), 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
    INSERT INTO conversations VALUES ('c1', 'Old chat', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z');
    INSERT INTO messages (conversation_id, role, content, created_at) VALUES ('c1', 'user', 'hello', '2026-11-01T00:00:00.000Z');
  `);
  old.close();

  const db = openDb(file);
  assert.deepEqual(db.getConversation('c1')?.messages[0]?.sources, []);
  db.addMessage('c1', 'assistant', 'Answer [1].', [{ n: 1, title: 'A', url: 'https://a.com' }]);
  assert.equal(db.getConversation('c1')?.messages[1]?.sources[0]?.url, 'https://a.com');
  db.close();
});

it('never starts the model history on an assistant turn', () => {
  const db = openDb(':memory:');
  const id = randomUUID();
  db.ensureConversation(id, 'q1');
  db.addMessage(id, 'user', 'q1');
  db.addMessage(id, 'assistant', 'a1');
  db.addMessage(id, 'user', 'q2');
  // A window of two would start on "a1".
  assert.deepEqual(db.recentMessages(id, 2), [{ role: 'user', content: 'q2' }]);
  db.close();
});

// A small history across two conversations on different days, written with a
// pinned clock so created_at is predictable.
function seeded(options: { fts?: boolean } = {}) {
  const db = openDb(':memory:', options);
  const original = process.env.NOW;
  const at = (iso: string, write: () => void) => {
    process.env.NOW = iso;
    write();
  };
  const postgres = randomUUID();
  const crm = randomUUID();
  let answerId = 0;
  at('2026-11-03T09:00:00Z', () => {
    db.ensureConversation(postgres, 'Postgres hosting');
    db.addMessage(postgres, 'user', 'Which Postgres hosting is cheapest for a side project?');
    answerId = db.addMessage(postgres, 'assistant', 'Neon Launch costs $19 per month [1]. Supabase Pro is $25 [2].');
  });
  at('2026-11-09T09:00:00Z', () => {
    db.ensureConversation(crm, 'CRM shortlist');
    db.addMessage(crm, 'user', 'Shortlist CRM tools for a 20-person sales team');
    db.addMessage(crm, 'assistant', 'HubSpot, Pipedrive, Close, Attio and Salesforce.');
  });
  if (original === undefined) delete process.env.NOW;
  else process.env.NOW = original;
  return { db, postgres, crm, answerId };
}

const NOV_3_UTC = { start: '2026-11-03T00:00:00.000Z', end: '2026-11-04T00:00:00.000Z' };

describe('recall queries', () => {
  // FTS5 is missing on some Node builds (22.13), so both paths must agree.
  for (const fts of [true, false]) {
    describe(fts ? 'with FTS5' : 'with the LIKE fallback', () => {
      it('finds messages by term across conversations', () => {
        const { db } = seeded({ fts });
        if (fts && !db.fts) return; // this Node build has no FTS5; the LIKE run covers it
        const hits = db.searchMessages(['pipedrive']);
        assert.deepEqual(hits.map((h) => [h.conversation_title, h.role]), [['CRM shortlist', 'assistant']]);
        db.close();
      });

      it('matches word prefixes and is case-insensitive', () => {
        const { db } = seeded({ fts });
        if (fts && !db.fts) return;
        assert.equal(db.searchMessages(['POSTGRES']).length, 1);
        assert.deepEqual(db.searchMessages(['pipe']).map((h) => h.conversation_title), ['CRM shortlist']);
        db.close();
      });

      it('restricts matches to a time range', () => {
        const { db } = seeded({ fts });
        if (fts && !db.fts) return;
        const terms = ['postgres', 'neon', 'crm'];
        assert.equal(db.searchMessages(terms).length, 3);
        const onNov3 = db.searchMessages(terms, NOV_3_UTC);
        assert.deepEqual(onNov3.map((h) => h.conversation_title), ['Postgres hosting', 'Postgres hosting']);
        db.close();
      });

      it('treats FTS and LIKE syntax in user text as plain text', () => {
        const { db } = seeded({ fts });
        if (fts && !db.fts) return;
        assert.deepEqual(db.searchMessages(['"unbalanced', '100%', 'a_b', 'NEAR(']), []);
        db.close();
      });
    });
  }

  it('lists everything said within a time range, in order', () => {
    const { db } = seeded();
    assert.deepEqual(
      db.messagesBetween(NOV_3_UTC).map((m) => m.role),
      ['user', 'assistant'],
    );
    assert.deepEqual(db.messagesBetween({ start: '2026-11-05T00:00:00.000Z', end: '2026-11-06T00:00:00.000Z' }), []);
    db.close();
  });

  it('indexes messages written while FTS5 was unavailable once it is back', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'tally-')), 'fts.db');
    const first = openDb(file);
    if (!first.fts) return first.close(); // nothing to re-enable on this Node build
    const id = randomUUID();
    first.ensureConversation(id, 'x');
    first.addMessage(id, 'user', 'indexed normally');
    first.close();

    const withoutFts = openDb(file, { fts: false });
    withoutFts.addMessage(id, 'user', 'written without the index');
    withoutFts.close();

    const again = openDb(file);
    assert.equal(again.searchMessages(['without']).length, 1);
    assert.equal(again.searchMessages(['normally']).length, 1);
    again.close();
  });
});

describe('claims', () => {
  it('stores claims against the answer that made them', () => {
    const { db, answerId } = seeded();
    db.addClaims(answerId, [
      { entity: 'Neon', attribute: 'Launch plan price', value: '$19 per month', source_url: 'https://neon.com/pricing', as_of: '2026-11-03' },
      { entity: 'Supabase', attribute: 'Pro plan price', value: '$25 per month', source_url: null, as_of: '2026-11-03' },
    ]);
    assert.deepEqual(
      db.claimsForMessages([answerId]).map((c) => [c.entity, c.value, c.source_url]),
      [
        ['Neon', '$19 per month', 'https://neon.com/pricing'],
        ['Supabase', '$25 per month', null],
      ],
    );
    assert.deepEqual(db.claimsForMessages([]), []);
    db.close();
  });
});

describe('search cache', () => {
  const results = [{ title: 'Neon pricing', url: 'https://neon.com/pricing', content: '', excerpt: '' }];

  it('returns fresh entries and ignores expired ones', () => {
    const db = openDb(':memory:');
    const original = process.env.NOW;
    process.env.NOW = '2026-11-11T09:00:00Z';
    db.putCachedSearch('neon', results, 60_000);
    process.env.NOW = '2026-11-11T09:00:59Z';
    assert.deepEqual(db.getCachedSearch('neon', 60_000), results);
    process.env.NOW = '2026-11-11T09:01:01Z';
    assert.equal(db.getCachedSearch('neon', 60_000), undefined);
    if (original === undefined) delete process.env.NOW;
    else process.env.NOW = original;
    db.close();
  });
});

it('renames a conversation', () => {
  const db = openDb(':memory:');
  const id = randomUUID();
  db.ensureConversation(id, 'Postgres hosting');
  db.renameConversation(id, '[Demo] Postgres hosting');
  assert.equal(db.getConversation(id)?.conversation.title, '[Demo] Postgres hosting');
  db.close();
});
