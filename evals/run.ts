// Runs every case in cases.json against the real server over HTTP, times it,
// and has a model grade the final answer against a short rubric.
//
//   npm run eval                    all cases
//   npm run eval -- --only edge     cases whose id contains "edge"
//   npm run eval -- --list          show the cases and their resolved dates; needs no API keys
//   npm run eval -- --pause 60      wait 60s between cases (default 60 with Groq's
//                                   free tier, which allows ~8,000 tokens a minute; 0 otherwise)
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Output, generateText } from 'ai';
import { z } from 'zod';
import { PROVIDER, RateLimitedError, requiredKeys, smart } from '../src/lib/models.ts';
import { JUDGE_SYSTEM_PROMPT, judgeInput } from '../src/lib/prompts.ts';
import { isValidTimeZone, todayIn } from '../src/lib/time.ts';
import { ask, fillDates, resolveAt, startServer, type Reply, type Server } from './harness.ts';

const TimeZone = z.string().refine(isValidTimeZone, 'Unknown IANA timezone');

const CaseFile = z.object({
  notes: z.array(z.string()),
  timeZone: TimeZone,
  cases: z.array(
    z.object({
      id: z.string(),
      category: z.enum(['lookup', 'chat', 'multi-turn', 'memory-miss', 'date-edge', 'example']),
      timeZone: TimeZone.optional(),
      turns: z.array(z.object({ at: z.string().optional(), message: z.string(), continue: z.boolean().optional() })).min(1),
      expect: z.object({ search: z.boolean().optional(), rubric: z.string() }),
    }),
  ),
});
type Case = z.infer<typeof CaseFile>['cases'][number];

const CRITERIA = ['correct', 'cited', 'no_invented_history', 'concise'] as const;
const Verdict = z.object({ pass: z.boolean(), reason: z.string() });
const Grade = z.object({ correct: Verdict, cited: Verdict, no_invented_history: Verdict, concise: Verdict });

interface TurnRun {
  now: string | undefined;
  message: string;
  reply: Reply;
}

interface Result {
  id: string;
  category: Case['category'];
  turns: TurnRun[];
  // Reasons the case failed; empty means it passed.
  failures: string[];
  grade?: z.infer<typeof Grade>;
}

// Runs one case in its own folder, so it starts with an empty database. The
// server is restarted whenever the pinned clock changes between turns.
async function runCase(testCase: Case, timeZone: string): Promise<TurnRun[]> {
  const dir = mkdtempSync(join(tmpdir(), 'tally-eval-'));
  const runs: TurnRun[] = [];
  let server: Server | undefined;
  let serverNow: string | undefined;
  let conversationId = randomUUID();
  try {
    for (const turn of testCase.turns) {
      const now = resolveAt(turn.at, timeZone);
      if (!server || now !== serverNow) {
        // Stopping waits for claim extraction, which later turns depend on.
        await server?.stop();
        server = await startServer(dir, now);
        serverNow = now;
      }
      if (!turn.continue) conversationId = randomUUID();
      const message = fillDates(turn.message, timeZone);
      const reply = await ask(server.url, { conversationId, message, timeZone });
      runs.push({ now, message, reply });
      if (reply.error) break;
    }
  } finally {
    await server?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
  return runs;
}

const dateLabel = (now: string | undefined, timeZone: string) => todayIn(timeZone, now ? new Date(now) : new Date()).label;

async function grade(testCase: Case, turns: TurnRun[], timeZone: string): Promise<z.infer<typeof Grade>> {
  const final = turns.at(-1)!;
  const { output } = await generateText({
    // The strong model grades: judging needs more care than routing does.
    model: smart.model(),
    instructions: JUDGE_SYSTEM_PROMPT,
    prompt: judgeInput({
      todayLabel: dateLabel(final.now, timeZone),
      earlier: turns.slice(0, -1).map((t) => ({ dateLabel: dateLabel(t.now, timeZone), question: t.message, reply: t.reply.text })),
      question: final.message,
      answer: final.reply.text,
      sources: final.reply.sources,
      searched: final.reply.searched,
      expected: testCase.expect.rubric,
    }),
    output: Output.object({ schema: Grade }),
    maxOutputTokens: 2_000,
    providerOptions: smart.providerOptions,
  });
  return output;
}

// The judge isn't user-facing, so unlike the app it can wait out a rate limit
// as long as it takes (a few times, up to a minute each).
async function patiently<T>(call: () => Promise<T>, attempts = 4): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (!(error instanceof RateLimitedError) || attempt >= attempts) throw error;
      const waitS = Math.min(65, (error.retryAfterSeconds ?? 10) + 1);
      process.stdout.write(`(judge rate-limited, waiting ${waitS}s) `);
      await new Promise((resolve) => setTimeout(resolve, waitS * 1000));
    }
  }
}

