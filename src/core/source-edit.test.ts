import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findObjectById, insertComment, setCandidateStatus, setItemField } from './source-edit.ts';

const SAMPLE = `import { defineTrip } from '../../src/core/types.ts';

// A comment with { an unbalanced brace and id: 'ghost'
export default defineTrip({
  title: 'Swiss {trip}',
  start: '2026-06-14',
  end: '2026-06-16',
  tz: 'Europe/Zurich',
  party: { adults: 2, childrenAges: [] },
  days: [
    {
      date: '2026-06-14',
      title: "Arrival } day",
      items: [
        {
          id: 'flight-in',
          kind: 'flight',
          title: 'LX 160',
          flightNo: 'LX 160',
          start: '06:00',
          end: '08:05', // lands
        },
        {
          id: 'kapell',
          kind: 'poi',
          title: \`Kapell \${'}'} bridge\`,
          /* id: 'fake' } */
          start: '09:30',
          ticket: {
            value: { amount: 0, currency: 'CHF' },
            source: 'user',
            fetchedAt: '2026-06-01T00:00:00Z',
            confidence: 'recent',
          },
          note: 'He said "hi", it\\'s fine {',
        },
        { id: 'inline', kind: 'free', title: 'Free time' },
        { id: 'inline-last', kind: 'free', title: 'Rest' , start: '12:00' },
      ],
    },
    {
      date: '2026-06-15',
      items: [{ id: "dq", kind: 'meal', title: 'Dinner', note: 'x' }],
    },
  ],
  candidates: [
    {
      id: 'pilatus',
      title: 'Pilatus',
      status: 'unconfirmed',
      sources: ['inbox/01.md'],
    },
    { id: 'rigi', title: 'Rigi', status: 'accepted', day: 2, sources: ['claude'] },
    {
      id: 'titlis',
      title: 'Titlis',
      status: 'discuss',
      sources: ['claude']
    },
    { id: 'bare', title: 'Bare', sources: [] },
  ],
});
`;

function slice(src: string, id: string): string {
  const r = findObjectById(src, id);
  assert.ok(r, `object ${id} found`);
  return src.slice(r.start, r.end);
}

// ---- findObjectById ---------------------------------------------------------

test('findObjectById returns braces of the right object', () => {
  const r = findObjectById(SAMPLE, 'kapell');
  assert.ok(r);
  assert.equal(SAMPLE[r.start], '{');
  assert.equal(SAMPLE[r.end - 1], '}');
  const body = SAMPLE.slice(r.start, r.end);
  assert.ok(body.includes("id: 'kapell'"));
  assert.ok(body.includes("it\\'s fine {"));
  assert.ok(!body.includes('flight-in'));
});

test('findObjectById ignores braces in strings, templates and comments', () => {
  assert.ok(slice(SAMPLE, 'kapell').endsWith("fine {',\n        }"));
  assert.ok(slice(SAMPLE, 'flight-in').includes('// lands'));
});

test('findObjectById: double-quoted id, inline objects, nested object ids, missing id', () => {
  assert.equal(slice(SAMPLE, 'dq'), `{ id: "dq", kind: 'meal', title: 'Dinner', note: 'x' }`);
  assert.equal(slice(SAMPLE, 'inline'), `{ id: 'inline', kind: 'free', title: 'Free time' }`);
  assert.equal(findObjectById(SAMPLE, 'nope'), null);
  assert.equal(findObjectById(SAMPLE, 'kap'), null, 'no prefix match');
});

test('findObjectById ignores ids that only appear in comments or strings', () => {
  assert.equal(findObjectById(SAMPLE, 'ghost'), null);
  assert.equal(findObjectById(SAMPLE, 'fake'), null);
  const src = `const x = { note: "id: 'sneaky'", id: 'real' };`;
  assert.equal(findObjectById(src, 'sneaky'), null);
  assert.equal(slice(src, 'real'), `{ note: "id: 'sneaky'", id: 'real' }`);
});

test('findObjectById supports quoted keys and nested objects', () => {
  const src = `x = { "id": "outer", inner: { id: 'in' } }`;
  assert.equal(slice(src, 'outer'), `{ "id": "outer", inner: { id: 'in' } }`);
  assert.equal(slice(src, 'in'), `{ id: 'in' }`);
});

