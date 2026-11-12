import { debuglog } from 'node:util';

// Built-in debug logging, switched on with NODE_DEBUG=tally. It is a no-op
// otherwise, so stage timings can stay in the hot path at no cost.
export const debug = debuglog('tally');

export function stopwatch(): () => number {
  const start = performance.now();
  return () => Math.round(performance.now() - start);
}
