import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { before, describe, test } from 'node:test';
import { guardRequest, handleTripcodeRequest, nextInboxName, safeJoin } from './vite-plugin-tripcode.ts';
import type { SourceEdits } from './vite-plugin-tripcode.ts';

const calls: unknown[][] = [];
const edits: SourceEdits = {
  insertComment: (src, ...a) => (calls.push(['comment', ...a]), src + '\n// c'),
  setItemField: (src, ...a) => (calls.push(['field', ...a]), src + '\n// f'),
  setCandidateStatus: (src, ...a) => (calls.push(['cand', ...a]), src + '\n// s'),
};

let root: string;
const now = () => new Date('2026-05-01T10:00:00.000Z');
const call = (ep: string, body: unknown) => handleTripcodeRequest(ep, body, { root, edits, now });

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'tripcode-'));
  await mkdir(path.join(root, 'trips', 'swiss'), { recursive: true });
  await writeFile(path.join(root, 'trips', 'swiss', 'trip.ts'), 'export default {};');
  await writeFile(path.join(root, 'trips', 'swiss', 'variant-b.ts'), 'export default {};');
});

describe('validation', () => {
  test('rejects unknown endpoint and non-object body', async () => {
    assert.equal((await call('nope', {})).status, 400);
    assert.equal((await call('comment', [])).status, 400);
    assert.equal((await call('comment', null)).status, 400);
  });
  test('rejects bad tripId', async () => {
    for (const tripId of ['../etc', 'A', 'a/b', '', 'a b', 42, undefined]) {
      const r = await call('comment', { tripId, targetId: 'x', anchor: 'item', text: 't' });
      assert.equal(r.status, 400, String(tripId));
      assert.equal(r.json.ok, false);
    }
  });
  test('rejects bad file', async () => {
    for (const file of ['../trip.ts', 'trip.js', 'sub/trip.ts', 'Trip.ts', '.ts', 5]) {
      const r = await call('comment', { tripId: 'swiss', file, targetId: 'x', anchor: 'item', text: 't' });
      assert.equal(r.status, 400, String(file));
    }
  });
  test('rejects bad anchor, status, day, value', async () => {
    assert.equal((await call('comment', { tripId: 'swiss', targetId: 'x', anchor: 'zzz', text: 't' })).status, 400);
    assert.equal((await call('candidate', { tripId: 'swiss', candidateId: 'x', status: 'maybe' })).status, 400);
    assert.equal((await call('candidate', { tripId: 'swiss', candidateId: 'x', status: 'accepted', day: 0 })).status, 400);
    assert.equal((await call('candidate', { tripId: 'swiss', candidateId: 'x', status: 'accepted', day: 1.5 })).status, 400);
    assert.equal((await call('item-field', { tripId: 'swiss', itemId: 'x', field: 'title', value: { a: 1 } })).status, 400);
    assert.equal((await call('item-field', { tripId: 'swiss', itemId: 'x', field: 'title', value: 'a\nb' })).status, 400);
  });
  test('item-field validates time fields and value length', async () => {
    for (const value of ['9:00', '25:00', '12:60', '', 'noon', '09:00:00']) {
      assert.equal((await call('item-field', { tripId: 'swiss', itemId: 'x', field: 'end', value })).status, 400, value);
    }
    assert.equal((await call('item-field', { tripId: 'swiss', itemId: 'x', field: 'title', value: 'x'.repeat(2001) })).status, 400);
  });
  test('missing file reports 400', async () => {
    const r = await call('comment', { tripId: 'swiss', file: 'nope.ts', targetId: 'x', anchor: 'item', text: 't' });
    assert.equal(r.status, 400);
  });
});

describe('edits', () => {
  test('comment collapses newlines and writes file', async () => {
    calls.length = 0;
    const r = await call('comment', { tripId: 'swiss', targetId: 'kapell', anchor: 'gap', text: 'a\nb\r\nc' });
    assert.deepEqual(r, { status: 200, json: { ok: true } });
    assert.deepEqual(calls[0], ['comment', 'kapell', 'a b c', 'gap']);
    assert.match(await readFile(path.join(root, 'trips/swiss/trip.ts'), 'utf8'), /\/\/ c$/);
  });
  test('comment defaults anchor to item; file selects variant', async () => {
    calls.length = 0;
    await call('comment', { tripId: 'swiss', file: 'variant-b.ts', targetId: 'x', text: 'hi' });
    assert.deepEqual(calls[0], ['comment', 'x', 'hi', 'item']);
    assert.match(await readFile(path.join(root, 'trips/swiss/variant-b.ts'), 'utf8'), /\/\/ c$/);
  });
  test('item-field and candidate pass through', async () => {
    calls.length = 0;
    assert.equal((await call('item-field', { tripId: 'swiss', itemId: 'h', field: 'start', value: '09:00' })).status, 200);
    assert.equal((await call('candidate', { tripId: 'swiss', candidateId: 'c1', status: 'accepted', day: 2 })).status, 200);
    assert.deepEqual(calls, [
      ['field', 'h', 'start', '09:00'],
      ['cand', 'c1', 'accepted', 2],
    ]);
  });
  test('edit helper errors become 400', async () => {
    const throwing: SourceEdits = { ...edits, setItemField: () => { throw new Error('不允許的欄位'); } };
    const r = await handleTripcodeRequest('item-field', { tripId: 'swiss', itemId: 'h', field: 'locked', value: 'x' }, { root, edits: throwing });
    assert.equal(r.status, 400);
    assert.deepEqual(r.json, { ok: false, error: '不允許的欄位' });
  });
});

