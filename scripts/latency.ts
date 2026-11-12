// Measures what a user waits for, over HTTP against a running server:
// time to the first status line, to the first answer token, and to the end.
//
//   npm run dev                      (in another terminal, with .env filled in)
//   npm run latency                  (or: npm run latency -- --base http://localhost:3001 --runs 3)
//
// The questions run in order, each in a new conversation, because the last two
// rely on memory of the earlier ones. The first run starts with a cold search
// cache; later runs show the effect of the 6-hour cache.
import { randomUUID } from 'node:crypto';
import { ask, type Reply } from '../evals/harness.ts';

const QUESTIONS = [
  { label: 'chat', text: "hey, how's it going?" },
  { label: 'lookup', text: "What does Neon's Launch plan cost right now?" },
  { label: 'fan-out', text: 'Compare HubSpot, Pipedrive and Close pricing for a 20-person sales team.' },
  { label: 'memory', text: 'What did I ask you about Neon earlier today?' },
  { label: 'verify', text: "Is what you told me about Neon's pricing earlier today still correct?" },
];

// The user should see something happening within this long.
const STATUS_BUDGET_MS = 300;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const median = (values: number[]): string => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? `${sorted[Math.floor((sorted.length - 1) / 2)]}ms` : '-';
};
const ms = (n: number | undefined) => (n === undefined ? '-' : `${n}ms`);

const base = arg('base', `http://localhost:${process.env.PORT ?? 3000}`);
const runs = Number(arg('runs', '1'));
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const answered: Reply[] = [];

for (let run = 1; run <= runs; run++) {
  console.log(`\nRun ${run}/${runs} against ${base}${run === 1 ? ' (cold search cache)' : ''}`);
  console.log(`${'question'.padEnd(9)}${'status'.padStart(8)}${'first token'.padStart(14)}${'total'.padStart(9)}`);
  for (const { label, text } of QUESTIONS) {
    const reply = await ask(base, { conversationId: randomUUID(), message: text, timeZone });
    if (!reply.error) answered.push(reply);
    const slow = reply.status !== undefined && reply.status > STATUS_BUDGET_MS ? `   SLOW STATUS (>${STATUS_BUDGET_MS}ms)` : '';
    const error = reply.error ? `   ERROR ${reply.error}` : '';
    console.log(`${label.padEnd(9)}${ms(reply.status).padStart(8)}${ms(reply.firstToken).padStart(14)}${ms(reply.total).padStart(9)}${slow}${error}`);
  }
}

const firstTokens = answered.flatMap((reply) => (reply.firstToken === undefined ? [] : [reply.firstToken]));
console.log(
  `\nMedian over ${answered.length} answers: status ${median(answered.flatMap((r) => (r.status === undefined ? [] : [r.status])))}, ` +
    `first token ${median(firstTokens)}, total ${median(answered.map((r) => r.total))}`,
);
