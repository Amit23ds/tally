import { Output, generateText, type LanguageModel } from 'ai';
import { z } from 'zod';
import type { ClaimInput, Db } from './db.ts';
import type { Source } from './events.ts';
import { debug, stopwatch } from './log.ts';
import { fast } from './models.ts';
import { EXTRACT_SYSTEM_PROMPT, extractInput } from './prompts.ts';

const MAX_CLAIMS = 12;
// Nobody waits on extraction, but a hung request shouldn't linger forever.
const EXTRACT_TIMEOUT_MS = 30_000;

// The model names which citation backs each value; code looks up the URL and
// date, so a claim can't point at a page the answer never used. "No source" is
// 0 rather than null, keeping the schema to plain types Gemini supports.
export const ExtractedSchema = z.object({
  claims: z.array(
    z.object({
      entity: z.string(),
      attribute: z.string(),
      value: z.string(),
      source: z.number().describe('The [n] citation number for this value, or 0 if none.'),
    }),
  ),
});

type Extracted = z.infer<typeof ExtractedSchema>['claims'];

export interface ExtractOptions {
  question: string;
  answer: string;
  sources: Source[];
  // YYYY-MM-DD in the user's timezone: when the answer was given.
  answeredOn: string;
  model?: LanguageModel;
}

export async function extractClaims({ question, answer, sources, answeredOn, model }: ExtractOptions): Promise<ClaimInput[]> {
  const { output } = await generateText({
    model: model ?? fast.model(),
    instructions: EXTRACT_SYSTEM_PROMPT,
    prompt: extractInput({ question, answer, sources }),
    output: Output.object({ schema: ExtractedSchema }),
    maxOutputTokens: 2_000,
    abortSignal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS),
    providerOptions: fast.providerOptions,
  });
  return normalizeClaims(output.claims, sources, answeredOn);
}

// Runs after the answer is delivered and is never awaited by the request, so
// the user doesn't wait for it.
export async function rememberClaims(db: Db, messageId: number, options: ExtractOptions): Promise<number> {
  // Without sources the answer stated nothing from the web, and the answer
  // prompt forbids current specifics from memory: nothing worth re-checking.
  if (options.sources.length === 0) return 0;
  const elapsed = stopwatch();
  const claims = await extractClaims(options);
  db.addClaims(messageId, claims);
  debug('extract %dms, %d claims for message %d', elapsed(), claims.length, messageId);
  return claims.length;
}

export function normalizeClaims(raw: Extracted, sources: Source[], answeredOn: string): ClaimInput[] {
  const byNumber = new Map(sources.map((source) => [source.n, source]));
  const seen = new Set<string>();
  const claims: ClaimInput[] = [];
  for (const claim of raw) {
    const entity = claim.entity.trim();
    const attribute = claim.attribute.trim();
    const value = claim.value.trim();
    const key = `${entity}|${attribute}`.toLowerCase();
    if (!entity || !attribute || !value || seen.has(key)) continue;
    seen.add(key);
    // 0, or any number that isn't one of the answer's citations, means no source.
    const source = byNumber.get(claim.source);
    claims.push({
      entity,
      attribute,
      value,
      source_url: source?.url ?? null,
      // What we know held on a given day: the source's publish date if known,
      // otherwise the day the answer was given (when the page was read).
      as_of: publishedDay(source?.published) ?? answeredOn,
    });
  }
  return claims.slice(0, MAX_CLAIMS);
}

// Providers report publish dates in assorted formats; keep the calendar date.
function publishedDay(published: string | undefined): string | undefined {
  if (!published) return undefined;
  const time = Date.parse(published);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString().slice(0, 10);
}
