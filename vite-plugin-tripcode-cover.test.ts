import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, test } from 'node:test';
import { handleTripcodeRequest } from './vite-plugin-tripcode.ts';
import type { SourceEdits } from './vite-plugin-tripcode.ts';
import * as realEdits from './src/core/source-edit.ts';
import { EditHistory } from './src/core/history.ts';

const edits = realEdits as unknown as SourceEdits;
const T = 'cover-trip';
let root: string;
const call = (ep: string, body: unknown) => handleTripcodeRequest(ep, body, { root, edits, env: {}, history: new EditHistory() });
const exists = (p: string) => access(p).then(() => true, () => false);
const jpeg = (n = 100) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n, 1)]);

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'tripcode-cover-'));
  await mkdir(path.join(root, 'trips', T), { recursive: true });
});

test('a JPEG is stored as trips/<id>/cover.jpg and replaced by the next one', async () => {
  const r = await call('cover', { tripId: T, dataBase64: jpeg(100).toString('base64') });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(await readFile(path.join(root, 'trips', T, 'cover.jpg')), jpeg(100));
  await call('cover', { tripId: T, dataBase64: jpeg(50).toString('base64') });
  assert.deepEqual(await readFile(path.join(root, 'trips', T, 'cover.jpg')), jpeg(50));
});

test('anything that is not a JPEG, not base64 or too large is refused and nothing is written', async () => {
  const bad = [
    { tripId: T, dataBase64: Buffer.from('<svg onload=alert(1)>').toString('base64') },
    { tripId: T, dataBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64') },
    { tripId: T, dataBase64: 'not base64!' },
    { tripId: T, dataBase64: '' },
    { tripId: T },
    { tripId: T, dataBase64: jpeg(701 * 1024).toString('base64') },
  ];
  for (const body of bad) assert.equal((await call('cover', body)).status, 400, JSON.stringify(body).slice(0, 80));
  assert.equal(await exists(path.join(root, 'trips', T, 'cover.jpg')), false);
});

test('a cover is never created for a trip that does not exist, and ids cannot climb out of trips/', async () => {
  assert.equal((await call('cover', { tripId: 'nope', dataBase64: jpeg().toString('base64') })).status, 400);
  assert.equal(await exists(path.join(root, 'trips', 'nope')), false);
  assert.equal((await call('cover', { tripId: '../x', dataBase64: jpeg().toString('base64') })).status, 400);
});

test('cover-remove deletes it, and says so when there was none', async () => {
  await writeFile(path.join(root, 'trips', T, 'cover.jpg'), jpeg());
  const r = await call('cover-remove', { tripId: T });
  assert.deepEqual([r.status, (r.json as { removed: boolean }).removed], [200, true]);
  assert.equal(await exists(path.join(root, 'trips', T, 'cover.jpg')), false);
  assert.equal(((await call('cover-remove', { tripId: T })).json as { removed: boolean }).removed, false);
});
