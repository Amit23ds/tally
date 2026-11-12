import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';

// Scripted stand-ins for the fast and strong models, so the pipeline runs
// end to end in tests without network calls.

// The provider-level stream part type, derived from the mock rather than
// imported from @ai-sdk/provider, which is not a direct dependency.
type StreamPart = Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer P> ? P : never;

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function step(parts: StreamPart[], finish: 'tool-calls' | 'stop') {
  return {
    stream: convertArrayToReadableStream<StreamPart>([
      { type: 'stream-start', warnings: [] },
      ...parts,
      { type: 'finish', finishReason: { unified: finish, raw: undefined }, usage },
    ]),
  };
}

// A model step that calls web_search once per query, in parallel.
export const searchStep = (...queries: string[]) =>
  step(
    queries.map((query, i) => ({ type: 'tool-call', toolCallId: `call-${i}`, toolName: 'web_search', input: JSON.stringify({ query }) })),
    'tool-calls',
  );

// A model step that writes `text` and stops.
export const textStep = (text: string) =>
  step(
    [
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: text },
      { type: 'text-end', id: 't' },
    ],
    'stop',
  );

// A fast-model stand-in that returns `output` as structured output (a plan,
// extracted claims), or fails with it. `during` runs while the "request" is
// in flight.
export function structuredModel(output: object | Error, during?: () => Promise<void>): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async () => {
      await during?.();
      if (output instanceof Error) throw output;
      return {
        content: [{ type: 'text', text: JSON.stringify(output) }],
        finishReason: { unified: 'stop', raw: undefined },
        usage,
        warnings: [],
      };
    },
  });
}