test('findObjectById handles template literal nesting', () => {
  const src = 'const a = { t: `x ${ {a: `}`}.a } y`, id: \'tpl\' };\nconst b = { id: \'after\' };';
  assert.equal(slice(src, 'tpl'), "{ t: `x ${ {a: `}`}.a } y`, id: 'tpl' }");
  assert.equal(slice(src, 'after'), "{ id: 'after' }");
});

// ---- insertComment ----------------------------------------------------------

test('insertComment places the marker above the object line with same indent', () => {
  const out = insertComment(SAMPLE, 'kapell', '太趕了嗎？', 'item');
  assert.ok(out.includes(`        // @trip-comment(item): 太趕了嗎？\n        {\n          id: 'kapell',`));
  assert.equal(out.length - SAMPLE.length, `        // @trip-comment(item): 太趕了嗎？\n`.length);
  // untouched elsewhere
  assert.equal(out.replace(`        // @trip-comment(item): 太趕了嗎？\n`, ''), SAMPLE);
});

test('insertComment defaults anchor to item and supports gap/leg', () => {
  assert.ok(insertComment(SAMPLE, 'inline', 'x').includes('        // @trip-comment(item): x\n        { id: \'inline\''));
  assert.ok(insertComment(SAMPLE, 'inline', 'x', 'gap').includes('@trip-comment(gap): x'));
  assert.ok(insertComment(SAMPLE, 'inline', 'x', 'leg').includes('@trip-comment(leg): x'));
});

test('insertComment day anchor targets the day by date', () => {
  const out = insertComment(SAMPLE, '2026-06-15', '這天想晚點出門', 'day');
  assert.ok(out.includes(`    // @trip-comment(day): 這天想晚點出門\n    {\n      date: '2026-06-15',`));
  assert.throws(() => insertComment(SAMPLE, '2026-07-01', 'x', 'day'), /2026-07-01/);
  // a date is not an item id
  assert.throws(() => insertComment(SAMPLE, '2026-06-15', 'x', 'item'));
});

test('insertComment sanitizes newlines into a single line', () => {
  const out = insertComment(SAMPLE, 'kapell', 'line one\nline two\r\n\r\n  three ', 'item');
  assert.ok(out.includes('// @trip-comment(item): line one line two three\n'));
  assert.equal(out.split('\n').length, SAMPLE.split('\n').length + 1);
});

test('insertComment errors: unknown id, empty text, bad anchor', () => {
  assert.throws(() => insertComment(SAMPLE, 'missing', 'x'), /missing/);
  assert.throws(() => insertComment(SAMPLE, 'kapell', '  \n '), /空/);
  assert.throws(() => insertComment(SAMPLE, 'kapell', 'x', 'bogus' as never), /bogus/);
});

test('insertComment keeps CRLF files CRLF', () => {
  const crlf = SAMPLE.replace(/\n/g, '\r\n');
  const out = insertComment(crlf, 'kapell', 'hi');
  assert.ok(out.includes('        // @trip-comment(item): hi\r\n        {\r\n'));
  assert.ok(!/[^\r]\n/.test(out));
});

test('insertComment on an object at the start of the file', () => {
  assert.equal(insertComment(`{ id: 'a' }`, 'a', 'x'), `// @trip-comment(item): x\n{ id: 'a' }`);
});

test('inserted comments do not disturb later lookups', () => {
  const once = insertComment(SAMPLE, 'kapell', 'with { brace and id: \'ghost\'');
  assert.ok(findObjectById(once, 'kapell'));
  assert.equal(findObjectById(once, 'ghost'), null);
  const twice = insertComment(once, 'kapell', 'second');
  assert.equal((twice.match(/@trip-comment/g) ?? []).length, 2);
});

// ---- setItemField -----------------------------------------------------------

test('setItemField replaces an existing string value and nothing else', () => {
  const out = setItemField(SAMPLE, 'kapell', 'start', '10:15');
  assert.equal(out, SAMPLE.replace(`start: '09:30'`, `start: '10:15'`));
});

test('setItemField keeps trailing comments and commas', () => {
  const out = setItemField(SAMPLE, 'flight-in', 'end', '08:20');
  assert.equal(out, SAMPLE.replace(`end: '08:05', // lands`, `end: '08:20', // lands`));
});

