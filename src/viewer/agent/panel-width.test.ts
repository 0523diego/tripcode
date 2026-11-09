import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clampWidth, maxWidthFor, MIN_WIDTH, parseWidth, widthAfterKey } from './panel-width.ts';

test('the widest the panel can be leaves room on the left, and is never below the minimum', () => {
  assert.equal(maxWidthFor(1440), 960, 'capped at 960 (70% would be 1008)');
  assert.equal(maxWidthFor(1000), 560, 'viewport − 440 beats 70%');
  assert.equal(maxWidthFor(1200), 760);
  assert.equal(maxWidthFor(600), MIN_WIDTH, 'a tiny window still gets the minimum');
});

test('clampWidth keeps a dragged width inside [minimum, maximum] and whole pixels', () => {
  assert.equal(clampWidth(100, 1440), MIN_WIDTH);
  assert.equal(clampWidth(5000, 1440), 960);
  assert.equal(clampWidth(500.6, 1440), 501);
  assert.equal(clampWidth(900, 1000), 560);
});

test('a saved width is only trusted when it is a plain sane number', () => {
  assert.equal(parseWidth('520'), 520);
  for (const bad of [null, '', 'abc', '-5', '12', '99999', '299', '961', '5e2', '340px']) assert.equal(parseWidth(bad), null, String(bad));
});

test('keys: Left widens, Right narrows, Home resets, others are ignored', () => {
  assert.equal(widthAfterKey(340, 'ArrowLeft', 1440), 364);
  assert.equal(widthAfterKey(340, 'ArrowRight', 1440), 316);
  assert.equal(widthAfterKey(MIN_WIDTH, 'ArrowRight', 1440), MIN_WIDTH, 'cannot go below the minimum');
  assert.equal(widthAfterKey(950, 'ArrowLeft', 1440), 960, 'cannot go above the maximum');
  assert.equal(widthAfterKey(500, 'Home', 1440), null);
  assert.equal(widthAfterKey(500, 'a', 1440), undefined);
});
