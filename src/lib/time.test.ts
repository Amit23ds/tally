import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { formatInstant, isValidTimeZone, now, resolveDates, todayIn, type DateRange } from './time.ts';

const IST = 'Asia/Kolkata';
// Reference instants, chosen as midday in India so the local date is obvious.
const TUESDAY_10_NOV = new Date('2026-11-10T06:30:00Z');
const WEDNESDAY_11_NOV = new Date('2026-11-11T06:30:00Z');
const FRIDAY_13_NOV = new Date('2026-11-13T06:30:00Z');

// Compact view of the ranges: local start date, local end date (exclusive), label.
function days(ranges: DateRange[], timeZone = IST) {
  const local = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone });
  return ranges.map((r) => [local(r.start), local(r.end), r.label, ...(r.alternative ? ['alternative'] : [])]);
}

describe('now()', () => {
  const original = process.env.NOW;
  afterEach(() => {
    if (original === undefined) delete process.env.NOW;
    else process.env.NOW = original;
  });

  it('returns the real clock when NOW is unset', () => {
    delete process.env.NOW;
    const before = Date.now();
    const value = now().getTime();
    assert.ok(value >= before && value <= Date.now());
  });

  it('returns the pinned instant when NOW is set', () => {
    process.env.NOW = '2026-11-03T14:30:00Z';
    assert.equal(now().toISOString(), '2026-11-03T14:30:00.000Z');
  });

  it('throws on an invalid NOW instead of ignoring it', () => {
    process.env.NOW = 'next tuesday';
    assert.throws(() => now(), /NOW is not a valid ISO 8601 date/);
  });

  it('drives resolveDates when no reference instant is passed', () => {
    process.env.NOW = '2026-11-11T06:30:00Z';
    assert.deepEqual(days(resolveDates('yesterday', IST)), [['2026-11-10', '2026-11-11', 'Tuesday 10 November 2026']]);
  });
});

describe('todayIn()', () => {
  it('uses the calendar date in the user timezone, not UTC', () => {
    const lateEveningUtc = new Date('2026-11-11T20:00:00Z');
    assert.equal(todayIn('UTC', lateEveningUtc).iso, '2026-11-11');
    assert.equal(todayIn(IST, lateEveningUtc).iso, '2026-11-12');
  });

  it('rolls back a day for timezones behind UTC', () => {
    assert.equal(todayIn('America/Los_Angeles', new Date('2026-11-11T05:00:00Z')).iso, '2026-11-10');
  });

  it('gives a readable label with the weekday', () => {
    assert.equal(todayIn('UTC', new Date('2026-11-11T12:00:00Z')).label, 'Wednesday 11 November 2026');
  });
});

describe('isValidTimeZone()', () => {
  it('accepts IANA names and rejects junk', () => {
    assert.equal(isValidTimeZone('Europe/Berlin'), true);
    assert.equal(isValidTimeZone('Mars/Olympus'), false);
  });
});

