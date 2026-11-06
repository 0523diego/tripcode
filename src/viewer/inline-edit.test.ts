import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_TITLE, inlineProblem, normalizeInline, normalizeTime } from './inline-edit.ts';

test('normalizeTime accepts the ways people type a time', () => {
  for (const [raw, want] of [
    ['09:30', '09:30'],
    ['9:30', '09:30'],
    ['930', '09:30'],
    ['0930', '09:30'],
    [' 9.30 ', '09:30'],
    ['９：３０', '09:30'],
    ['23:59', '23:59'],
    ['00:00', '00:00'],
  ] as const) {
    assert.equal(normalizeTime(raw), want, raw);
  }
});

test('normalizeTime rejects what is not a time', () => {
  for (const raw of ['', '24:00', '12:60', '9', '12:5', 'abc', '12:30pm', '1:2:3']) assert.equal(normalizeTime(raw), null, raw);
});

test('titles are trimmed and kept to one line; empty or too long is refused', () => {
  assert.equal(normalizeInline('title', '  淺草寺  '), '淺草寺');
  assert.equal(normalizeInline('title', '淺草寺\n雷門\t 前'), '淺草寺 雷門 前');
  assert.equal(normalizeInline('title', '   '), null);
  assert.equal(normalizeInline('title', 'x'.repeat(MAX_TITLE)), 'x'.repeat(MAX_TITLE));
  assert.equal(normalizeInline('title', 'x'.repeat(MAX_TITLE + 1)), null);
  assert.equal(normalizeInline('time', '930'), '09:30');
});

test('inlineProblem explains the refusal', () => {
  assert.match(inlineProblem('title', ' '), /不可為空/);
  assert.match(inlineProblem('title', 'x'.repeat(200)), /最多 120/);
  assert.match(inlineProblem('time', 'zz'), /09:30/);
});