test('setItemField replaces a template-literal value and a value containing braces', () => {
  const t = setItemField(SAMPLE, 'kapell', 'title', `Kapell's {bridge}`);
  assert.ok(t.includes(`title: 'Kapell\\'s {bridge}',`));
  assert.ok(!t.includes('Kapell ${'));
  assert.ok(findObjectById(t, 'kapell'));
  const n = setItemField(SAMPLE, 'kapell', 'note', 'new');
  assert.ok(n.includes(`note: 'new',\n`));
});

test('setItemField escapes quotes, backslashes and newlines', () => {
  const out = setItemField(SAMPLE, 'dq', 'note', `a'b\\c\nd`);
  assert.ok(out.includes(String.raw`note: 'a\'b\\c\nd'`));
  assert.ok(out.includes(`id: "dq"`));
});

test('setItemField inserts a missing property after id (multi-line, with comma)', () => {
  const out = setItemField(SAMPLE, 'flight-in', 'bookingRef', 'ABC123');
  assert.ok(out.includes(`          id: 'flight-in',\n          bookingRef: 'ABC123',\n          kind: 'flight',`));
  assert.equal(out.replace(`          bookingRef: 'ABC123',\n`, ''), SAMPLE);
});

test('setItemField inserts into single-line objects (with and without trailing comma after id)', () => {
  assert.equal(setItemField(SAMPLE, 'inline', 'note', 'n'), SAMPLE.replace(`{ id: 'inline', kind`, `{ id: 'inline', note: 'n', kind`));
  assert.equal(setItemField(`x = { id: 'a' }`, 'a', 'note', 'n'), `x = { id: 'a', note: 'n' }`);
});

test('setItemField inserts after id when id is the last property on its own line', () => {
  const src = `[\n  {\n    title: 'T',\n    id: 'z' // last\n  }\n]`;
  const out = setItemField(src, 'z', 'note', 'n');
  assert.equal(out, `[\n  {\n    title: 'T',\n    id: 'z', // last\n    note: 'n'\n  }\n]`);
});

test('setItemField only touches first-level properties, never nested ones', () => {
  // kapell has no top-level `value`-style collisions; nested ticket has `source`, and title lives at depth 1
  const src = `x = { id: 'a', meta: { title: 'nested' }, note: 'n' }`;
  const out = setItemField(src, 'a', 'title', 'T');
  assert.equal(out, `x = { id: 'a', title: 'T', meta: { title: 'nested' }, note: 'n' }`);
  const out2 = setItemField(src, 'a', 'note', 'N');
  assert.equal(out2, `x = { id: 'a', meta: { title: 'nested' }, note: 'N' }`);
});

test('setItemField ignores key-like text inside strings, comments and ternaries', () => {
  const src = `x = {\n  id: 'a',\n  note: 'title: fake',\n  // title: 'comment'\n  kind: cond ? title : other,\n}`;
  const out = setItemField(src, 'a', 'title', 'Real');
  assert.equal(out, `x = {\n  id: 'a',\n  title: 'Real',\n  note: 'title: fake',\n  // title: 'comment'\n  kind: cond ? title : other,\n}`);
});

test('setItemField replaces numeric and unquoted-looking values', () => {
  const src = `x = { id: 'a', start: 930, end: '10:00' }`;
  assert.equal(setItemField(src, 'a', 'start', '09:30'), `x = { id: 'a', start: '09:30', end: '10:00' }`);
});

test('setItemField rejects disallowed fields and unknown ids', () => {
  for (const f of ['id', 'kind', 'locked', 'ticket', 'loc', 'status']) {
    assert.throws(() => setItemField(SAMPLE, 'kapell', f as never, 'x'), /不允許/, f);
  }
  assert.throws(() => setItemField(SAMPLE, 'nope', 'title', 'x'), /nope/);
});

test('setItemField works with CRLF sources', () => {
  const crlf = SAMPLE.replace(/\n/g, '\r\n');
  const out = setItemField(crlf, 'flight-in', 'bookingRef', 'Z9');
  assert.ok(out.includes(`id: 'flight-in',\r\n          bookingRef: 'Z9',\r\n`));
  assert.ok(!/[^\r]\n/.test(out));
});

