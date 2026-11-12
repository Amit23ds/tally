import { TOKEN_BUDGET, tokensToChars } from './budget.ts';
import type { Claim, Db, Turn } from './db.ts';
import type { Plan } from './plan.ts';
import { formatInstant, localDate, type DateRange } from './time.ts';

// Enough history to answer from without crowding out the search results.
const MAX_TURNS = 8;
// Topic matches are a guess at relevance; dated turns are what the user asked for.
const MAX_MATCHED_TURNS = 4;
// Old answers are context, not the source of truth: claims carry the numbers.
const ANSWER_CHARS = 600;
// The whole record section, so a long history can't crowd out search results.
const MEMORY_BUDGET_CHARS = tokensToChars(TOKEN_BUDGET.memory);

// How a turn was found: on a date the user named, or by topic.
type Found = Turn & { via: 'date' | 'match' };

export interface RecalledTurn extends Found {
  claims: Claim[];
}

export interface Recalled {
  turns: RecalledTurn[];
  // Dates the user named on which nothing was said.
  missing: DateRange[];
}

export interface RecallOptions {
  db: Db;
  terms: string[];
  dates: DateRange[];
  // The message being answered: it and anything after it are not "the past".
  beforeMessageId: number;
  todayIso: string;
}

// Memory is read by the harness, not by a tool call: it spans all
// conversations and is ready before the answer model starts.
export function recall({ db, terms, dates, beforeMessageId, todayIso }: RecallOptions): Recalled {
  const isPast = (hit: { id: number }) => hit.id < beforeMessageId;
  const datedIds: number[] = [];
  const missing: DateRange[] = [];

  // A phrase can have two readings ("last Tuesday"); it counts as recorded if
  // either reading finds something.
  for (const readings of groupByPhrase(dates)) {
    const hits = readings.flatMap((range) => db.messagesBetween(range).filter(isPast));
    // A range starting today mostly covers this very conversation, so "no
    // record for today" would be noise.
    if (hits.length === 0 && readings[0]!.date < todayIso) missing.push(readings[0]!);
    datedIds.push(...hits.map((hit) => hit.id));
  }

  const matchedIds = terms.length > 0 ? db.searchMessages(terms).filter(isPast).map((hit) => hit.id) : [];
  const dated: Found[] = db.turns(datedIds).map((turn) => ({ ...turn, via: 'date' }));
  const matched: Found[] = db.turns(matchedIds).map((turn) => ({ ...turn, via: 'match' }));
  return { turns: withClaims(db, merge(dated, matched)), missing };
}

// Combines two recall passes, keeping dated turns first and topic matches
// within their own budget.
export function mergeRecalled(a: Recalled, b: Recalled): Recalled {
  const turns = merge(
    [...a.turns, ...b.turns].filter((t) => t.via === 'date'),
    [...a.turns, ...b.turns].filter((t) => t.via === 'match'),
  );
  const missing = [...a.missing, ...b.missing.filter((m) => !a.missing.some((n) => n.start === m.start))];
  return { turns, missing };
}

function merge<T extends Found>(dated: T[], matched: T[]): T[] {
  const seen = new Set<number>();
  const keep = (turn: T) => !seen.has(turn.question.id) && Boolean(seen.add(turn.question.id));
  return [...dated.filter(keep), ...matched.filter(keep).slice(0, MAX_MATCHED_TURNS)].slice(0, MAX_TURNS);
}

function withClaims(db: Db, turns: Found[]): RecalledTurn[] {
  const claims = db.claimsForMessages(turns.flatMap((turn) => (turn.answer ? [turn.answer.id] : [])));
  return turns.map((turn) => ({ ...turn, claims: claims.filter((c) => c.message_id === turn.answer?.id) }));
}

function groupByPhrase(dates: DateRange[]): DateRange[][] {
  const groups = new Map<string, DateRange[]>();
  for (const range of dates) groups.set(range.phrase, [...(groups.get(range.phrase) ?? []), range]);
  return [...groups.values()];
}

// Words worth matching in past messages. Dates are left out because the date
// ranges already cover them, and "november" would match every answer that
// mentions the month.
const STOPWORDS = new Set(
  `the and for with that this what when where which who why how did does doing done was were are is be been have has had any
  you your yours our ours they them their there here then than from into about over since still also just only some more most
  can could would should will shall may might must not nor but all its it's i'm ive i've let lets tell said says ask asked
  again now today yesterday tomorrow last next this week weeks month months year years day days ago before after earlier
  monday tuesday wednesday thursday friday saturday sunday january february march april june july august september october
  november december jan feb mar apr jun jul aug sep sept oct nov dec correct right true changed change changes anything
  something big new old please thanks thank`.split(/\s+/),
);

