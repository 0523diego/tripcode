import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commentState, markerPresent, normalizeText, snippet, type SentComment } from './comment-log.ts';

const src = [
  'export default defineTrip({',
  '  days: [{',
  '    // @trip-comment(item): 改到下午 再去',
  "    { id: 'a' },",
  '  }],',
  '});',
].join('\n');

test('markerPresent matches on normalized text', () => {
  assert.equal(markerPresent(src, '改到下午   再去'), true);
  assert.equal(markerPresent(src, '改到早上'), false);
  assert.equal(markerPresent('// @trip-comment(day): x\r\n', 'x'), true);
});

test('snippet trims and truncates', () => {
  assert.equal(normalizeText(' a \n b '), 'a b');
  assert.equal(snippet('x'.repeat(40), 10), `${'x'.repeat(10)}…`);
  assert.equal(snippet('短', 10), '短');
});

test('commentState: waiting while the marker exists, maybe-applied once it is gone', () => {
  const c: SentComment = { at: 1, file: 'trip.ts', target: 'A', text: '改到下午 再去' };
  assert.equal(commentState(c, { 'trip.ts': src }), 'waiting');
  assert.equal(commentState(c, { 'trip.ts': 'export default {};' }), 'maybe-applied');
  assert.equal(commentState(c, {}), 'unknown');
  assert.equal(commentState(c, { 'trip.ts': null }), 'unknown');
});