async function evaluate(testCase: Case, timeZone: string): Promise<Result> {
  const turns = await runCase(testCase, timeZone);
  const result: Result = { id: testCase.id, category: testCase.category, turns, failures: [] };
  const final = turns.at(-1)!;
  if (final.reply.error || turns.length < testCase.turns.length) {
    result.failures.push(`turn ${turns.length} failed: ${final.reply.error}`);
    return result;
  }

  // Checked in code, not by the judge: these are facts about what happened.
  const { search } = testCase.expect;
  if (search !== undefined && search !== final.reply.searched) {
    result.failures.push(search ? 'did not search, but should have' : 'searched, but should not have');
  }
  if (final.reply.searched && final.reply.sources.length === 0) result.failures.push('searched, but cited no sources');

  // A judge that can't be reached fails this case; it must not end the run.
  try {
    result.grade = await patiently(() => grade(testCase, turns, timeZone));
  } catch (error) {
    result.failures.push(`judge failed: ${error instanceof Error ? error.message : String(error)}`);
    return result;
  }
  for (const criterion of CRITERIA) {
    const verdict = result.grade[criterion];
    if (!verdict.pass) result.failures.push(`${criterion}: ${verdict.reason}`);
  }
  return result;
}

// ---------- Reporting ----------

const median = (values: number[]): number | undefined => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : undefined;
};
const seconds = (ms: number | undefined) => (ms === undefined ? '-' : `${(ms / 1000).toFixed(1)}s`);
const mark = (pass: boolean | undefined) => (pass === undefined ? '-' : pass ? 'ok' : 'FAIL');

function printSummary(results: Result[]): void {
  const idWidth = Math.max(...results.map((r) => r.id.length), 4);
  const row = (cells: string[]) => console.log(cells.map((cell, i) => (i === 0 ? cell.padEnd(idWidth) : cell.padStart(8))).join('  '));
  console.log();
  row(['case', 'correct', 'cited', 'history', 'concise', 'search', 'TTFT', 'total', 'result']);
  for (const r of results) {
    const final = r.turns.at(-1)!.reply;
    row([
      r.id,
      mark(r.grade?.correct.pass),
      mark(r.grade?.cited.pass),
      mark(r.grade?.no_invented_history.pass),
      mark(r.grade?.concise.pass),
      final.searched ? 'yes' : 'no',
      seconds(final.firstToken),
      seconds(final.total),
      r.failures.length ? 'FAIL' : 'pass',
    ]);
  }

  const failed = results.filter((r) => r.failures.length);
  if (failed.length) {
    console.log('\nFailures');
    for (const r of failed) {
      for (const failure of r.failures) console.log(`  ${r.id}: ${failure}`);
      // The answer itself usually shows why faster than the judge's reason does.
      const text = r.turns.at(-1)?.reply.text.replace(/\s+/g, ' ').trim();
      if (text) console.log(`    answer: ${text.length > 300 ? `${text.slice(0, 299)}…` : text}`);
    }
  }

  // Timings cover every turn that completed, not just the graded one.
  const replies = results.flatMap((r) => r.turns.map((t) => t.reply)).filter((reply) => !reply.error);
  const ttft = replies.flatMap((reply) => (reply.firstToken === undefined ? [] : [reply.firstToken]));
  const total = (searched: boolean) => replies.filter((reply) => reply.searched === searched).map((reply) => reply.total);
  console.log(`\nCases passed: ${results.length - failed.length} / ${results.length}`);
  console.log(`Median time to first token: ${seconds(median(ttft))} (${ttft.length} answers)`);
  console.log(`Median full answer with search: ${seconds(median(total(true)))} (${total(true).length} answers)`);
  console.log(`Median full answer without search: ${seconds(median(total(false)))} (${total(false).length} answers)`);
}

// ---------- Main ----------

const file = CaseFile.parse(JSON.parse(readFileSync(new URL('./cases.json', import.meta.url), 'utf8')));
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : undefined;
const cases = file.cases.filter((c) => !only || c.id.includes(only));
const pauseArg = process.argv.includes('--pause') ? Number(process.argv[process.argv.indexOf('--pause') + 1]) : undefined;
const pauseS = pauseArg !== undefined && Number.isFinite(pauseArg) ? pauseArg : PROVIDER === 'groq' ? 60 : 0;

if (process.argv.includes('--list')) {
  for (const c of cases) {
    const timeZone = c.timeZone ?? file.timeZone;
    console.log(`${c.id} (${c.category}, ${timeZone})`);
    for (const turn of c.turns) console.log(`  [${dateLabel(resolveAt(turn.at, timeZone), timeZone)}] ${fillDates(turn.message, timeZone)}`);
  }
  console.log(`\n${cases.length} cases`);
  process.exit(0);
}

const missing = requiredKeys().filter((key) => !process.env[key]);
if (missing.length) {
  console.error(`Missing ${missing.join(' and ')}. Add to .env, then run again.`);
  process.exit(1);
}
if (cases.length === 0) {
  console.error(`No case id contains "${only}".`);
  process.exit(1);
}

console.log(`Models: ${PROVIDER} (the judge uses the same provider)${pauseS ? `; ${pauseS}s pause between cases` : ''}`);
const results: Result[] = [];
for (const [i, testCase] of cases.entries()) {
  // Lets a per-minute token budget refill, so cases fail on quality, not on limits.
  if (i > 0 && pauseS > 0) await new Promise((resolve) => setTimeout(resolve, pauseS * 1000));
  process.stdout.write(`[${i + 1}/${cases.length}] ${testCase.id} … `);
  const result = await evaluate(testCase, testCase.timeZone ?? file.timeZone);
  results.push(result);
  console.log(result.failures.length ? 'FAIL' : 'pass');
}
printSummary(results);
process.exit(results.some((r) => r.failures.length) ? 1 : 0);
