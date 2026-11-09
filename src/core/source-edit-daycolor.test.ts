import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setDayColor } from './source-edit.ts';

const src = `export default defineTrip({\n  days: [\n    {\n      date: '2026-11-21',\n      items: [],\n    },\n    {\n      date: '2026-11-22',\n      items: [],\n    },\n  ],\n});\n`;

describe('setDayColor', () => {
  test('adds, replaces and removes the color on that day only, touching nothing else', () => {
    const a = setDayColor(src, '2026-11-21', 3);
    assert.match(a, /date: '2026-11-21',[\s\S]*color: 3/);
    assert.equal((a.match(/color:/g) ?? []).length, 1, 'the other day is untouched');
    const b = setDayColor(a, '2026-11-21', 7);
    assert.match(b, /color: 7/);
    assert.doesNotMatch(b, /color: 3/);
    assert.equal(setDayColor(b, '2026-11-21', null), src, 'removing it gives back the original text');
  });
  test('two days can each have their own color', () => {
    const out = setDayColor(setDayColor(src, '2026-11-21', 2), '2026-11-22', 5);
    assert.equal((out.match(/color:/g) ?? []).length, 2);
  });
  test('a missing day, a bad date or a color outside 1–8 is refused', () => {
    assert.throws(() => setDayColor(src, '2026-12-01', 2), /找不到/);
    assert.throws(() => setDayColor(src, 'tomorrow', 2), /YYYY-MM-DD/);
    for (const bad of [0, 9, 2.5, -1, NaN]) assert.throws(() => setDayColor(src, '2026-11-21', bad), /1 到 8/, String(bad));
  });
});
