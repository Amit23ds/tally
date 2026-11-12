// Opt-in demo data: `npm run seed`. Nothing here runs unless you ask for it.
//
// It asks three real questions through the real server with the clock set to
// past dates, so the conversations, sources and claims are produced by the
// pipeline itself. The answers reflect the web as it is today; only the
// timestamps are in the past. Each conversation is titled "[Demo] ...".
// To remove everything, stop the server and delete the data/ folder.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ask, resolveAt, startServer } from '../evals/harness.ts';
import { openDb } from '../src/lib/db.ts';
import { requiredKeys } from '../src/lib/models.ts';
import { todayIn } from '../src/lib/time.ts';

const PROJECT = fileURLToPath(new URL('..', import.meta.url));
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

// The most recent 3 November before today, so the brief's "What did I ask you
// on 3 November?" has something to find whenever this is run.
function lastThirdOfNovember(): string {
  const today = todayIn(timeZone, new Date()).iso;
  const year = Number(today.slice(0, 4));
  const thisYear = `${year}-11-03`;
  return `${thisYear < today ? thisYear : `${year - 1}-11-03`}T09:00:00Z`;
}

const DEMO = [
  { at: lastThirdOfNovember(), message: "What does Neon's Launch plan cost, and what does Supabase Pro cost?" },
  { at: 'monday', message: 'Shortlist 5 CRM tools for a 20-person sales team, with per-seat pricing.' },
  { at: 'tuesday', message: 'Which managed Postgres hosting is cheapest for a small production app? Compare Neon, Supabase and Render.' },
]
  .map((turn) => ({ ...turn, now: resolveAt(turn.at, timeZone)! }))
  // Oldest first, so the history is written in the order it "happened".
  .sort((a, b) => a.now.localeCompare(b.now));

const missing = requiredKeys().filter((key) => !process.env[key]);
if (missing.length) {
  console.error(`Missing ${missing.join(' and ')}. Add to .env, then run again.`);
  process.exit(1);
}

console.log(`Adding ${DEMO.length} DEMO conversations to data/tally.db (timezone ${timeZone}).`);
console.log("Answers come from today's web; only the dates are in the past.\n");

// Marks a conversation as demo data. Done right after each question, so even
// a run that fails partway leaves nothing unlabeled behind.
function label(conversationId: string): void {
  const db = openDb(`${PROJECT}data/tally.db`);
  const title = db.getConversation(conversationId)?.conversation.title;
  if (title) db.renameConversation(conversationId, `[Demo] ${title}`);
  db.close();
}

for (const turn of DEMO) {
  const day = todayIn(timeZone, new Date(turn.now)).label;
  process.stdout.write(`${day}: ${turn.message} … `);
  const server = await startServer(PROJECT, turn.now);
  const conversationId = randomUUID();
  const reply = await ask(server.url, { conversationId, message: turn.message, timeZone });
  // Stopping waits for claim extraction to finish.
  await server.stop();
  label(conversationId);
  if (reply.error) {
    console.error(`failed: ${reply.error}`);
    process.exit(1);
  }
  console.log(`done (${(reply.total / 1000).toFixed(1)}s, ${reply.sources.length} sources)`);
}

console.log('\nDone. Start the app with `npm run dev` and try, in a new chat:');
console.log('  What did I ask you on 3 November? Is your answer still correct today?');
console.log('  On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?');
console.log('  Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?');
console.log('To remove the demo data, stop the server and delete the data/ folder.');