describe('resolveDates(): weekdays', () => {
  it('"last Tuesday" said on a Tuesday is a week ago, never today', () => {
    assert.deepEqual(days(resolveDates('Last Tuesday I asked you about Postgres hosting', IST, TUESDAY_10_NOV)), [
      ['2026-11-03', '2026-11-04', 'Tuesday 3 November 2026'],
    ]);
  });

  it('a bare weekday that is today also means the previous one', () => {
    assert.deepEqual(days(resolveDates('on Tuesday', IST, TUESDAY_10_NOV)), [['2026-11-03', '2026-11-04', 'Tuesday 3 November 2026']]);
  });

  it('"last Tuesday" earlier this week also offers the week before', () => {
    assert.deepEqual(days(resolveDates('last Tuesday', IST, FRIDAY_13_NOV)), [
      ['2026-11-10', '2026-11-11', 'Tuesday 10 November 2026'],
      ['2026-11-03', '2026-11-04', 'Tuesday 3 November 2026', 'alternative'],
    ]);
  });

  it('a bare weekday earlier this week has a single reading', () => {
    assert.deepEqual(days(resolveDates('On Monday we shortlisted 5 CRM tools for a 20-person sales team.', IST, WEDNESDAY_11_NOV)), [
      ['2026-11-09', '2026-11-10', 'Monday 9 November 2026'],
    ]);
  });

  it('"last Sunday" on a Monday is yesterday, which was already last week', () => {
    const monday = new Date('2026-11-09T06:30:00Z');
    assert.deepEqual(days(resolveDates('last Sunday', IST, monday)), [['2026-11-08', '2026-11-09', 'Sunday 8 November 2026']]);
  });

  it('"next" and "this" look forward within the week', () => {
    assert.deepEqual(days(resolveDates('next Friday', IST, WEDNESDAY_11_NOV)), [['2026-11-13', '2026-11-14', 'Friday 13 November 2026']]);
    assert.deepEqual(days(resolveDates('this Friday', IST, WEDNESDAY_11_NOV)), [['2026-11-13', '2026-11-14', 'Friday 13 November 2026']]);
  });
});

describe('resolveDates(): since, yesterday, periods', () => {
  it('"since Friday" runs from last Friday to the end of today', () => {
    const [range] = resolveDates('Has anything changed since Friday?', IST, WEDNESDAY_11_NOV);
    assert.deepEqual(days([range!]), [['2026-11-06', '2026-11-12', 'since Friday 6 November 2026']]);
    assert.equal(range!.phrase, 'since Friday');
  });

  it('"yesterday" is one whole local day', () => {
    assert.deepEqual(days(resolveDates('yesterday', IST, WEDNESDAY_11_NOV)), [['2026-11-10', '2026-11-11', 'Tuesday 10 November 2026']]);
  });

  it('"last week" is Monday to Sunday of the previous week', () => {
    assert.deepEqual(days(resolveDates('What did we discuss last week?', IST, WEDNESDAY_11_NOV)), [
      ['2026-11-02', '2026-11-09', 'Monday 2 November 2026 to Sunday 8 November 2026'],
    ]);
  });

  it('"last week" on a Sunday still means the week before this one', () => {
    const sunday = new Date('2026-11-08T06:30:00Z');
    assert.deepEqual(days(resolveDates('last week', IST, sunday)), [
      ['2026-10-26', '2026-11-02', 'Monday 26 October 2026 to Sunday 1 November 2026'],
    ]);
  });

  it('"last month" in January is December of the previous year', () => {
    const january = new Date('2027-01-15T06:30:00Z');
    assert.deepEqual(days(resolveDates('last month', IST, january)), [
      ['2026-12-01', '2027-01-01', 'Tuesday 1 December 2026 to Thursday 31 December 2026'],
    ]);
  });

  it('"since last week" starts at the beginning of last week', () => {
    assert.deepEqual(days(resolveDates('since last week', IST, WEDNESDAY_11_NOV)), [['2026-11-02', '2026-11-12', 'since Monday 2 November 2026']]);
  });
});

