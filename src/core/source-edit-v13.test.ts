import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { removeItem, setLocked } from './source-edit.ts';

function evalTrip(src: string): any {
  const body = src.replace(/^import .*$/m, '').replace(/export default defineTrip\(/, 'return (');
  return new Function(body)();
}
const ids = (src: string, day: number): string[] => evalTrip(src).days[day].items.map((i: any) => i.id);

const BASE = `import { defineTrip } from '../../src/core/types.ts';

export default defineTrip({
  title: 'Trip {x}',
  days: [
    {
      date: '2026-06-14',
      items: [
        {
          id: 'a',
          kind: 'free',
          title: 'A } "tricky" {',
        },
        // @trip-comment(item): hello B
        // @trip-comment(item): second
        { id: 'b', kind: 'free', title: 'B' },
        // an ordinary note about c
        {
          id: 'c',
          kind: 'poi',
          title: 'C',
          locked: true,
          loc: { lat: 1, lng: 2 }, // trailing
        },
      ],
    },
    {
      date: '2026-06-15',
      items: [
        // @trip-comment(item): only one
        {
          id: 'solo',
          kind: 'free',
          title: 'Solo',
        },
      ],
    },
    {
      date: '2026-06-16',
      items: [
        { id: 'x', kind: 'free', title: 'X' },
        { id: 'y', kind: 'free', title: 'Y' }
      ]
    },
  ],
  candidates: [
    { id: 'cand', title: 'Cand', status: 'unconfirmed', sources: [] },
  ],
});
`;

describe('removeItem', () => {
  test('first item', () => {
    const out = removeItem(BASE, 'a');
    assert.deepEqual(ids(out, 0), ['b', 'c']);
    assert.ok(!out.includes("id: 'a'"));
    assert.ok(out.includes('// @trip-comment(item): hello B'));
  });

  test('middle item takes its attached @trip-comment lines with it, not a plain comment', () => {
    const out = removeItem(BASE, 'b');
    assert.deepEqual(ids(out, 0), ['a', 'c']);
    assert.ok(!out.includes('hello B') && !out.includes('second'));
    assert.ok(out.includes('// an ordinary note about c'));
  });

  test('last item (with trailing comma) keeps the rest byte-identical', () => {
    const out = removeItem(BASE, 'c');
    assert.deepEqual(ids(out, 0), ['a', 'b']);
    // The plain comment above c is not an attached @trip-comment, so it stays.
    assert.ok(out.includes('// an ordinary note about c'));
    assert.equal(out.length < BASE.length, true);
  });

  test('last item without a trailing comma drops the previous comma', () => {
    const out = removeItem(BASE, 'y');
    assert.deepEqual(ids(out, 2), ['x']);
    assert.match(out, /\{ id: 'x', kind: 'free', title: 'X' \}\n {6}\]/);
    assert.equal(evalTrip(out).days.length, 3);
  });

  test('middle of a no-trailing-comma list: first of two', () => {
    const out = removeItem(BASE, 'x');
    assert.deepEqual(ids(out, 2), ['y']);
  });

  test('only item (with its comment) leaves an empty items array', () => {
    const out = removeItem(BASE, 'solo');
    assert.deepEqual(ids(out, 1), []);
    assert.match(out, /date: '2026-06-15',\n {6}items: \[\],/);
    assert.ok(!out.includes('only one'));
    assert.deepEqual(ids(out, 0), ['a', 'b', 'c']);
  });

  test('everything else is byte-identical', () => {
    const out = removeItem(BASE, 'solo');
    const start = BASE.indexOf("    {\n      date: '2026-06-15'");
    assert.equal(out.slice(0, start), BASE.slice(0, start));
    const tailAt = BASE.indexOf("    {\n      date: '2026-06-16'");
    assert.equal(out.slice(out.length - (BASE.length - tailAt)), BASE.slice(tailAt));
  });

  test('works with CRLF files', () => {
    const crlf = BASE.replace(/\n/g, '\r\n');
    const out = removeItem(crlf, 'b');
    assert.deepEqual(ids(out, 0), ['a', 'c']);
    assert.ok(!out.replace(/\r\n/g, '').includes('\n'));
  });

  test('unknown id and candidate ids throw', () => {
    assert.throws(() => removeItem(BASE, 'nope'), /找不到/);
    assert.throws(() => removeItem(BASE, 'cand'), /候選地點/);
  });

  test('removing every item one by one never breaks the file', () => {
    let s = BASE;
    for (const id of ['a', 'b', 'c', 'solo', 'x', 'y']) s = removeItem(s, id);
    assert.deepEqual([0, 1, 2].map((d) => ids(s, d)), [[], [], []]);
    assert.equal(evalTrip(s).candidates.length, 1);
  });
});

describe('setLocked', () => {
  test('inserts locked: true after id when missing, leaving other bytes alone', () => {
    const out = setLocked(BASE, 'a', true);
    assert.equal(evalTrip(out).days[0].items[0].locked, true);
    assert.equal(out.replace("id: 'a',\n          locked: true,\n", "id: 'a',\n"), BASE);
    assert.match(out, /id: 'a',\n {10}locked: true,\n {10}kind: 'free'/);
  });

  test('inline object gets the property inline', () => {
    const out = setLocked(BASE, 'b', true);
    assert.match(out, /\{ id: 'b', locked: true, kind: 'free', title: 'B' \}/);
  });

  test('false removes the property entirely', () => {
    const out = setLocked(BASE, 'c', false);
    assert.equal('locked' in evalTrip(out).days[0].items[2], false);
    assert.ok(!out.includes('locked'));
    assert.equal(out, BASE.replace('          locked: true,\n', ''));
  });

  test('false when absent and true when already true are byte-identical no-ops', () => {
    assert.equal(setLocked(BASE, 'a', false), BASE);
    assert.equal(setLocked(BASE, 'c', true), BASE);
  });

  test('true -> false -> true round-trips to an equivalent item', () => {
    const out = setLocked(setLocked(BASE, 'b', true), 'b', false);
    assert.equal(out, BASE);
  });

  test('only touches the target item', () => {
    const out = setLocked(BASE, 'x', true);
    assert.equal(evalTrip(out).days[2].items[1].locked, undefined);
    assert.deepEqual(ids(out, 2), ['x', 'y']);
  });

  test('unknown id, candidate id and non-boolean throw', () => {
    assert.throws(() => setLocked(BASE, 'nope', true), /找不到/);
    assert.throws(() => setLocked(BASE, 'cand', true), /候選地點/);
    assert.throws(() => setLocked(BASE, 'a', 'yes' as never), /布林/);
  });
});
