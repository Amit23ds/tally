import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Source } from './events.ts';
import type { SearchResult } from './search.ts';
import { now } from './time.ts';

export type Role = 'user' | 'assistant';

export interface Conversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: number;
  conversation_id: string;
  role: Role;
  content: string;
  sources: Source[];
  created_at: string;
}

// A past message found by recall, with enough context to quote it back.
export interface MessageHit {
  id: number;
  conversation_id: string;
  conversation_title: string;
  role: Role;
  content: string;
  created_at: string;
}

// A question and the answer it got (absent if the answer never finished).
export interface Turn {
  question: MessageHit;
  answer?: MessageHit;
}

// One checkable statement from an answer, e.g. Neon / Launch plan price / $19 per month.
export interface ClaimInput {
  entity: string;
  attribute: string;
  value: string;
  source_url: string | null;
  // When the value was true according to its source: the page's publish date
  // if known, otherwise when the answer was given.
  as_of: string;
}

export interface Claim extends ClaimInput {
  id: number;
  message_id: number;
  created_at: string;
}

// [start, end) as ISO 8601 UTC instants, as produced by resolveDates().
export interface TimeRange {
  start: string;
  end: string;
}

// Timestamps are ISO 8601 UTC strings. They are fixed-width, so they sort and
// range-compare correctly as text, and stay readable when inspecting the DB.
const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS conversations (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content         TEXT NOT NULL,
    -- JSON array of cited sources, so an answer reloads with its source list.
    sources         TEXT NOT NULL DEFAULT '[]',
    created_at      TEXT NOT NULL
  );

  -- Recall asks "what was said between these dates" across all conversations.
  CREATE INDEX IF NOT EXISTS messages_by_time ON messages(created_at);
  CREATE INDEX IF NOT EXISTS messages_by_conversation ON messages(conversation_id, id);

  -- Claims turn "is that still correct?" into a diff of specific values,
  -- instead of re-reading old transcripts.
  CREATE TABLE IF NOT EXISTS claims (
    id         INTEGER PRIMARY KEY,
    message_id INTEGER NOT NULL REFERENCES messages(id),
    entity     TEXT NOT NULL,
    attribute  TEXT NOT NULL,
    value      TEXT NOT NULL,
    source_url TEXT,
    as_of      TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS claims_by_message ON claims(message_id);

  CREATE TABLE IF NOT EXISTS search_cache (
    key        TEXT PRIMARY KEY,
    results    TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`;

// Columns added after a table first shipped. CREATE TABLE IF NOT EXISTS leaves
// an existing table alone, so databases from earlier versions get them here.
const ADDED_COLUMNS = [{ table: 'messages', column: 'sources', definition: "TEXT NOT NULL DEFAULT '[]'" }];

function addMissingColumns(db: DatabaseSync): void {
  const hasColumn = db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?');
  for (const { table, column, definition } of ADDED_COLUMNS) {
    if (!hasColumn.get(table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// External-content FTS5 index over messages: it stores only the index, not a
// second copy of the text. Messages are append-only, so an insert trigger is
// all it takes to keep it in sync.
const FTS_SCHEMA = `
  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
    USING fts5(content, content='messages', content_rowid='id');

  CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
  END;
`;

// SQLite builds can omit FTS5 (Node 22.13's does). Probing with a throwaway
// temp table tells us at startup, so recall falls back to LIKE instead of
// failing on first use.
function hasFts5(db: DatabaseSync): boolean {
  try {
    db.exec('CREATE VIRTUAL TABLE temp.fts5_probe USING fts5(x); DROP TABLE temp.fts5_probe;');
    return true;
  } catch {
    return false;
  }
}

// The same file can be opened by Node builds with and without FTS5. Without
// it, the insert trigger would fail every insert ("no such module"), so it is
// dropped. When FTS5 is back, the index is rebuilt to cover what was missed.
function setUpFts(db: DatabaseSync, enabled: boolean): boolean {
  const hasTrigger = () => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'messages_fts_insert'").get();
  if (!enabled || !hasFts5(db)) {
    db.exec('DROP TRIGGER IF EXISTS messages_fts_insert');
    return false;
  }
  const wasIndexing = hasTrigger();
  db.exec(FTS_SCHEMA);
  if (!wasIndexing) db.exec("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')");
  return true;
}

function titleFrom(message: string): string {
  const firstLine = message.trim().split('\n')[0] ?? '';
  return firstLine.length > 60 ? `${firstLine.slice(0, 59)}…` : firstLine;
}

// Each term becomes a quoted FTS5 prefix query ("price"* also matches
// "prices"); quoting neutralises FTS syntax characters in user text.
function ftsQuery(terms: string[]): string {
  return terms.map((term) => `"${term.replaceAll('"', '')}"*`).join(' OR ');
}

function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

// An open range when no dates were mentioned. These sort before and after any
// ISO timestamp.
const ALL_TIME: TimeRange = { start: '0000', end: '9999' };

const HIT_COLUMNS = 'm.id, m.conversation_id, c.title AS conversation_title, m.role, m.content, m.created_at';

export function openDb(file: string, options: { fts?: boolean } = {}) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  addMissingColumns(db);
  // `fts: false` forces the LIKE path, so tests cover it on every Node build.
  const fts = setUpFts(db, options.fts ?? true);

  const insertConversation = db.prepare(
    'INSERT OR IGNORE INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)',
  );
  const touchConversation = db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?');
  const updateTitle = db.prepare('UPDATE conversations SET title = ? WHERE id = ?');
  const insertMessage = db.prepare(
    'INSERT INTO messages (conversation_id, role, content, sources, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  // rowid breaks ties when NOW is pinned and every row shares one timestamp.
  const selectConversations = db.prepare(
    'SELECT id, title, created_at, updated_at FROM conversations ORDER BY updated_at DESC, rowid DESC LIMIT 200',
  );
  const selectConversation = db.prepare('SELECT id, title, created_at, updated_at FROM conversations WHERE id = ?');
  const selectMessages = db.prepare(
    'SELECT id, conversation_id, role, content, sources, created_at FROM messages WHERE conversation_id = ? ORDER BY id',
  );
  const selectRecentMessages = db.prepare(
    'SELECT role, content FROM (SELECT id, role, content FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id',
  );
  const selectMessagesBetween = db.prepare(`
    SELECT ${HIT_COLUMNS} FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE m.created_at >= ? AND m.created_at < ?
    ORDER BY m.created_at, m.id LIMIT ?`);
  const selectFtsHits = fts
    ? db.prepare(`
        SELECT ${HIT_COLUMNS} FROM messages_fts f
        JOIN messages m ON m.id = f.rowid
        JOIN conversations c ON c.id = m.conversation_id
        WHERE messages_fts MATCH ? AND m.created_at >= ? AND m.created_at < ?
        ORDER BY bm25(messages_fts) LIMIT ?`)
    : undefined;
  // A turn is a user message plus the first reply before the next question.
  const selectTurnStart = db.prepare(`
    SELECT CASE WHEN m.role = 'user' THEN m.id ELSE (
      SELECT max(u.id) FROM messages u WHERE u.conversation_id = m.conversation_id AND u.role = 'user' AND u.id < m.id
    ) END AS user_id
    FROM messages m WHERE m.id = ?`);
  const selectHit = db.prepare(`SELECT ${HIT_COLUMNS} FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.id = ?`);
  const selectReply = db.prepare(`
    SELECT ${HIT_COLUMNS} FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE m.conversation_id = ? AND m.role = 'assistant' AND m.id > ?
      AND m.id < coalesce((SELECT min(n.id) FROM messages n WHERE n.conversation_id = ? AND n.role = 'user' AND n.id > ?), 9e18)
    ORDER BY m.id LIMIT 1`);
  const insertClaim = db.prepare(
    'INSERT INTO claims (message_id, entity, attribute, value, source_url, as_of, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const selectCachedSearch = db.prepare('SELECT results FROM search_cache WHERE key = ? AND created_at >= ?');
  const upsertCachedSearch = db.prepare('INSERT OR REPLACE INTO search_cache (key, results, created_at) VALUES (?, ?, ?)');
  const deleteStaleSearches = db.prepare('DELETE FROM search_cache WHERE created_at < ?');

  const cutoff = (maxAgeMs: number) => new Date(now().getTime() - maxAgeMs).toISOString();
  // node:sqlite rows have a null prototype; copy them into plain objects so
  // they compare and serialise like any other object.
  const plain = <T>(rows: unknown[]) => rows.map((row) => ({ ...(row as object) }) as T);

  return {
    fts,

    // Besides closing, this closure keeps `db` reachable. On Node 22, a
    // DatabaseSync that gets garbage-collected finalizes its prepared
    // statements, and the statements alone don't keep it alive.
    close(): void {
      db.close();
    },

    // The browser picks the conversation id, so the first message both
    // creates the conversation and names it.
    ensureConversation(id: string, firstMessage: string): void {
      const at = now().toISOString();
      insertConversation.run(id, titleFrom(firstMessage), at, at);
    },

    // Used by the seed script to mark demo conversations as such.
    renameConversation(id: string, title: string): void {
      updateTitle.run(title, id);
    },

    addMessage(conversationId: string, role: Role, content: string, sources: Source[] = []): number {
      const at = now().toISOString();
      const { lastInsertRowid } = insertMessage.run(conversationId, role, content, JSON.stringify(sources), at);
      touchConversation.run(at, conversationId);
      return Number(lastInsertRowid);
    },

    listConversations(): Conversation[] {
      return plain<Conversation>(selectConversations.all());
    },

    getConversation(id: string): { conversation: Conversation; messages: Message[] } | undefined {
      const conversation = selectConversation.get(id) as unknown as Conversation | undefined;
      if (!conversation) return undefined;
      const rows = plain<Omit<Message, 'sources'> & { sources: string }>(selectMessages.all(id));
      return { conversation: { ...conversation }, messages: rows.map((row) => ({ ...row, sources: JSON.parse(row.sources) as Source[] })) };
    },

    // The tail of a conversation, oldest first, as context for the next answer.
    recentMessages(conversationId: string, limit: number): Array<{ role: Role; content: string }> {
      const rows = plain<{ role: Role; content: string }>(selectRecentMessages.all(conversationId, limit));
      // The model API requires the first message to be the user's, and a
      // window cut mid-conversation can start on an assistant turn.
      const firstUser = rows.findIndex((row) => row.role === 'user');
      return firstUser === -1 ? [] : rows.slice(firstUser);
    },

    // Everything said in a time range, across all conversations, in order.
    // This answers "what did I ask you on 3 November?".
    messagesBetween(range: TimeRange, limit = 50): MessageHit[] {
      return plain<MessageHit>(selectMessagesBetween.all(range.start, range.end, limit));
    },

    // FTS5 ranks by relevance; the LIKE fallback can only match, so it
    // returns the most recent matches first.
    searchMessages(terms: string[], range: TimeRange = ALL_TIME, limit = 20): MessageHit[] {
      const usable = terms.map((term) => term.trim()).filter(Boolean);
      if (usable.length === 0) return [];
      if (selectFtsHits) return plain<MessageHit>(selectFtsHits.all(ftsQuery(usable), range.start, range.end, limit));

      const matches = usable.map(() => "m.content LIKE ? ESCAPE '\\'").join(' OR ');
      const statement = db.prepare(`
        SELECT ${HIT_COLUMNS} FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE (${matches}) AND m.created_at >= ? AND m.created_at < ?
        ORDER BY m.created_at DESC, m.id DESC LIMIT ?`);
      return plain<MessageHit>(statement.all(...usable.map(likePattern), range.start, range.end, limit));
    },

    // Expands matched messages (either side of an exchange) into whole turns,
    // de-duplicated, in the order the matches were given.
    turns(messageIds: number[]): Turn[] {
      const seen = new Set<number>();
      const turns: Turn[] = [];
      for (const id of messageIds) {
        const userId = (selectTurnStart.get(id) as { user_id: number | null } | undefined)?.user_id;
        if (userId == null || seen.has(userId)) continue;
        seen.add(userId);
        const question = { ...(selectHit.get(userId) as unknown as MessageHit) };
        const reply = selectReply.get(question.conversation_id, userId, question.conversation_id, userId);
        turns.push({ question, ...(reply && { answer: { ...(reply as unknown as MessageHit) } }) });
      }
      return turns;
    },

    addClaims(messageId: number, claims: ClaimInput[]): void {
      const at = now().toISOString();
      for (const claim of claims) {
        insertClaim.run(messageId, claim.entity, claim.attribute, claim.value, claim.source_url, claim.as_of, at);
      }
    },

    claimsForMessages(messageIds: number[]): Claim[] {
      if (messageIds.length === 0) return [];
      const placeholders = messageIds.map(() => '?').join(', ');
      const statement = db.prepare(`SELECT * FROM claims WHERE message_id IN (${placeholders}) ORDER BY message_id, id`);
      return plain<Claim>(statement.all(...messageIds));
    },

    getCachedSearch(key: string, maxAgeMs: number): SearchResult[] | undefined {
      const row = selectCachedSearch.get(key, cutoff(maxAgeMs)) as { results: string } | undefined;
      return row ? (JSON.parse(row.results) as SearchResult[]) : undefined;
    },

    putCachedSearch(key: string, results: SearchResult[], maxAgeMs: number): void {
      upsertCachedSearch.run(key, JSON.stringify(results), now().toISOString());
      // Expired rows are never read again; clearing them on write keeps the
      // table from growing without a separate cleanup job.
      deleteStaleSearches.run(cutoff(maxAgeMs));
    },
  };
}

export type Db = ReturnType<typeof openDb>;
