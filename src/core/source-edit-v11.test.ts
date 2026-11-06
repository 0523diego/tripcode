import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addAttachment, insertCandidate, listDayDates, removeAttachment } from './source-edit.ts';
import type { Candidate } from './types.ts';

/** Evaluate a trip source (strip the import, turn the default export into a return). */
function evalTrip(src: string): any {
  const body = src.replace(/^import .*$/m, '').replace(/export default defineTrip\(/, 'return (');
  return new Function(body)();
}

const BASE = `import { defineTrip } from '../../src/core/types.ts';

// id: 'ghost' { in a comment
export default defineTrip({
  title: 'Trip {x}',
  start: '2026-06-14',
  end: '2026-06-15',
  tz: 'Europe/Zurich',
  party: { adults: 2, childrenAges: [] },
  days: [
    {
      date: '2026-06-14',
      items: [
        {
          id: 'a',
          kind: 'free',
          title: 'A',
        },
        { id: 'b', kind: 'free', title: 'B', attachments: [{ file: 'tickets/x.pdf', label: 'X' }] },
        {
          id: 'c',
          kind: 'free',
          title: 'C',
          attachments: [
            { file: 'tickets/one.pdf', label: 'One', kind: 'entry' },
            { file: 'tickets/two.pdf', label: 'Two' }, // second
            { file: 'tickets/three.pdf', label: 'Three' },
          ],
        },
      ],
    },
    { date: '2026-06-15', items: [] },
  ],
  candidates: [
    {
      id: 'pilatus',
      title: 'Pilatus',
      status: 'unconfirmed',
      sources: ['inbox/01.md'],
    },
  ],
});
`;

const cand = (over: Partial<Candidate> = {}): Candidate => ({
  id: 'new-place',
  title: 'New Place',
  status: 'unconfirmed',
  sources: ['manual'],
  ...over,
});

// ---- insertCandidate ----------------------------------------------------------

test('insertCandidate appends to an existing multi-line array and keeps every other byte', () => {
  const out = insertCandidate(BASE, cand({ loc: { lat: 47.05, lng: 8.31 }, placeId: 'osm:node/1' }));
  const t = evalTrip(out);
  assert.equal(t.candidates.length, 2);
  assert.deepEqual(t.candidates[1], {
    id: 'new-place', title: 'New Place', placeId: 'osm:node/1', loc: { lat: 47.05, lng: 8.31 }, status: 'unconfirmed', sources: ['manual'],
  });
  const idx = out.indexOf("    {\n      id: 'new-place'");
  assert.ok(idx > 0, 'indented like its siblings');
  assert.equal(out.replace(/\n    \{\n      id: 'new-place'[\s\S]*?\n    \},/, ''), BASE);
});

test('insertCandidate handles day / accepted and special characters in the title', () => {
  const title = `Café "l'été" {x} \\ \`t\` \${y}`;
  const out = insertCandidate(BASE, cand({ title, status: 'accepted', day: 2 }));
  const c = evalTrip(out).candidates[1];
  assert.equal(c.title, title);
  assert.equal(c.day, 2);
  assert.equal(c.status, 'accepted');
});

test('insertCandidate: empty array, no trailing comma, inline array, comment-only array', () => {
  const empty = BASE.replace(/candidates: \[[\s\S]*?\n  \],/, 'candidates: [],');
  assert.equal(evalTrip(insertCandidate(empty, cand())).candidates.length, 1);

  const noComma = BASE.replace("sources: ['inbox/01.md'],\n    },", "sources: ['inbox/01.md']\n    }");
  assert.equal(evalTrip(insertCandidate(noComma, cand())).candidates.length, 2);

  const inline = BASE.replace(/candidates: \[[\s\S]*?\n  \],/, "candidates: [{ id: 'z', title: 'Z', status: 'discuss', sources: [] }],");
  const o = insertCandidate(inline, cand());
  assert.deepEqual(evalTrip(o).candidates.map((c: any) => c.id), ['z', 'new-place']);

  const comment = BASE.replace(/candidates: \[[\s\S]*?\n  \],/, 'candidates: [\n    // nothing yet\n  ],');
  const oc = insertCandidate(comment, cand());
  assert.ok(oc.includes('// nothing yet'));
  assert.equal(evalTrip(oc).candidates.length, 1);

  const trailingComment = BASE.replace("sources: ['inbox/01.md'],\n    },", "sources: ['inbox/01.md'],\n    }, // keep");
  const ot = insertCandidate(trailingComment, cand());
  assert.ok(ot.includes('}, // keep'));
  assert.equal(evalTrip(ot).candidates.length, 2);
});

test('insertCandidate creates the candidates array when absent', () => {
  const none = BASE.replace(/  candidates: \[[\s\S]*?\n  \],\n/, '');
  assert.equal(evalTrip(none).candidates, undefined);
  const out = insertCandidate(none, cand());
  assert.equal(evalTrip(out).candidates[0].id, 'new-place');
  assert.ok(out.includes("  candidates: [\n    {\n      id: 'new-place'"));

  const noTrailing = none.replace('  ],\n});', '  ]\n});');
  assert.equal(evalTrip(insertCandidate(noTrailing, cand())).candidates.length, 1);

  const oneLine = "export default defineTrip({ title: 'T', days: [] });\n";
  assert.equal(evalTrip(insertCandidate(oneLine, cand())).candidates.length, 1);
});

test('insertCandidate rejects duplicate ids (also item ids), bad ids and empty titles', () => {
  assert.throws(() => insertCandidate(BASE, cand({ id: 'pilatus' })), /已存在/);
  assert.throws(() => insertCandidate(BASE, cand({ id: 'a' })), /已存在/);
  assert.throws(() => insertCandidate(BASE, cand({ id: 'Bad Id' })), /無效/);
  assert.throws(() => insertCandidate(BASE, cand({ title: '  ' })), /標題/);
  assert.throws(() => insertCandidate(BASE.replace(/candidates: \[[\s\S]*?\n  \],/, 'candidates: other,'), cand()), /陣列/);
});

test('insertCandidate ignores a candidates key inside strings/comments', () => {
  const src = BASE.replace("title: 'Trip {x}',", "title: 'candidates: [ {',").replace(/  candidates: \[[\s\S]*?\n  \],\n/, '');
  const out = insertCandidate(src, cand());
  assert.equal(evalTrip(out).candidates.length, 1);
});

test('insertCandidate keeps CRLF line endings', () => {
  const crlf = BASE.replace(/\n/g, '\r\n');
  const out = insertCandidate(crlf, cand());
  assert.ok(!/[^\r]\n/.test(out));
  assert.equal(evalTrip(out).candidates.length, 2);
});

// ---- attachments ---------------------------------------------------------------

test('addAttachment creates attachments on an item without one', () => {
  const out = addAttachment(BASE, 'a', { file: 'tickets/rigi.pdf', label: "Rigi 'day' pass", kind: 'transport' });
  const a = evalTrip(out).days[0].items[0];
  assert.deepEqual(a.attachments, [{ file: 'tickets/rigi.pdf', label: "Rigi 'day' pass", kind: 'transport' }]);
  assert.ok(out.includes("id: 'a',\n          attachments: ["));
  assert.equal(out.replace(/\n {10}attachments: \[.*\],/, ''), BASE);
});

test('addAttachment appends to an inline array and to a multi-line array', () => {
  const o1 = addAttachment(BASE, 'b', { file: 'tickets/y.png', label: 'Y' });
  assert.deepEqual(evalTrip(o1).days[0].items[1].attachments.map((x: any) => x.file), ['tickets/x.pdf', 'tickets/y.png']);
  const o2 = addAttachment(BASE, 'c', { file: 'tickets/four.pdf', label: 'Four {', kind: 'booking' });
  const items = evalTrip(o2).days[0].items[2].attachments;
  assert.equal(items.length, 4);
  assert.equal(items[3].label, 'Four {');
  assert.ok(o2.includes("{ file: 'tickets/three.pdf', label: 'Three' },\n            { file: 'tickets/four.pdf'"));
});

test('addAttachment rejects unknown ids, duplicates and bad input', () => {
  assert.throws(() => addAttachment(BASE, 'nope', { file: 'tickets/a.pdf', label: 'A' }), /nope/);
  assert.throws(() => addAttachment(BASE, 'b', { file: 'tickets/x.pdf', label: 'X' }), /已存在/);
  assert.throws(() => addAttachment(BASE, 'a', { file: 'tickets/a.pdf', label: '' }), /標籤/);
  assert.throws(() => addAttachment(BASE, 'a', { file: 'tickets/a.pdf', label: 'A', kind: 'x' as never }), /類型/);
});

test('removeAttachment removes one entry, preserving the rest', () => {
  const out = removeAttachment(BASE, 'c', 'tickets/two.pdf');
  assert.deepEqual(evalTrip(out).days[0].items[2].attachments.map((x: any) => x.file), ['tickets/one.pdf', 'tickets/three.pdf']);
  assert.equal(out, BASE.replace("            { file: 'tickets/two.pdf', label: 'Two' }, // second\n", ''));
  const first = removeAttachment(BASE, 'c', 'tickets/one.pdf');
  assert.equal(evalTrip(first).days[0].items[2].attachments.length, 2);
  const last = removeAttachment(BASE, 'c', 'tickets/three.pdf');
  assert.equal(evalTrip(last).days[0].items[2].attachments.length, 2);
});

test('removeAttachment drops the attachments property when it was the last entry', () => {
  const out = removeAttachment(BASE, 'b', 'tickets/x.pdf');
  assert.equal(evalTrip(out).days[0].items[1].attachments, undefined);
  assert.ok(out.includes("{ id: 'b', kind: 'free', title: 'B' }") || out.includes("title: 'B'"));
  assert.equal(evalTrip(out).days[0].items[1].title, 'B');
});

test('removeAttachment errors on missing item / attachment and round-trips with add', () => {
  assert.throws(() => removeAttachment(BASE, 'nope', 'tickets/x.pdf'), /nope/);
  assert.throws(() => removeAttachment(BASE, 'a', 'tickets/x.pdf'), /沒有附件/);
  assert.throws(() => removeAttachment(BASE, 'c', 'tickets/zzz.pdf'), /沒有附件/);
  const added = addAttachment(BASE, 'a', { file: 'tickets/t.pdf', label: 'T' });
  assert.equal(removeAttachment(added, 'a', 'tickets/t.pdf'), BASE);
});

test('listDayDates lists unique dates in code only', () => {
  assert.deepEqual(listDayDates(BASE), ['2026-06-14', '2026-06-15']);
  assert.deepEqual(listDayDates("// date: '2026-01-01'\nconst s = \"date: '2026-02-02'\";"), []);
});
