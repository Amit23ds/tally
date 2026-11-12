import type { LanguageModel } from 'ai';
import { RESULTS_PER_SEARCH, answer, type Answer, type PreSearch } from './answer.ts';
import type { Db } from './db.ts';
import type { StreamEvent } from './events.ts';
import { debug, stopwatch } from './log.ts';
import { MAX_QUERIES, makePlan, smallTalkPlan, type Plan } from './plan.ts';
import { claimChecks, formatRecord, keywords, mergeRecalled, recall, type ClaimCheck } from './recall.ts';
import type { SearchProvider } from './search.ts';
import { dayLabel, resolveDates, todayIn } from './time.ts';

// Enough context to follow the thread; older turns come back through recall.
const HISTORY_MESSAGES = 20;

export interface RespondOptions {
  db: Db;
  search: SearchProvider;
  conversationId: string;
  // The stored user message being answered; recall treats it as "now".
  userMessageId: number;
  message: string;
  timeZone: string;
  emit: (event: StreamEvent) => Promise<void>;
  signal: AbortSignal;
  // Injected by tests.
  models?: { fast?: LanguageModel; smart?: LanguageModel };
}

// Milliseconds since the request started; plan and recall overlap.
export interface Timings {
  plan: number;
  recall: number;
  search: number;
  firstToken?: number;
  total: number;
}

export async function respond(options: RespondOptions): Promise<Answer & { plan: Plan; timings: Timings }> {
  const { db, search, conversationId, userMessageId, message, timeZone, emit, signal, models } = options;
  const elapsed = stopwatch();
  const today = todayIn(timeZone);
  const dates = resolveDates(message, timeZone);
  const history = db.recentMessages(conversationId, HISTORY_MESSAGES);

  // Planning waits on the network; recall is local SQLite and takes
  // milliseconds. Starting the planner request first and recalling while it
  // is in flight means recall adds nothing to the wait.
  let planMs = 0;
  const quick = smallTalkPlan(message);
  const planning = quick
    ? Promise.resolve(quick)
    : makePlan({ message, recent: history.slice(0, -1), dates, timeZone, signal, model: models?.fast }).then((plan) => {
        planMs = elapsed();
        return plan;
      });
  // The SDK takes a few internal awaits before the request leaves. Yielding
  // one macrotask lets it get there; otherwise synchronous SQLite would run
  // first and delay the request it was meant to overlap with.
  await new Promise((resolve) => setImmediate(resolve));
  const recallTimer = stopwatch();
  const base = { db, beforeMessageId: userMessageId, todayIso: today.iso };
  const fromMessage = recall({ ...base, terms: keywords(message), dates });
  let recallMs = recallTimer();

  const plan = await planning;
  // Second pass with the planner's entities, which include what "them" or
  // "it" refer to in this conversation.
  const secondTimer = stopwatch();
  const recalled = plan.entities.length > 0 ? mergeRecalled(fromMessage, recall({ ...base, terms: plan.entities, dates: [] })) : fromMessage;
  recallMs += secondTimer();

  // "Is that still correct?": each old claim is re-checked first, against
  // pages published since that answer; the planner's queries fill any room left.
  const verify = plan.intent === 'memory_then_verify' && recalled.turns.length > 0;
  const planned: PlannedSearch[] = [
    ...(verify ? claimChecks(recalled, timeZone, MAX_QUERIES) : []),
    ...plan.queries.map((query) => ({ query })),
  ];
  const searchTimer = stopwatch();
  const searches = plan.intent === 'chat' ? [] : await runSearches(search, uniqueSearches(planned), emit, signal);
  const searchMs = searchTimer();

  const answerStart = elapsed();
  const record = formatRecord(recalled, { timeZone, intent: plan.intent });
  const result = await answer({
    messages: history,
    context: {
      todayLabel: today.label,
      todayIso: today.iso,
      timeZone,
      ...(plan.since && { sinceLabel: dayLabel(plan.since) }),
      ...(record && { record }),
      ...(verify && { verify }),
    },
    searches,
    allowSearch: plan.intent !== 'chat',
    search,
    emit,
    signal,
    ...(models?.smart && { model: models.smart }),
  });

  const timings: Timings = {
    plan: planMs,
    recall: recallMs,
    search: searchMs,
    ...(result.firstTokenMs !== undefined && { firstToken: answerStart + result.firstTokenMs }),
    total: elapsed(),
  };
  debug(
    'intent=%s queries=%d recalled=%d missing=%d | plan %dms, recall %dms, search %dms, first token %sms, total %dms',
    plan.intent,
    searches.length,
    recalled.turns.length,
    recalled.missing.length,
    timings.plan,
    timings.recall,
    timings.search,
    timings.firstToken ?? '-',
    timings.total,
  );
  return { ...result, plan, timings };
}

type PlannedSearch = { query: string } & Partial<Pick<ClaimCheck, 'startDate'>>;

function uniqueSearches(planned: PlannedSearch[]): PlannedSearch[] {
  const seen = new Set<string>();
  return planned.filter(({ query }) => !seen.has(query.toLowerCase()) && Boolean(seen.add(query.toLowerCase()))).slice(0, MAX_QUERIES);
}

// All planned queries at once: total wait is the slowest search, not the sum.
// A failed query is dropped rather than failing the answer.
async function runSearches(
  search: SearchProvider,
  planned: PlannedSearch[],
  emit: (event: StreamEvent) => Promise<void>,
  signal: AbortSignal,
): Promise<PreSearch[]> {
  if (planned.length === 0) return [];
  await emit({ type: 'status', text: `Searching: ${planned.map((p) => p.query).join(' · ')}` });
  const settled = await Promise.allSettled(planned.map((p) => runOne(search, p, signal)));
  signal.throwIfAborted();
  return settled.flatMap((outcome, i) => {
    if (outcome.status === 'fulfilled') return [outcome.value];
    console.warn(`Search failed for "${planned[i]!.query}":`, outcome.reason instanceof Error ? outcome.reason.message : outcome.reason);
    return [];
  });
}

// A date-limited search drops undated pages (most pricing pages). If that
// leaves nothing, one unfiltered retry is better than no evidence at all.
async function runOne(search: SearchProvider, { query, startDate }: PlannedSearch, signal: AbortSignal): Promise<PreSearch> {
  const request = { query, maxResults: RESULTS_PER_SEARCH, signal };
  if (startDate) {
    const results = await search.search({ ...request, startDate });
    if (results.length > 0) return { query, startDate, results };
    debug('no results since %s, retrying without a date: %s', startDate, query);
  }
  return { query, results: await search.search(request) };
}
