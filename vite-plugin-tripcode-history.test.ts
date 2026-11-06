import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, test } from 'node:test';
import { ENDPOINTS, handleTripcodeRequest } from './vite-plugin-tripcode.ts';
import type { HandlerDeps, SourceEdits } from './vite-plugin-tripcode.ts';
import * as realEdits from './src/core/source-edit.ts';
import { EditHistory } from './src/core/history.ts';

const edits = realEdits as unknown as SourceEdits;
const now = () => new Date('2026-05-01T10:00:00.000Z');
const REPO = import.meta.dirname;
const T = 'tokyo-sample';

let root: string;
let history: EditHistory;
const call = (ep: string, body: unknown, extra: Partial<HandlerDeps> = {}) => handleTripcodeRequest(ep, body, { root, edits, now, env: {}, history, ...extra });
const tripPath = () => path.join(root, 'trips', T, 'trip.ts');
const read = () => readFile(tripPath(), 'utf8');

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'tripcode-history-'));
  history = new EditHistory();
  await mkdir(path.join(root, 'trips', T), { recursive: true });
  await copyFile(path.join(REPO, 'trips', T, 'trip.ts'), tripPath());
});

test('undo, redo and history are registered endpoints', () => {
  for (const ep of ['undo', 'redo', 'history']) assert.ok(ENDPOINTS.includes(ep as never), ep);
});

test('an item-field edit is recorded and undo / redo restore the exact file text', async () => {
  const original = await read();
  const edit = await call('item-field', { tripId: T, itemId: 'senso-ji', field: 'title', value: '淺草寺（改）' });
  assert.equal(edit.status, 200, JSON.stringify(edit.json));
  assert.deepEqual((edit.json as { history: unknown }).history, { undo: 1, redo: 0, undoLabel: '修改標題', undoItemId: 'senso-ji' });
  const edited = await read();
  assert.notEqual(edited, original);

  const undone = await call('undo', { tripId: T });
  assert.equal(undone.status, 200, JSON.stringify(undone.json));
  assert.equal((undone.json as { label: string }).label, '修改標題');
  assert.equal((undone.json as { itemId: string }).itemId, 'senso-ji');
  assert.equal(await read(), original);

  const redone = await call('redo', { tripId: T });
  assert.equal(redone.status, 200);
  assert.equal(await read(), edited);
  assert.deepEqual((await call('history', { tripId: T })).json, { ok: true, history: { undo: 1, redo: 0, undoLabel: '修改標題', undoItemId: 'senso-ji' } });
});

test('several kinds of edit stack up and unwind in reverse order', async () => {
  const original = await read();
  await call('item-field', { tripId: T, itemId: 'senso-ji', field: 'title', value: 'A' });
  await call('set-locked', { tripId: T, itemId: 'senso-ji', locked: true });
  await call('comment', { tripId: T, targetId: 'senso-ji', anchor: 'item', text: '早點去' });
  assert.equal(((await call('history', { tripId: T })).json as { history: { undo: number } }).history.undo, 3);
  for (let i = 0; i < 3; i++) assert.equal((await call('undo', { tripId: T })).status, 200);
  assert.equal(await read(), original);
  assert.equal((await call('undo', { tripId: T })).status, 409);
});

test('an edit that changes nothing is not recorded', async () => {
  const current = (await read()).match(/id: 'senso-ji'[^]*?title: '([^']*)'/)?.[1];
  assert.ok(current);
  const r = await call('item-field', { tripId: T, itemId: 'senso-ji', field: 'title', value: current });
  assert.equal(r.status, 200);
  assert.equal(((await call('history', { tripId: T })).json as { history: { undo: number } }).history.undo, 0);
});

test('a failed edit is not recorded and leaves the file alone', async () => {
  const before = await read();
  const r = await call('item-field', { tripId: T, itemId: 'nope', field: 'title', value: 'x' });
  assert.equal(r.status, 400);
  assert.equal(await read(), before);
  assert.equal(((await call('history', { tripId: T })).json as { history: { undo: number } }).history.undo, 0);
});

test('undo refuses to overwrite changes made outside the viewer, and says why', async () => {
  await call('item-field', { tripId: T, itemId: 'senso-ji', field: 'title', value: 'A' });
  const outside = `${await read()}\n// Claude was here\n`;
  await writeFile(tripPath(), outside, 'utf8');
  const r = await call('undo', { tripId: T });
  assert.equal(r.status, 409);
  assert.match((r.json as { error: string }).error, /被改過/);
  assert.equal(await read(), outside, 'the outside edit is untouched');
  assert.deepEqual((r.json as { history: unknown }).history, { undo: 0, redo: 0 });
});

test('nothing to undo / redo → 409 with a plain message', async () => {
  const u = await call('undo', { tripId: T });
  const r = await call('redo', { tripId: T });
  assert.equal(u.status, 409);
  assert.equal(r.status, 409);
  assert.match((u.json as { error: string }).error, /沒有可以復原/);
  assert.match((r.json as { error: string }).error, /沒有可以重做/);
});

test('bad ids are rejected like every other endpoint; without a history the endpoints do nothing', async () => {
  assert.equal((await call('undo', { tripId: '../etc' })).status, 400);
  assert.equal((await call('history', { tripId: T, file: 'x.js' })).status, 400);
  const none = await handleTripcodeRequest('undo', { tripId: T }, { root, edits, now, env: {} });
  assert.equal(none.status, 400);
});
