import { Output, generateText, type LanguageModel } from 'ai';
import { z } from 'zod';
import { debug } from './log.ts';
import { fast } from './models.ts';
import { PLANNER_SYSTEM_PROMPT, plannerInput } from './prompts.ts';
import type { DateRange } from './time.ts';
import { todayIn } from './time.ts';

export const MAX_QUERIES = 6;
// The planner sits in front of every answer. If it is slow or down, answering
// without a plan beats making the user wait.
const PLANNER_TIMEOUT_MS = 6_000;

const Intent = z.enum(['chat', 'lookup', 'memory', 'memory_then_verify']);

// What the model fills in. Only plain types: no nullable unions or patterns,
// which Gemini's schema support doesn't reliably cover. "No date" is an empty
// string, and limits such as "at most 6 queries" are enforced in
// normalizePlan(), where a trim is cheaper than a rejected request.
export const PlanSchema = z.object({
  intent: Intent.describe('What kind of answer the message needs.'),
  needs_search: z.boolean().describe('Whether current web information is needed.'),
  entities: z.array(z.string()).describe('Products, companies, people or topics the message is about.'),
  since: z.string().describe('YYYY-MM-DD copied from "Dates in the message", or an empty string.'),
  queries: z.array(z.string()).describe('Up to 6 specific web searches.'),
});

export interface Plan {
  intent: z.infer<typeof Intent>;
  needs_search: boolean;
  entities: string[];
  // YYYY-MM-DD, always one of the dates resolved from the message.
  since?: string;
  queries: string[];
}

// Used when planning fails: no pre-search, but the answer model keeps its
// web_search tool, so it can still decide to look things up itself.
export const FALLBACK_PLAN: Plan = { intent: 'lookup', needs_search: false, entities: [], queries: [] };

// Obvious small talk ("thanks!", "hi there", "ok cool") skips the planner
// round trip. Deliberately narrow: anything with a question mark, a number or
// more than three words goes to the planner, because sending a real question
// down the chat path would forbid the search it needs.
const SMALL_TALK = /^(hi|hello|hey|yo|thanks|thank you|thx|cheers|ok|okay|cool|great|nice|perfect|bye|goodbye|good (morning|afternoon|evening|night))\b/i;

export function smallTalkPlan(message: string): Plan | undefined {
  const text = message.trim();
  if (text.split(/\s+/).length > 3 || /[?\d]/.test(text) || !SMALL_TALK.test(text)) return undefined;
  return { intent: 'chat', needs_search: false, entities: [], queries: [] };
}

export interface PlanOptions {
  message: string;
  // Earlier turns of this conversation, oldest first, without the new message.
  recent: Array<{ role: string; content: string }>;
  dates: DateRange[];
  timeZone: string;
  signal: AbortSignal;
  model?: LanguageModel;
}

export async function makePlan({ message, recent, dates, timeZone, signal, model }: PlanOptions): Promise<Plan> {
  const today = todayIn(timeZone);
  try {
    const { output } = await generateText({
      model: model ?? fast.model(),
      instructions: PLANNER_SYSTEM_PROMPT,
      prompt: plannerInput({
        todayLabel: today.label,
        todayIso: today.iso,
        timeZone,
        dates: dates.map(describeRange),
        // Enough to resolve "them" and "it"; long answers are cut short.
        recent: recent.slice(-6).map((m) => ({ role: m.role, content: clip(m.content, 400) })),
        message,
      }),
      output: Output.object({ schema: PlanSchema }),
      maxOutputTokens: 1_000,
      abortSignal: AbortSignal.any([signal, AbortSignal.timeout(PLANNER_TIMEOUT_MS)]),
      providerOptions: fast.providerOptions,
    });
    return normalizePlan(output, dates);
  } catch (error) {
    if (signal.aborted) throw error;
    console.warn('Planning failed, answering without a plan:', error instanceof Error ? error.message : error);
    return FALLBACK_PLAN;
  }
}

function describeRange(range: DateRange): string {
  return `"${range.phrase}" = ${range.date} (${range.label})${range.alternative ? ', or possibly this one' : ''}`;
}

// Turns what the model returned into a plan the pipeline can trust.
export function normalizePlan(raw: z.infer<typeof PlanSchema>, dates: DateRange[]): Plan {
  const unique = (items: string[], max: number) => {
    const seen = new Set<string>();
    return items
      .map((item) => item.trim())
      .filter((item) => item && !seen.has(item.toLowerCase()) && seen.add(item.toLowerCase()))
      .slice(0, max);
  };

  const searches = raw.intent !== 'chat' && raw.needs_search;
  // The date must be one code resolved from the message: the planner may pick
  // a date, never invent or calculate one.
  const since = raw.since && dates.some((d) => d.date === raw.since) ? raw.since : undefined;
  if (raw.since && !since) debug('plan: dropped since=%s, not a date from the message', raw.since);

  return {
    intent: raw.intent,
    needs_search: searches,
    entities: unique(raw.entities, 10),
    ...(since && { since }),
    queries: searches ? unique(raw.queries, MAX_QUERIES) : [],
  };
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
