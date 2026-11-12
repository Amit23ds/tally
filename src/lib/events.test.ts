import assert from 'node:assert/strict';
import { it } from 'node:test';
import { encodeEvent } from './events.ts';

it('encodes each event as exactly one line, even when the text has newlines', () => {
  const line = encodeEvent({ type: 'token', text: 'a\nb\n' });
  assert.equal(line.indexOf('\n'), line.length - 1);
  assert.deepEqual(JSON.parse(line), { type: 'token', text: 'a\nb\n' });
});