// ---- setCandidateStatus -------------------------------------------------------

test('setCandidateStatus changes only the status', () => {
  const out = setCandidateStatus(SAMPLE, 'pilatus', 'discuss');
  assert.equal(out, SAMPLE.replace(`status: 'unconfirmed'`, `status: 'discuss'`));
});

test('setCandidateStatus accepted + day inserts day after status/id', () => {
  const out = setCandidateStatus(SAMPLE, 'pilatus', 'accepted', 3);
  const body = slice(out, 'pilatus');
  assert.ok(body.includes(`status: 'accepted'`));
  assert.ok(body.includes(`\n      day: 3,\n`));
  assert.ok(!out.includes(`status: 'unconfirmed'`));
});

test('setCandidateStatus accepted replaces an existing day', () => {
  const out = setCandidateStatus(SAMPLE, 'rigi', 'accepted', 4);
  assert.equal(out, SAMPLE.replace(`status: 'accepted', day: 2,`, `status: 'accepted', day: 4,`));
});

test('setCandidateStatus removes day when moving away from accepted (inline, middle)', () => {
  const out = setCandidateStatus(SAMPLE, 'rigi', 'rejected');
  assert.equal(out, SAMPLE.replace(`status: 'accepted', day: 2, sources`, `status: 'rejected', sources`));
});

test('setCandidateStatus removes a day on its own line, including the whole line', () => {
  const withDay = setCandidateStatus(SAMPLE, 'pilatus', 'accepted', 2);
  const back = setCandidateStatus(withDay, 'pilatus', 'unconfirmed');
  assert.equal(back, SAMPLE);
});

test('setCandidateStatus removes a trailing day without a comma on a shared line', () => {
  const src = `c = [{ id: 'a', status: 'accepted', day: 5 }];`;
  assert.equal(setCandidateStatus(src, 'a', 'discuss'), `c = [{ id: 'a', status: 'discuss' }];`);
});

test('setCandidateStatus inserts a missing status and keeps day untouched when accepted without day', () => {
  const out = setCandidateStatus(SAMPLE, 'bare', 'accepted');
  assert.equal(out, SAMPLE.replace(`{ id: 'bare', title`, `{ id: 'bare', status: 'accepted', title`));
  const keep = setCandidateStatus(SAMPLE, 'rigi', 'accepted');
  assert.equal(keep, SAMPLE);
});

test('setCandidateStatus handles the last property without trailing comma', () => {
  const out = setCandidateStatus(SAMPLE, 'titlis', 'accepted', 1);
  assert.ok(slice(out, 'titlis').includes(`id: 'titlis',\n      day: 1,\n`));
  assert.ok(slice(out, 'titlis').includes(`status: 'accepted',`));
  const noop = setCandidateStatus(SAMPLE, 'titlis', 'rejected');
  assert.equal(noop, SAMPLE.replace(`status: 'discuss'`, `status: 'rejected'`));
});

test('setCandidateStatus validates inputs', () => {
  assert.throws(() => setCandidateStatus(SAMPLE, 'nope', 'accepted', 1), /nope/);
  assert.throws(() => setCandidateStatus(SAMPLE, 'pilatus', 'bogus' as never), /bogus/);
  assert.throws(() => setCandidateStatus(SAMPLE, 'pilatus', 'accepted', 0), /天數/);
  assert.throws(() => setCandidateStatus(SAMPLE, 'pilatus', 'accepted', 1.5), /天數/);
});

test('every edit leaves the file parseable by brace matching for all ids', () => {
  let src = SAMPLE;
  src = setItemField(src, 'kapell', 'note', `tricky } ' " \` \${x}`);
  src = insertComment(src, 'kapell', 'comment with } and {');
  src = setCandidateStatus(src, 'pilatus', 'accepted', 2);
  for (const id of ['flight-in', 'kapell', 'inline', 'inline-last', 'dq', 'pilatus', 'rigi', 'titlis', 'bare']) {
    const r = findObjectById(src, id);
    assert.ok(r, id);
    assert.ok(src.slice(r.start, r.end).startsWith('{'), id);
  }
  assert.ok(src.includes("note: 'tricky } \\' \" ` ${x}'"));
});
