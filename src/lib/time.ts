import * as chrono from 'chrono-node';
import type { ParsedComponents, ParsedResult } from 'chrono-node';

// The single source of "now" for the app. Everything that stamps or compares
// time goes through here so that NOW can pin the clock for evals and seeding.
export function now(): Date {
  const pinned = process.env.NOW;
  if (!pinned) return new Date();
  const date = new Date(pinned);
  // Fail loudly: a silently ignored typo in NOW would make date tests pass
  // or fail for the wrong reason.
  if (Number.isNaN(date.getTime())) throw new Error(`NOW is not a valid ISO 8601 date: "${pinned}"`);
  return date;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

// ---------- Calendar days ----------

// A calendar day is an integer: days since 1970-01-01. Date arithmetic is then
// plain addition, with no time zones or DST involved. Time zones only matter
// at the edges: finding "today" and turning a day back into an instant.
type Day = number;

const DAY_MS = 86_400_000;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Date.UTC normalises overflow, so month 0 is December of the previous year.
const dayOf = (year: number, month: number, date: number): Day => Date.UTC(year, month - 1, date) / DAY_MS;
const weekdayOf = (day: Day): number => new Date(day * DAY_MS).getUTCDay();
// Weeks start on Monday (ISO 8601).
const weekStart = (day: Day): Day => day - ((weekdayOf(day) + 6) % 7);

function partsOf(day: Day): { year: number; month: number; date: number } {
  const d = new Date(day * DAY_MS);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, date: d.getUTCDate() };
}

function isoDay(day: Day): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

// Fixed English names rather than Intl output: ICU versions disagree on
// punctuation, and labels end up in prompts and tests.
function formatDay(day: Day): string {
  const { year, month, date } = partsOf(day);
  return `${WEEKDAYS[weekdayOf(day)]} ${date} ${MONTHS[month - 1]} ${year}`;
}

// ---------- Time zones ----------

const formatters = new Map<string, Intl.DateTimeFormat>();

// What a wall clock in `timeZone` shows at `at`.
function wallClock(at: Date, timeZone: string) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(at).map((p) => [p.type, Number(p.value)]));
  return { year: parts.year!, month: parts.month!, date: parts.day!, hour: parts.hour!, minute: parts.minute!, second: parts.second! };
}

// The wall clock read as if it were UTC. The difference to the real instant
// is the zone's offset at that moment.
function wallClockAsUtc(at: Date, timeZone: string): number {
  const w = wallClock(at, timeZone);
  return Date.UTC(w.year, w.month - 1, w.date, w.hour, w.minute, w.second);
}

function localDay(at: Date, timeZone: string): Day {
  return Math.floor(wallClockAsUtc(at, timeZone) / DAY_MS);
}

// The instant when `day` begins in `timeZone`. The offset is looked up twice
// because the first guess can land on the other side of a DST change.
function startOfDay(day: Day, timeZone: string): Date {
  const local = day * DAY_MS;
  const offsetAt = (instant: number) => wallClockAsUtc(new Date(instant), timeZone) - instant;
  const guess = local - offsetAt(local);
  return new Date(local - offsetAt(guess));
}

// "Today" depends on where the user is: 20:00 UTC on 11 Nov is already 12 Nov
// in India. The model is handed this calendar date and never derives it.
export function todayIn(timeZone: string, at: Date = now()): { iso: string; label: string } {
  const day = localDay(at, timeZone);
  return { iso: isoDay(day), label: formatDay(day) };
}

// The YYYY-MM-DD calendar date of an instant in the user's timezone.
export function localDate(iso: string, timeZone: string): string {
  return isoDay(localDay(new Date(iso), timeZone));
}

// "Monday 9 November 2026" for a YYYY-MM-DD calendar date.
export function dayLabel(isoDate: string): string {
  return formatDay(Date.parse(`${isoDate}T00:00:00Z`) / DAY_MS);
}

