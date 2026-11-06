import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COVER_MAX_BYTES, COVER_MAX_SIDE, fitWithin } from './cover-fit.ts';

test('a big landscape photo is scaled so the long side is 1200', () => {
  assert.deepEqual(fitWithin(4032, 3024), { width: 1200, height: 900 });
});

test('a portrait photo is limited by its height', () => {
  assert.deepEqual(fitWithin(3024, 4032), { width: 900, height: 1200 });
});

test('a small picture is never scaled up', () => {
  assert.deepEqual(fitWithin(640, 480), { width: 640, height: 480 });
});

test('extreme shapes never collapse to zero', () => {
  assert.deepEqual(fitWithin(10000, 1), { width: 1200, height: 1 });
});

test('the byte limit leaves room under the server limit (700 KB)', () => {
  assert.ok(COVER_MAX_BYTES < 700 * 1024);
  assert.equal(COVER_MAX_SIDE, 1200);
});
