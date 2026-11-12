import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { z } from 'zod';
import { describeError } from './lib/answer.ts';
import { openDb } from './lib/db.ts';
import { encodeEvent, type StreamEvent } from './lib/events.ts';
import { rememberClaims } from './lib/extract.ts';
import { PROVIDER, requiredKeys, rootError } from './lib/models.ts';
import { debug, stopwatch } from './lib/log.ts';
import { respond } from './lib/pipeline.ts';
import { createTavily, withCache } from './lib/search.ts';
import { isValidTimeZone, now, todayIn } from './lib/time.ts';

// Without these nothing can be answered, so refuse to start rather than fail
// on the first message with a less obvious error.
const missingKeys = requiredKeys().filter((key) => !process.env[key]);
if (missingKeys.length > 0) {
  console.error(`Missing ${missingKeys.join(' and ')}. Copy .env.example to .env, fill in the keys, and start again.`);
  process.exit(1);
}

// Relative to the working directory, so each eval case can run the server in
// its own folder with its own database.
const db = openDb('data/tally.db');
const search = withCache(createTavily(process.env.TAVILY_API_KEY!), db);
const app = new Hono();

// Work that outlives its request (claim extraction). Tracked so a restart
// finishes it instead of silently dropping the claims.
const background = new Set<Promise<unknown>>();
function inBackground(task: Promise<unknown>): void {
  background.add(task);
  void task.finally(() => background.delete(task));
}

const ChatRequest = z.object({
  conversationId: z.uuid(),
  message: z.string().trim().min(1).max(4000),
  timeZone: z.string().refine(isValidTimeZone, 'Unknown IANA timezone'),
});

app.post('/api/chat', async (c) => {
  const sinceRequest = stopwatch();
  const parsed = ChatRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: z.prettifyError(parsed.error) }, 400);
  const { conversationId, message, timeZone } = parsed.data;


  // The user's message is stored before streaming starts, so it is remembered
  // even if the answer fails or the user stops it.
  db.ensureConversation(conversationId, message);
  const userMessageId = db.addMessage(conversationId, 'user', message);

  c.header('Content-Type', 'application/x-ndjson; charset=utf-8');
  c.header('Cache-Control', 'no-cache');
  return stream(
    c,
    async (out) => {
      const elapsed = stopwatch();
      // Closing the tab or pressing Stop cancels the model call and any
      // in-flight searches, instead of paying for an answer nobody reads.
      const controller = new AbortController();
      out.onAbort(() => controller.abort());
      const send = async (event: StreamEvent) => {
        if (!out.aborted) await out.write(encodeEvent(event));
      };

      // Something visible right away, before any network call.
      await send({ type: 'status', text: 'Thinking…' });
      debug('first status %dms', sinceRequest());
      const result = await respond({
        db,
        search,
        conversationId,
        userMessageId,
        message,
        timeZone,
        emit: send,
        signal: controller.signal,
      });

      if (controller.signal.aborted) {
        debug('chat aborted by client after %dms', elapsed());
        return;
      }
      if (!result.text.trim()) {
        await send({ type: 'error', message: "I couldn't produce an answer to that. Please try rephrasing." });
        return;
      }
      // Only finished answers are stored: a half-written reply must never
      // become something the agent later "remembers" saying.
      const messageId = db.addMessage(conversationId, 'assistant', result.text, result.sources);
      await send({ type: 'done', messageId });

      // Off the critical path: the user already has the answer. Claims are
      // what a later "is that still correct?" re-checks; failing to extract
      // them costs only that, so errors are logged, never shown.
      inBackground(
        rememberClaims(db, messageId, {
          question: message,
          answer: result.text,
          sources: result.sources,
          answeredOn: todayIn(timeZone).iso,
        }).catch((error: unknown) => console.warn('Claim extraction failed:', error instanceof Error ? error.message : error)),
      );
    },
    async (error, out) => {
      if (out.aborted) return;
      // One line, not the SDK's full error object with every retry's stack.
      const root = rootError(error);
      console.error('chat failed:', root instanceof Error ? root.message : root);
      debug('chat failed: %o', error);
      await out.write(encodeEvent({ type: 'error', message: describeError(error) }));
    },
  );
});

app.get('/api/conversations', (c) => c.json(db.listConversations()));

app.get('/api/conversations/:id', (c) => {
  const found = db.getConversation(c.req.param('id'));
  return found ? c.json(found) : c.json({ error: 'Conversation not found' }, 404);
});

// Static files belong to the code, not to the working directory (which holds
// the data). serveStatic resolves against the working directory, hence relative().
const fromProject = (path: string) => relative(process.cwd(), fileURLToPath(new URL(`../${path}`, import.meta.url))) || '.';

// Browser builds of the markdown libraries are served straight from
// node_modules: versions are pinned by the lockfile and the app works offline.
app.get('/vendor/marked.js', serveStatic({ path: fromProject('node_modules/marked/lib/marked.esm.js') }));
app.get('/vendor/purify.js', serveStatic({ path: fromProject('node_modules/dompurify/dist/purify.es.mjs') }));
app.use('/*', serveStatic({ root: fromProject('public') }));

const port = Number(process.env.PORT ?? 3000);
if (process.env.NOW) console.log(`Clock pinned by NOW: ${now().toISOString()}`);
if (!db.fts) console.warn('SQLite FTS5 is unavailable; memory search falls back to LIKE.');

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Tally running at http://localhost:${info.port} (models: ${PROVIDER}${PROVIDER === 'gemini' && process.env.GROQ_API_KEY ? ', Groq fallback on quota errors' : ''})`);
});

const SHUTDOWN_GRACE_MS = 15_000;

// Stop taking requests, let background work finish (bounded), then close the
// database cleanly. Restarts and the eval runner rely on this.
async function shutdown(signal: string): Promise<void> {
  if (background.size > 0) console.log(`${signal}: finishing ${background.size} background task(s)…`);
  server.close();
  const grace = new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS).unref());
  await Promise.race([Promise.allSettled([...background]), grace]);
  db.close();
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
