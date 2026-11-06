import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { insertItem, moveItem, scheduleCandidate } from './source-edit.ts';

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
          note: \`multi
  line { text
\`,
        },
        // @trip-comment(item): hello B
        // @trip-comment(item): second
        { id: 'b', kind: 'free', title: 'B' },
        // an ordinary note about c
        {
          id: 'c',
          kind: 'poi',
          title: 'C',
          loc: { lat: 1, lng: 2 }, // trailing
          attachments: [{ file: 'tickets/x.pdf', label: 'X' }],
        },
      ],
    },
    { date: '2026-06-15', items: [] },
    {
      date: '2026-06-16',
      items: [
        {
          id: 'd',
          kind: 'free',
          title: 'D'
        }
      ]
    },
  ],
  candidates: [
    // @trip-comment(item): nice place
    {
      id: 'cand',
      title: 'Cand {',
      placeId: 'p1',
      loc: { lat: 3, lng: 4, fetchedAt: '2026-01-01T00:00:00.000Z' },
      status: 'unconfirmed',
      day: 2,
      sources: ['inbox/01.md'],
      why: 'because "x"',
    },
    { id: 'cand2', title: 'Two', status: 'unconfirmed', sources: [] }
  ],
});
`;

describe('moveItem', () => {
  test('within the same day: up, down, to end', () => {
    assert.deepEqual(ids(moveItem(BASE, 'c', '2026-06-14', 'a'), 0), ['c', 'a', 'b']);
    assert.deepEqual(ids(moveItem(BASE, 'a', '2026-06-14', 'c'), 0), ['b', 'a', 'c']);
    assert.deepEqual(ids(moveItem(BASE, 'a', '2026-06-14'), 0), ['b', 'c', 'a']);
    assert.deepEqual(ids(moveItem(BASE, 'c', '2026-06-14', null), 0), ['a', 'b', 'c']);
  });

  test('no-ops return the identical string', () => {
    assert.equal(moveItem(BASE, 'a', '2026-06-14', 'b'), BASE);
    assert.equal(moveItem(BASE, 'c', '2026-06-14'), BASE);
    assert.equal(moveItem(BASE, 'd', '2026-06-16'), BASE);
  });

  test('comment lines stay attached; plain comments stay put', () => {
    const out = moveItem(BASE, 'b', '2026-06-14');
    assert.deepEqual(ids(out, 0), ['a', 'c', 'b']);
    assert.match(out, /\/\/ @trip-comment\(item\): hello B\n {8}\/\/ @trip-comment\(item\): second\n {8}\{ id: 'b'/);
    assert.match(out, /\/\/ an ordinary note about c\n {8}\{\n {10}id: 'c'/);
    // moving c before b: c's plain comment is left behind
    const out2 = moveItem(BASE, 'c', '2026-06-14', 'b');
    assert.deepEqual(ids(out2, 0), ['a', 'c', 'b']);
    assert.match(out2, /\n {8}\{\n {10}id: 'c'[\s\S]*?\},\n {8}\/\/ @trip-comment\(item\): hello B/);
  });

  test('inserting before an item with comments keeps those comments with that item', () => {
    const out = moveItem(BASE, 'c', '2026-06-14', 'b');
    const iB = out.indexOf("id: 'b'");
    const iC = out.indexOf("id: 'c'");
    assert.ok(iC < out.indexOf('hello B') && out.indexOf('hello B') < iB);
  });

  test('cross-day into an empty inline array and into a no-trailing-comma day', () => {
    const out = moveItem(BASE, 'a', '2026-06-15');
    assert.deepEqual(ids(out, 0), ['b', 'c']);
    assert.deepEqual(ids(out, 1), ['a']);
    assert.match(out, /date: '2026-06-15', items: \[\n {8}\{\n {10}id: 'a',/);
    assert.equal(evalTrip(out).days[1].items[0].note, 'multi\n  line { text\n');
    assert.equal(evalTrip(out).days[1].items[0].title, 'A } "tricky" {');

    const out2 = moveItem(BASE, 'b', '2026-06-16');
    assert.deepEqual(ids(out2, 2), ['d', 'b']);
    assert.match(out2, /title: 'D'\n {8}\},\n {8}\/\/ @trip-comment\(item\): hello B[\s\S]*\{ id: 'b', kind: 'free', title: 'B' \}\n {6}\]/);
    const out3 = moveItem(BASE, 'b', '2026-06-16', 'd');
    assert.deepEqual(ids(out3, 2), ['b', 'd']);
  });

  test('moving the last no-comma element out strips the previous comma', () => {
    const out = moveItem(BASE, 'd', '2026-06-14', 'a');
    assert.deepEqual(ids(out, 2), []);
    assert.deepEqual(ids(out, 0), ['d', 'a', 'b', 'c']);
    const back = moveItem(out, 'b', '2026-06-16');
    assert.deepEqual(ids(back, 2), ['b']);
  });

  test('re-indents to the target and keeps byte content of the block', () => {
    const deep = BASE.replace(/\n {6}items: \[\n {8}\{\n {10}id: 'd'/, "\n      items: [\n        {\n          id: 'd'");
    const out = moveItem(BASE, 'c', '2026-06-16', 'd');
    assert.ok(out.includes("        {\n          id: 'c',\n          kind: 'poi',\n          title: 'C',\n          loc: { lat: 1, lng: 2 }, // trailing\n"));
    assert.ok(deep.length > 0);
    // multi-line template literal contents are not re-indented
    const deeper = BASE.replace("date: '2026-06-15', items: []", "date: '2026-06-15',\n      items: [\n            { id: 'z', kind: 'free', title: 'Z' },\n      ]");
    const o = moveItem(deeper, 'a', '2026-06-15', 'z');
    assert.equal(evalTrip(o).days[1].items[0].note, 'multi\n  line { text\n');
  });

  test('CRLF files keep CRLF', () => {
    const crlf = BASE.replace(/\n/g, '\r\n');
    const out = moveItem(crlf, 'a', '2026-06-14');
    assert.deepEqual(ids(out, 0), ['b', 'c', 'a']);
    assert.equal(out.replace(/\r\n/g, ''), out.replace(/\r\n/g, '').replace(/\n/g, ''));
    assert.ok(!/[^\r]\n/.test(out));
  });

  test('errors', () => {
    assert.throws(() => moveItem(BASE, 'nope', '2026-06-14'), /找不到 id/);
    assert.throws(() => moveItem(BASE, 'cand', '2026-06-14'), /候選地點/);
    assert.throws(() => moveItem(BASE, 'a', '2030-01-01'), /找不到日期/);
    assert.throws(() => moveItem(BASE, 'a', '2026-06-14', 'a'), /自己前面/);
    assert.throws(() => moveItem(BASE, 'a', '2026-06-15', 'd'), /不在 2026-06-15/);
    assert.throws(() => moveItem(BASE, 'a', '2026-06-14', 'ghost'), /不在/);
  });

  test('every other byte is untouched (round trip)', () => {
    const out = moveItem(moveItem(BASE, 'a', '2026-06-15'), 'a', '2026-06-14', 'b');
    assert.equal(out, BASE);
  });
});

describe('insertItem', () => {
  const item = { id: 'new-one', kind: 'poi', title: "It's {x}", loc: { lat: 1.5, lng: -2, fetchedAt: '2026-05-01T00:00:00.000Z' }, placeId: 'p', tags: ['a', 'b'] };

  test('serializes objects in file style, at the end or before an item', () => {
    const out = insertItem(BASE, '2026-06-14', item);
    assert.deepEqual(ids(out, 0), ['a', 'b', 'c', 'new-one']);
    assert.ok(out.includes("        {\n          id: 'new-one',\n          kind: 'poi',\n          title: 'It\\'s {x}',\n          loc: { lat: 1.5, lng: -2, fetchedAt: '2026-05-01T00:00:00.000Z' },\n          placeId: 'p',\n          tags: ['a', 'b'],\n        },\n      ],"));
    assert.deepEqual(evalTrip(out).days[0].items[3], item);
    const b = insertItem(BASE, '2026-06-14', item, 'b');
    assert.deepEqual(ids(b, 0), ['a', 'new-one', 'b', 'c']);
    assert.ok(b.indexOf('new-one') < b.indexOf('hello B'));
  });

  test('empty day and no-trailing-comma day', () => {
    assert.deepEqual(ids(insertItem(BASE, '2026-06-15', item), 1), ['new-one']);
    const out = insertItem(BASE, '2026-06-16', item);
    assert.deepEqual(ids(out, 2), ['d', 'new-one']);
    assert.match(out, /title: 'D'\n {8}\},\n {8}\{\n {10}id: 'new-one'[\s\S]*?\n {8}\}\n {6}\]/);
  });

  test('accepts a source literal and re-indents it', () => {
    const out = insertItem(BASE, '2026-06-15', `{\n    id: 'lit',\n    kind: 'free',\n    title: 'Lit',\n  }`);
    assert.deepEqual(ids(out, 1), ['lit']);
    assert.ok(out.includes("        {\n          id: 'lit',\n          kind: 'free',\n          title: 'Lit',\n        },"));
    assert.throws(() => insertItem(BASE, '2026-06-15', "{ id: 'x', kind: 'free', title: 'X' } extra"), /單一/);
  });

  test('validates id, uniqueness, date and anchor', () => {
    assert.throws(() => insertItem(BASE, '2026-06-14', { ...item, id: 'a' }), /已存在/);
    assert.throws(() => insertItem(BASE, '2026-06-14', { ...item, id: 'cand' }), /已存在/);
    assert.throws(() => insertItem(BASE, '2026-06-14', { ...item, id: 'Bad Id' }), /無效/);
    assert.throws(() => insertItem(BASE, '2026-06-14', { ...item, title: '' }), /標題/);
    assert.throws(() => insertItem(BASE, '2030-01-01', item), /找不到日期/);
    assert.throws(() => insertItem(BASE, '2026-06-14', item, 'd'), /不在/);
  });
});

describe('scheduleCandidate', () => {
  test('moves the candidate into the day as a poi, copying fields verbatim', () => {
    const out = scheduleCandidate(BASE, 'cand', '2026-06-15');
    const t = evalTrip(out);
    assert.deepEqual(t.days[1].items, [
      { id: 'cand', kind: 'poi', title: 'Cand {', placeId: 'p1', loc: { lat: 3, lng: 4, fetchedAt: '2026-01-01T00:00:00.000Z' }, note: 'because "x"' },
    ]);
    assert.deepEqual(t.candidates.map((c: any) => c.id), ['cand2']);
    assert.ok(out.includes("loc: { lat: 3, lng: 4, fetchedAt: '2026-01-01T00:00:00.000Z' },"));
    // the attached comment travels with it
    assert.ok(out.includes('// @trip-comment(item): nice place\n        {\n          id: \'cand\''));
    assert.equal(out.match(/id: 'cand'/g)?.length, 1);
    assert.ok(!out.includes('status: \'unconfirmed\',\n      day: 2'));
  });

  test('optional fields, ordering, last candidate without trailing comma', () => {
    const out = scheduleCandidate(BASE, 'cand2', '2026-06-14', 'c');
    assert.deepEqual(ids(out, 0), ['a', 'b', 'cand2', 'c']);
    assert.deepEqual(evalTrip(out).days[0].items[2], { id: 'cand2', kind: 'poi', title: 'Two' });
    const both = scheduleCandidate(scheduleCandidate(BASE, 'cand2', '2026-06-14'), 'cand', '2026-06-14', 'a');
    assert.deepEqual(ids(both, 0), ['cand', 'a', 'b', 'c', 'cand2']);
    assert.deepEqual(evalTrip(both).candidates, []);
  });

  test('errors', () => {
    assert.throws(() => scheduleCandidate(BASE, 'a', '2026-06-14'), /行程項目/);
    assert.throws(() => scheduleCandidate(BASE, 'zzz', '2026-06-14'), /找不到/);
    assert.throws(() => scheduleCandidate(BASE, 'cand', '2030-01-01'), /找不到日期/);
    assert.throws(() => scheduleCandidate(BASE, 'cand', '2026-06-14', 'd'), /不在/);
  });
});
