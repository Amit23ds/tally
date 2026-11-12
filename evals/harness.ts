// Drives the real server over HTTP, as a user would. Shared by the eval
// runner, the seed script and the latency benchmark.
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import type { Source } from '../src/lib/events.ts';
import { todayIn } from '../src/lib/time.ts';

const TSX = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url));
const SERVER = fileURLToPath(new URL('../src/server.ts', import.meta.url));
const START_TIMEOUT_MS = 30_000;
// Generous: the server finishes claim extraction before it exits.
const STOP_TIMEOUT_MS = 30_000;

export interface Server {
  url: string;
  stop(): Promise<void>;
}

// Starts the server with its working directory (and so its database) in `dir`,
// and the clock pinned to `now` (or the real clock when undefined).
export async function startServer(dir: string, now?: string): Promise<Server> {
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: '0' };
  delete env.NOW;
  if (now) env.NOW = now;
  const child = spawn(TSX, [SERVER], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stderr!.on('data', (chunk) => (output += chunk));

  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server did not start:\n${output}`)), START_TIMEOUT_MS);
    child.stdout!.on('data', (chunk) => {
      output += chunk;
      const match = /running at (http:\/\/\S+)/.exec(String(chunk));
      if (match) {
        clearTimeout(timer);
        resolve(match[1]!);
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited (${code}):\n${output}`));
    });
  });
  return { url, stop: () => stop(child) };
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), STOP_TIMEOUT_MS);
  await exited;
  clearTimeout(timer);
}

export interface Reply {
  text: string;
  sources: Source[];
  // Every status line shown, in order; "Searching: ..." means a search ran.
  statuses: string[];
  searched: boolean;
  // Milliseconds from sending the request.
  status?: number;
  firstToken?: number;
  total: number;
  error?: string;
}

export async function ask(base: string, request: { conversationId: string; message: string; timeZone: string }): Promise<Reply> {
  const started = performance.now();
  const since = () => Math.round(performance.now() - started);
  const reply: Reply = { text: '', sources: [], statuses: [], searched: false, total: 0 };
  const response = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!response.ok || !response.body) return { ...reply, total: since(), error: `HTTP ${response.status}: ${await response.text()}` };

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    const lines = buffer.split('\n');
    buffer = lines.pop()!;
    for (const line of lines.filter(Boolean)) {
      const event = JSON.parse(line) as { type: string; text?: string; sources?: Source[]; message?: string };
      if (event.type === 'status') {
        reply.status ??= since();
        reply.statuses.push(event.text!);
        if (event.text!.startsWith('Searching:')) reply.searched = true;
      }
      if (event.type === 'token') {
        reply.firstToken ??= since();
        reply.text += event.text;
      }
      if (event.type === 'sources') reply.sources = event.sources!;
      if (event.type === 'error') reply.error = event.message;
    }
  }
  reply.total = since();
  return reply;
}

// ---------- Relative clock ----------

const DAY_MS = 86_400_000;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Today in the case's timezone from the real clock, ignoring any NOW the
// runner itself was started with.
function today(timeZone: string): number {
  return Date.parse(`${todayIn(timeZone, new Date()).iso}T00:00:00Z`) / DAY_MS;
}

// A day relative to today: "-9d", or a weekday name meaning the most recent
// one before today (the same reading the app gives "Monday").
function relativeDay(spec: string, timeZone: string): number | undefined {
  const offset = /^-(\d+)d$/.exec(spec);
  if (offset) return today(timeZone) - Number(offset[1]);
  const weekday = WEEKDAYS.indexOf(spec.toLowerCase());
  if (weekday === -1) return undefined;
  const current = today(timeZone);
  const back = (new Date(current * DAY_MS).getUTCDay() - weekday + 7) % 7 || 7;
  return current - back;
}

// The NOW for a turn:
// - "today" or nothing: undefined, i.e. the real clock
// - "-9d" or "monday": 09:00 UTC on that day (afternoon in Asia, early morning
//   in the Americas, the same calendar day in both)
// - an ISO instant: exactly that, for date edge cases
export function resolveAt(at: string | undefined, timeZone: string): string | undefined {
  if (!at || at === 'today') return undefined;
  const day = relativeDay(at, timeZone);
  if (day !== undefined) return new Date(day * DAY_MS + 9 * 3_600_000).toISOString();
  if (Number.isNaN(Date.parse(at))) throw new Error(`Unknown "at": ${at}`);
  return new Date(at).toISOString();
}

// Replaces "{-9d}" in a message with that date as a person would write it,
// e.g. "3 November", so cases keep working whatever day they run.
export function fillDates(message: string, timeZone: string): string {
  return message.replace(/\{([^}]+)\}/g, (_, spec: string) => {
    const day = relativeDay(spec, timeZone);
    if (day === undefined) throw new Error(`Unknown date placeholder {${spec}}`);
    const d = new Date(day * DAY_MS);
    return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  });
}
