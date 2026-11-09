import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, test } from 'node:test';
import { handleTripcodeRequest } from './vite-plugin-tripcode.ts';
import type { SourceEdits } from './vite-plugin-tripcode.ts';
import * as realEdits from './src/core/source-edit.ts';
import { EditHistory } from './src/core/history.ts';

const edits = realEdits as unknown as SourceEdits;
const T = 'color-trip';
const SRC = `export default defineTrip({\n  days: [\n    { date: '2026-11-21', items: [] },\n    { date: '2026-11-22', items: [] },\n    { date: '2026-11-23', items: [] },\n  ],\n});\n`;
let root: string;
let history: EditHistory;
const file = () => path.join(root, 'trips', T, 'trip.ts');
const call = (ep: string, body: unknown) => handleTripcodeRequest(ep, body, { root, edits, env: {}, history });
const colors = async () => [...(await readFile(file(), 'utf8')).matchAll(/date: '([\d-]+)'[^}]*?color: (\d)/g)].map((m) => `${m[1]}=${m[2]}`);

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'tripcode-daycolor-'));
  history = new EditHistory();
  await mkdir(path.join(root, 'trips', T), { recursive: true });
  await writeFile(file(), SRC);
});

test('one request colors several days at once, and one undo takes them all back', async () => {
  const r = await call('day-color', { tripId: T, file: 'trip.ts', dates: ['2026-11-21', '2026-11-22'], color: 4 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(await colors(), ['2026-11-21=4', '2026-11-22=4']);
  const u = await call('undo', { tripId: T, file: 'trip.ts' });
  assert.equal(u.status, 200, JSON.stringify(u.json));
  assert.equal(await readFile(file(), 'utf8'), SRC);
});

test('color null removes the override', async () => {
  await call('day-color', { tripId: T, file: 'trip.ts', dates: ['2026-11-23'], color: 2 });
  assert.deepEqual(await colors(), ['2026-11-23=2']);
  const r = await call('day-color', { tripId: T, file: 'trip.ts', dates: ['2026-11-23'], color: null });
  assert.equal(r.status, 200);
  assert.equal(await readFile(file(), 'utf8'), SRC);
});

test('a bad color, a bad or unknown date or an empty list is refused and the file is untouched', async () => {
  const bad = [
    { dates: ['2026-11-21'], color: 0 },
    { dates: ['2026-11-21'], color: 9 },
    { dates: ['2026-11-21'], color: '3' },
    { dates: ['2026-11-21'] },
    { dates: [], color: 3 },
    { dates: ['2026-12-31'], color: 3 },
    { dates: ['2026-11-21', '2026-12-31'], color: 3 },
    { dates: ['soon'], color: 3 },
    { color: 3 },
  ];
  for (const b of bad) assert.equal((await call('day-color', { tripId: T, file: 'trip.ts', ...b })).status, 400, JSON.stringify(b));
  assert.equal(await readFile(file(), 'utf8'), SRC);
});