// Split on anything that isn't a letter or digit, as the FTS5 tokenizer does,
// so every keyword is something the index can match.
export function keywords(text: string, max = 12): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words.filter((word) => word.length >= 3 && !STOPWORDS.has(word)))].slice(0, max);
}

export interface ClaimCheck {
  query: string;
  // The old answer's date (YYYY-MM-DD, user's timezone): only newer pages can
  // show a change since then.
  startDate: string;
}

// When the user asks whether an old answer still holds, the claims in it are
// exactly what to re-check: "Neon Launch plan price" since the day it was said.
export function claimChecks(recalled: Recalled, timeZone: string, max: number): ClaimCheck[] {
  const checks = new Map<string, ClaimCheck>();
  for (const turn of recalled.turns) {
    if (!turn.answer) continue;
    const startDate = localDate(turn.answer.created_at, timeZone);
    for (const claim of turn.claims) {
      const query = `${claim.entity} ${claim.attribute}`;
      const key = query.toLowerCase();
      const existing = checks.get(key);
      // The same claim made twice is checked from its first mention.
      if (!existing || startDate < existing.startDate) checks.set(key, { query, startDate });
    }
  }
  return [...checks.values()].slice(0, max);
}

const CITATION = /\s*\[\d+(?:\s*,\s*\d+)*\]/g;

// The "Your record of past conversations" section of the answer prompt, or
// undefined when there is nothing to say.
export function formatRecord(recalled: Recalled, { timeZone, intent }: { timeZone: string; intent: Plan['intent'] }): string | undefined {
  // Small talk only gets history the user pointed at by date; topic matches
  // would be noise.
  const turns = intent === 'chat' ? recalled.turns.filter((turn) => turn.via === 'date') : recalled.turns;
  const asksAboutMemory = intent === 'memory' || intent === 'memory_then_verify';
  if (turns.length === 0 && recalled.missing.length === 0 && !asksAboutMemory) return undefined;

  const header =
    '# Your record of past conversations\n' +
    "These are your earlier exchanges with this user, from all of their chats, with times in the user's timezone. " +
    'This is everything you remember. Never add to it or fill in gaps.';
  // "No record" lines are short and stop invented history: they always fit.
  const noRecord = recalled.missing.map((range) => {
    const when = range.label.startsWith('since') ? range.label : `for ${range.label}`;
    return `NO RECORD ${when}: you had no conversations with this user then. Say so plainly; never invent one.`;
  });
  if (turns.length === 0 && recalled.missing.length === 0) {
    noRecord.push('NO RECORD of any earlier conversation matching this message. Say so plainly; never invent one.');
  }

  // Turns arrive most wanted first (dated, then topic matches). Each is kept
  // whole if it fits; the first is always kept, cut short if need be.
  let room = MEMORY_BUDGET_CHARS - [header, ...noRecord].join('\n\n').length;
  const kept: string[] = [];
  let left = 0;
  for (const turn of turns) {
    let text = formatTurn(turn, timeZone);
    if (kept.length === 0 && text.length > room) text = clipLines(text, Math.max(room, ANSWER_CHARS));
    if (kept.length > 0 && text.length + 2 > room) {
      left++;
      continue;
    }
    kept.push(text);
    room -= text.length + 2;
  }
  if (left > 0) kept.push(`(${left} more matching exchange${left === 1 ? ' was' : 's were'} left out for length. Do not say they never happened.)`);
  return [header, ...kept, ...noRecord].join('\n\n');
}

function formatTurn(turn: RecalledTurn, timeZone: string): string {
  const lines = [
    `## ${formatInstant(turn.question.created_at, timeZone)} · "${turn.question.conversation_title}"`,
    `User: ${turn.question.content}`,
    // Old citation numbers point at sources from that day, not this answer's.
    turn.answer ? `You: ${clip(turn.answer.content.replace(CITATION, ''), ANSWER_CHARS)}` : 'You: (no answer was given)',
  ];
  if (turn.claims.length > 0) {
    lines.push('Claims you made then:');
    for (const c of turn.claims) {
      lines.push(`- ${c.entity} · ${c.attribute}: ${c.value} (as of ${c.as_of}${c.source_url ? `; source: ${c.source_url}` : ''})`);
    }
  }
  return lines.join('\n');
}

// Cuts multi-line text to `max` characters, keeping its line breaks.
function clipLines(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
