import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitWithin, MAX_EDGE } from './image-prep.ts';

test('fitWithin scales the longest edge down to the limit and keeps the ratio', () => {
  assert.deepEqual(fitWithin(800, 600), { width: 800, height: 600 }, 'already small: untouched');
  assert.deepEqual(fitWithin(MAX_EDGE, 100), { width: MAX_EDGE, height: 100 });
  assert.deepEqual(fitWithin(3200, 1600), { width: 1600, height: 800 });
  assert.deepEqual(fitWithin(1500, 6000), { width: 400, height: 1600 });
  assert.deepEqual(fitWithin(10000, 1), { width: 1600, height: 1 }, 'never collapses to zero');
});
