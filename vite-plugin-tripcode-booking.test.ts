import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, test } from 'node:test';
import { handleTripcodeRequest } from './vite-plugin-tripcode.ts';
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
const read = () => readFile(path.join(root, 'trips', T, 'trip.ts'), 'utf8');

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'tripcode-booking-'));
  history = new EditHistory();
  await mkdir(path.join(root, 'trips', T), { recursive: true });
  await copyFile(path.join(REPO, 'trips', T, 'trip.ts'), path.join(root, 'trips', T, 'trip.ts'));
});

test('「我買好了」: booking booked, item locked, times set, bought-via recorded, in one undoable step', async () => {
  const original = await read();
  const r = await call('booking', { tripId: T, itemId: 'senso-ji', action: 'booked', need: 'required', via: 'Klook', start: '10:00', end: '11:30' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const after = await read();
  assert.match(after, /booking: \{ need: 'required', status: 'booked', bookedAt: '2026-05-01T10:00:00.000Z', boughtVia: 'Klook' \}/);
  assert.match(after, /locked: true/);
  assert.match(after, /start: '10:00'/);
  assert.deepEqual(((r.json as { history: { undo: number; undoLabel: string } }).history), { undo: 1, redo: 0, undoLabel: '訂票狀態', undoItemId: 'senso-ji' });
  const undone = await call('undo', { tripId: T });
  assert.equal(undone.status, 200);
  assert.equal(await read(), original, 'one undo restores everything');
});

test('「不需要」 and back to 待買', async () => {
  await call('booking', { tripId: T, itemId: 'senso-ji', action: 'not-needed' });
  assert.match(await read(), /booking: \{ need: 'none', status: 'not-needed' \}/);
  await call('booking', { tripId: T, itemId: 'senso-ji', action: 'todo' });
  assert.match(await read(), /booking: \{ need: 'none', status: 'todo' \}/);
});

test('a row that was only guessed (no booking field) can still be set back to 待買', async () => {
  await call('booking', { tripId: T, itemId: 'senso-ji', action: 'todo', need: 'required' });
  assert.match(await read(), /booking: \{ need: 'required', status: 'todo' \}/);
});

test('bad input is refused before anything is written', async () => {
  const original = await read();
  for (const body of [
    { tripId: T, itemId: 'senso-ji', action: 'pay' },
    { tripId: T, itemId: 'nope', action: 'booked' },
    { tripId: T, itemId: 'senso-ji', action: 'booked', start: '25:00' },
    { tripId: T, itemId: 'senso-ji', action: 'booked', need: 'maybe' },
    { tripId: '../x', itemId: 'senso-ji', action: 'booked' },
  ]) assert.equal((await call('booking', body)).status, 400, JSON.stringify(body));
  assert.equal(await read(), original);
});

test('meal: adds a new meal item at the right place, with a place from a pasted Google Maps link', async () => {
  const r = await call('meal', { tripId: T, date: '2027-10-09', title: '', mapsUrl: 'https://www.google.com/maps/place/Ichiran+Ramen/@35.69,139.70,17z/data=!3d35.6895!4d139.7006' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const id = (r.json as { id: string }).id;
  assert.match(id, /^meal-ichiran-ramen-/);
  const src = await read();
  assert.match(src, new RegExp(`id: '${id}'`));
  assert.match(src, /title: 'Ichiran Ramen'/);
  assert.match(src, /lat: 35\.6895, lng: 139\.7006, fetchedAt: '2026-05-01T10:00:00\.000Z'/);
  assert.equal((await call('undo', { tripId: T })).status, 200);
  assert.ok(!(await read()).includes(id));
});

test('meal: fills an existing placeholder instead of adding another; refuses short links and empty input', async () => {
  const placeholder = await call('meal', { tripId: T, date: '2027-10-09', title: '午餐：待選' });
  const pid = (placeholder.json as { id: string }).id;
  const r = await call('meal', { tripId: T, date: '2027-10-09', existingItemId: pid, title: 'Sushi Dai', mapsUrl: 'https://www.google.com/maps/search/?api=1&query=35.64,139.78' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const src = await read();
  assert.equal(src.match(new RegExp(`id: '${pid}'`, 'g'))?.length, 1);
  assert.match(src, /title: 'Sushi Dai'/);
  assert.equal((await call('meal', { tripId: T, date: '2027-10-09', title: 'x', mapsUrl: 'https://maps.app.goo.gl/abc' })).status, 400);
  assert.equal((await call('meal', { tripId: T, date: '2027-10-09', title: '' })).status, 400);
  assert.equal((await call('meal', { tripId: T, date: '2030-01-01', title: 'x' })).status, 400);
});

test('「這天就這樣」: writes accepted on the day, one undo step, refuses unknown codes and unknown days', async () => {
  const original = await read();
  const r = await call('accept', { tripId: T, date: '2027-10-09', codes: ['walking-heavy'] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.match(await read(), /accepted: \['walking-heavy'\]/);
  assert.equal((await call('undo', { tripId: T })).status, 200);
  assert.equal(await read(), original);
  assert.equal((await call('accept', { tripId: T, date: '2027-10-09', codes: ['pay-now'] })).status, 400);
  assert.equal((await call('accept', { tripId: T, date: '2030-01-01', codes: ['no-easy-day'] })).status, 400);
});