describe('resolveDates(): explicit dates', () => {
  it('a date with no year is its most recent occurrence', () => {
    assert.deepEqual(days(resolveDates('What did I ask you on 3 November?', IST, WEDNESDAY_11_NOV)), [
      ['2026-11-03', '2026-11-04', 'Tuesday 3 November 2026'],
    ]);
  });

  it('a date with no year that is still ahead this year means last year', () => {
    assert.deepEqual(days(resolveDates('on 20 December', IST, WEDNESDAY_11_NOV)), [['2025-12-20', '2025-12-21', 'Saturday 20 December 2025']]);
  });

  it('a date with no year early in January reaches back into the previous year', () => {
    const newYear = new Date('2027-01-02T06:30:00Z');
    assert.deepEqual(days(resolveDates('3 November', IST, newYear)), [['2026-11-03', '2026-11-04', 'Tuesday 3 November 2026']]);
  });

  it('an explicit year is kept', () => {
    assert.deepEqual(days(resolveDates('3 Nov 2025', IST, WEDNESDAY_11_NOV)), [['2025-11-03', '2025-11-04', 'Monday 3 November 2025']]);
  });

  it('a month on its own covers the whole month', () => {
    assert.deepEqual(days(resolveDates('back in March', IST, WEDNESDAY_11_NOV)), [
      ['2026-03-01', '2026-04-01', 'Sunday 1 March 2026 to Tuesday 31 March 2026'],
    ]);
  });

  it('reads numeric dates day-first, except in the Americas', () => {
    assert.deepEqual(days(resolveDates('3/11', IST, WEDNESDAY_11_NOV)), [['2026-11-03', '2026-11-04', 'Tuesday 3 November 2026']]);
    const ny = 'America/New_York';
    assert.deepEqual(days(resolveDates('3/11', ny, WEDNESDAY_11_NOV), ny), [['2026-03-11', '2026-03-12', 'Wednesday 11 March 2026']]);
  });

  it('finds several references in order', () => {
    const ranges = resolveDates('What did I ask you on 3 November? Is your answer still correct today?', IST, WEDNESDAY_11_NOV);
    assert.deepEqual(
      ranges.map((r) => r.phrase),
      ['on 3 November', 'today'],
    );
  });
});

describe('resolveDates(): timezones', () => {
  // 19:00 UTC on 11 Nov is 00:30 on 12 Nov in India.
  const justAfterMidnightIst = new Date('2026-11-11T19:00:00Z');

  it('"yesterday" just after midnight IST is the 11th in India but the 10th in UTC', () => {
    assert.deepEqual(resolveDates('yesterday', IST, justAfterMidnightIst).map(({ start, end }) => [start, end]), [
      ['2026-11-10T18:30:00.000Z', '2026-11-11T18:30:00.000Z'],
    ]);
    assert.deepEqual(resolveDates('yesterday', 'UTC', justAfterMidnightIst).map(({ start, end }) => [start, end]), [
      ['2026-11-10T00:00:00.000Z', '2026-11-11T00:00:00.000Z'],
    ]);
  });

  it('a message sent at 00:30 IST on 4 Nov is not part of "3 November" in India', () => {
    const sentAt = '2026-11-03T19:00:00.000Z'; // 00:30 IST on 4 Nov, still 3 Nov in UTC
    const inRange = (r: DateRange) => sentAt >= r.start && sentAt < r.end;
    assert.equal(inRange(resolveDates('3 November', IST, WEDNESDAY_11_NOV)[0]!), false);
    assert.equal(inRange(resolveDates('3 November', 'UTC', WEDNESDAY_11_NOV)[0]!), true);
  });

  it('a day containing a DST change is 25 hours long', () => {
    // New York leaves daylight time on Sunday 1 November 2026.
    const [range] = resolveDates('yesterday', 'America/New_York', new Date('2026-11-02T15:00:00Z'));
    assert.equal(range!.start, '2026-11-01T04:00:00.000Z');
    assert.equal(range!.end, '2026-11-02T05:00:00.000Z');
  });
});

describe('resolveDates(): no dates', () => {
  it('ignores text without a date, and times without a day', () => {
    for (const text of ['What is Postgres?', 'May I ask something?', 'Call me at 5pm', 'We have 20 people on the team']) {
      assert.deepEqual(resolveDates(text, IST, WEDNESDAY_11_NOV), [], text);
    }
  });
});

describe('formatInstant()', () => {
  it('shows the local date and time, which can differ from the UTC date', () => {
    assert.equal(formatInstant('2026-11-03T19:00:00.000Z', IST), 'Wednesday 4 November 2026, 00:30');
    assert.equal(formatInstant('2026-11-03T19:00:00.000Z', 'UTC'), 'Tuesday 3 November 2026, 19:00');
  });
});