describe('inbox', () => {
  test('numbers files sequentially with frontmatter', async () => {
    const r1 = await call('inbox', { tripId: 'swiss', text: '第一則\n小紅書' });
    const r2 = await call('inbox', { tripId: 'swiss', text: '第二則' });
    assert.equal(r1.json.ok && r1.json.file, 'inbox/01.md');
    assert.equal(r2.json.ok && r2.json.file, 'inbox/02.md');
    const body = await readFile(path.join(root, 'trips/swiss/inbox/01.md'), 'utf8');
    assert.equal(body, '---\nstatus: pending\ncreatedAt: 2026-05-01T10:00:00.000Z\n---\n第一則\n小紅書\n');
  });
  test('continues after the highest number and ignores other files', async () => {
    const dir = path.join(root, 'trips/swiss/inbox');
    await writeFile(path.join(dir, '09.md'), 'x');
    await writeFile(path.join(dir, 'notes.txt'), 'x');
    assert.equal(await nextInboxName(dir), '10.md');
    assert.equal(await nextInboxName(path.join(root, 'nonexistent')), '01.md');
  });
  test('refuses to create a trip folder that does not exist', async () => {
    const r = await call('inbox', { tripId: 'no-such-trip', text: 'hello' });
    assert.equal(r.status, 400);
    assert.deepEqual(await readdir(path.join(root, 'trips')), ['swiss']);
  });
  test('rejects empty text', async () => {
    assert.equal((await call('inbox', { tripId: 'swiss', text: '   ' })).status, 400);
  });
  test('concurrent writes get distinct files', async () => {
    const before = (await readdir(path.join(root, 'trips/swiss/inbox'))).length;
    const rs = await Promise.all([1, 2, 3, 4].map((i) => call('inbox', { tripId: 'swiss', text: `p${i}` })));
    assert.ok(rs.every((r) => r.status === 200));
    assert.equal(new Set(rs.map((r) => (r.json.ok ? r.json.file : ''))).size, 4);
    assert.equal((await readdir(path.join(root, 'trips/swiss/inbox'))).length, before + 4);
  });
});

describe('current', () => {
  test('writes node_modules/.tripcode/current.json', async () => {
    const r = await call('current', { tripId: 'swiss', day: '2026-05-02', itemId: 'kapell' });
    assert.equal(r.status, 200);
    const j = JSON.parse(await readFile(path.join(root, 'node_modules/.tripcode/current.json'), 'utf8'));
    assert.deepEqual(j, { tripId: 'swiss', file: 'trip.ts', day: '2026-05-02', itemId: 'kapell', updatedAt: '2026-05-01T10:00:00.000Z' });
  });
});

test('safeJoin refuses escapes', () => {
  assert.throws(() => safeJoin('/a/b', '..'));
  assert.throws(() => safeJoin('/a/b', '../c'));
  assert.throws(() => safeJoin('/a/b', '/etc/passwd'));
  assert.equal(safeJoin('/a/b', 'c', 'd.ts'), '/a/b/c/d.ts');
});

describe('guardRequest (CSRF / DNS rebinding)', () => {
  const ok = { host: 'localhost:5173', 'content-type': 'application/json' };
  test('allows same-origin browser posts and header-less tools', () => {
    assert.equal(guardRequest(ok), null);
    assert.equal(guardRequest({ ...ok, origin: 'http://localhost:5173', 'sec-fetch-site': 'same-origin' }), null);
    assert.equal(guardRequest({ ...ok, 'content-type': 'application/json; charset=utf-8' }), null);
    assert.equal(guardRequest({ host: '127.0.0.1:5288', origin: 'http://127.0.0.1:5288', 'content-type': 'application/json' }), null);
    assert.equal(guardRequest({ host: '[::1]:5173', origin: 'http://[::1]:5173', 'content-type': 'application/json' }), null);
    assert.equal(guardRequest({ host: 'trip.localhost:5173', 'content-type': 'application/json' }), null);
  });
  test('rejects a cross-origin page posting to localhost', () => {
    assert.equal(guardRequest({ ...ok, origin: 'https://evil.example' })?.status, 403);
    assert.equal(guardRequest({ ...ok, origin: 'http://localhost:9999' })?.status, 403); // another local app
    assert.equal(guardRequest({ ...ok, origin: 'null' })?.status, 403);
    assert.equal(guardRequest({ ...ok, 'sec-fetch-site': 'cross-site' })?.status, 403);
    assert.equal(guardRequest({ ...ok, 'sec-fetch-site': 'same-site' })?.status, 403);
  });
  test('rejects a rebinding hostname unless allowed', () => {
    const h = { host: 'evil.example:5173', origin: 'http://evil.example:5173', 'content-type': 'application/json' };
    assert.equal(guardRequest(h)?.status, 403);
    assert.equal(guardRequest(h, { allowedHosts: ['evil.example'] }), null);
    assert.equal(guardRequest(h, { allowedHosts: ['.example'] }), null);
    assert.equal(guardRequest(h, { allowedHosts: true }), null);
    assert.equal(guardRequest({ 'content-type': 'application/json' })?.status, 403);
  });
  test('requires application/json so a simple text/plain POST cannot slip through', () => {
    assert.equal(guardRequest({ host: 'localhost:5173', 'content-type': 'text/plain' })?.status, 415);
    assert.equal(guardRequest({ host: 'localhost:5173', 'content-type': 'application/x-www-form-urlencoded' })?.status, 415);
    assert.equal(guardRequest({ host: 'localhost:5173' })?.status, 415);
  });
});