// "Tuesday 3 November 2026, 14:05" in the user's timezone, for quoting back
// when something was said.
export function formatInstant(iso: string, timeZone: string): string {
  const at = new Date(iso);
  const w = wallClock(at, timeZone);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${formatDay(localDay(at, timeZone))}, ${pad(w.hour)}:${pad(w.minute)}`;
}

// ---------- resolveDates ----------

export interface DateRange {
  // The words in the message this range came from.
  phrase: string;
  // [start, end) as ISO 8601 UTC instants: start inclusive, end exclusive.
  start: string;
  end: string;
  // The local calendar date the range starts on, YYYY-MM-DD.
  date: string;
  label: string;
  // Set on the second reading of an ambiguous phrase (see "last <weekday>").
  alternative?: true;
}

interface Found {
  index: number;
  phrase: string;
  from: Day;
  to: Day;
  alternative?: true;
}

// Periods chrono reads as a single day ("last week" = 7 days ago) rather than
// as the span people mean.
const PERIODS: Array<{ pattern: RegExp; span: (today: Day) => [Day, Day] }> = [
  { pattern: /\blast week\b/gi, span: (today) => [weekStart(today) - 7, weekStart(today)] },
  { pattern: /\bthis week\b/gi, span: (today) => [weekStart(today), today + 1] },
  {
    pattern: /\blast month\b/gi,
    span: (today) => {
      const { year, month } = partsOf(today);
      return [dayOf(year, month - 1, 1), dayOf(year, month, 1)];
    },
  },
  {
    pattern: /\bthis month\b/gi,
    span: (today) => {
      const { year, month } = partsOf(today);
      return [dayOf(year, month, 1), today + 1];
    },
  },
];

// A date without a year means its most recent occurrence: this agent is asked
// about the past ("what did I ask on 3 November?"), so 20 December asked in
// November is last December, not next.
function certainDay(c: ParsedComponents, today: Day): Day {
  const month = c.get('month')!;
  const date = c.get('day')!;
  if (c.isCertain('year')) return dayOf(c.get('year')!, month, date);
  const thisYear = dayOf(partsOf(today).year, month, date);
  return thisYear <= today ? thisYear : dayOf(partsOf(today).year - 1, month, date);
}

// Turns one chrono match into day spans using our own rules. chrono's own
// choices suit scheduling ("Friday" = the coming Friday), not memory.
function spansFor(result: ParsedResult, today: Day): Array<Omit<Found, 'index' | 'phrase'>> {
  const start = result.start;

  if (start.isCertain('day') && start.isCertain('month')) {
    const from = certainDay(start, today);
    const end = result.end?.isCertain('day') ? certainDay(result.end, today) + 1 : from + 1;
    return [{ from, to: Math.max(end, from + 1) }];
  }

  if (start.isCertain('weekday')) {
    const target = start.get('weekday')!;
    const words = result.text.toLowerCase();
    if (/\bnext\b/.test(words)) {
      const ahead = (target - weekdayOf(today) + 7) % 7 || 7;
      return [{ from: today + ahead, to: today + ahead + 1 }];
    }
    if (/\bthis\b/.test(words)) {
      const from = weekStart(today) + ((target + 6) % 7);
      return [{ from, to: from + 1 }];
    }
    // Bare "Monday" or "last Monday": the most recent one before today. On a
    // Tuesday, "last Tuesday" is a week ago, never today.
    const back = (weekdayOf(today) - target + 7) % 7 || 7;
    const from = today - back;
    const spans: Array<Omit<Found, 'index' | 'phrase'>> = [{ from, to: from + 1 }];
    // "Last Tuesday" said on a Friday can mean three days ago or the week
    // before. Recall checks both rather than guessing wrong.
    if (/\b(last|previous|past)\b/.test(words) && from >= weekStart(today)) {
      spans.push({ from: from - 7, to: from - 6, alternative: true });
    }
    return spans;
  }

  if (start.isCertain('month')) {
    const month = start.get('month')!;
    let year = start.isCertain('year') ? start.get('year')! : partsOf(today).year;
    if (!start.isCertain('year') && dayOf(year, month, 1) > today) year -= 1;
    return [{ from: dayOf(year, month, 1), to: dayOf(year, month + 1, 1) }];
  }

  // Times without a date ("at 5pm") say nothing about which day.
  return [];
}

function labelFor(found: Found, since: boolean): string {
  if (since) return `since ${formatDay(found.from)}`;
  if (found.to - found.from === 1) return formatDay(found.from);
  return `${formatDay(found.from)} to ${formatDay(found.to - 1)}`;
}

// Finds every date reference in `text` and resolves it to an absolute range in
// the user's timezone. This is the only place relative dates become real
// dates; the model only ever sees the results.
export function resolveDates(text: string, timeZone: string, at: Date = now()): DateRange[] {
  const today = localDay(at, timeZone);
  const found: Found[] = [];

  for (const { pattern, span } of PERIODS) {
    for (const match of text.matchAll(pattern)) {
      const [from, to] = span(today);
      found.push({ index: match.index, phrase: match[0], from, to });
    }
  }

  // chrono parses relative to a reference instant. Giving it the user's wall
  // clock as a UTC time makes every component it returns a local calendar value.
  const reference = { instant: new Date(wallClockAsUtc(at, timeZone)), timezone: 0 };
  // Day-first ("3/11" = 3 November) everywhere except the Americas.
  const parser = timeZone.startsWith('America/') ? chrono.en.casual : chrono.en.GB;
  for (const result of parser.parse(text, reference)) {
    const end = result.index + result.text.length;
    if (found.some((f) => f.index < end && result.index < f.index + f.phrase.length)) continue;
    for (const span of spansFor(result, today)) found.push({ index: result.index, phrase: result.text.trim(), ...span });
  }

  const seen = new Set<string>();
  return found
    .sort((a, b) => a.index - b.index || Number(a.alternative ?? 0) - Number(b.alternative ?? 0))
    .flatMap((f) => {
      // "since Friday" runs from Friday to the end of today.
      const since = /\b(since|after)\s+$/i.test(text.slice(0, f.index)) || /^(since|after)\b/i.test(f.phrase);
      const to = since ? today + 1 : f.to;
      const range: DateRange = {
        phrase: since && !/^(since|after)\b/i.test(f.phrase) ? `since ${f.phrase}` : f.phrase,
        start: startOfDay(f.from, timeZone).toISOString(),
        end: startOfDay(to, timeZone).toISOString(),
        date: isoDay(f.from),
        label: labelFor(f, since),
        ...(f.alternative && { alternative: true as const }),
      };
      const key = `${range.start}|${range.end}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [range];
    });
}
