export interface Source {
  n: number;
  title: string;
  url: string;
  // As reported by the search provider, when known. Becomes a claim's as_of.
  published?: string;
}

export type StreamEvent =
  | { type: 'status'; text: string }
  | { type: 'sources'; sources: Source[] }
  | { type: 'token'; text: string }
  | { type: 'done'; messageId: number }
  | { type: 'error'; message: string };

// NDJSON framing: one JSON object per line. The chat request is a POST, so the
// browser can't use EventSource and would parse SSE by hand anyway; JSON lines
// are the simpler format to parse. JSON.stringify escapes newlines inside
// strings, so an event can never span two lines.
export function encodeEvent(event: StreamEvent): string {
  return JSON.stringify(event) + '\n';
}
