import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, test } from 'node:test';
import { handleTripcodeRequest } from './vite-plugin-tripcode.ts';
import type { SourceEdits } from './vite-plugin-tripcode.ts';
import * as realEdits from './src/core/source-edit.ts';
import { EditHistory } from './src/core/history.ts';

const edits = realEdits as unknown as SourceEdits;
let root: string;
const now = () => new Date('2026-11-06T12:15:30.123Z');
const call = (body: unknown) => handleTripcodeRequest('trip-delete', body, { root, edits, env: {}, history: new EditHistory(), now });
const exists = (p: string) => access(p).then(() => true, () => false);
const make = async (id: string, files: Record<string, string> = { 'trip.ts': 'export default {}', 'brief.md': 'hi' }) => {
  await mkdir(path.join(root, 'trips', id, 'tickets'), { recursive: true });
  for (const [f, c] of Object.entries(files)) await writeFile(path.join(root, 'trips', id, f), c);
};

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'tripcode-delete-'));
  await make('doomed');
  await make('keeper');
});

test('the whole folder moves to .tripcode-trash with everything in it, and nothing else is touched', async () => {
  const r = await call({ tripId: 'doomed' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json, { ok: true, tripId: 'doomed', trashed: path.join('.tripcode-trash', 'doomed-20261106T121530Z') });
  assert.equal(await exists(path.join(root, 'trips', 'doomed')), false);
  assert.equal(await readFile(path.join(root, '.tripcode-trash', 'doomed-20261106T121530Z', 'brief.md'), 'utf8'), 'hi');
  assert.equal(await exists(path.join(root, '.tripcode-trash', 'doomed-20261106T121530Z', 'tickets')), true);
  assert.equal(await exists(path.join(root, 'trips', 'keeper', 'trip.ts')), true);
});

test('deleting the same id twice never overwrites the first copy in the trash', async () => {
  await call({ tripId: 'doomed' });
  await make('doomed', { 'trip.ts': 'second' });
  const r = await call({ tripId: 'doomed' });
  assert.equal(r.status, 200);
  assert.deepEqual((await readdir(path.join(root, '.tripcode-trash'))).sort(), ['doomed-20261106T121530Z', 'doomed-20261106T121530Z-2']);
  assert.equal(await readFile(path.join(root, '.tripcode-trash', 'doomed-20261106T121530Z-2', 'trip.ts'), 'utf8'), 'second');
});

test('an unfinished idea (only idea.json) can be deleted too', async () => {
  await make('idea-20261106-abcd', { 'idea.json': '{}' });
  assert.equal((await call({ tripId: 'idea-20261106-abcd' })).status, 200);
  assert.equal(await exists(path.join(root, 'trips', 'idea-20261106-abcd')), false);
});

test('a missing trip, a bad id or a path trick is refused and nothing moves', async () => {
  for (const body of [{ tripId: 'nope' }, { tripId: '../keeper' }, { tripId: '..' }, { tripId: 'a/b' }, { tripId: '' }, {}, { tripId: 'Keeper' }]) {
    assert.equal((await call(body)).status, 400, JSON.stringify(body));
  }
  assert.equal(await exists(path.join(root, 'trips', 'keeper', 'trip.ts')), true);
  assert.equal(await exists(path.join(root, '.tripcode-trash')), false, 'no trash folder is made for a refused request');
});
