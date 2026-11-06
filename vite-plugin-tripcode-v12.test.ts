import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, test } from 'node:test';
import { ENDPOINTS, handleTripcodeRequest, bodyLimitFor } from './vite-plugin-tripcode.ts';
import type { SourceEdits } from './vite-plugin-tripcode.ts';
import * as realEdits from './src/core/source-edit.ts';
import { checkTrip } from './src/core/check.ts';

const edits = realEdits as unknown as SourceEdits;
const now = () => new Date('2026-05-01T10:00:00.000Z');

function evalTrip(src: string): any {
  const body = src.replace(/^import .*$/m, '').replace(/export default defineTrip\(/, 'return (');
  return new Function(body)();
}

let root: string;
const call = (ep: string, body: unknown) => handleTripcodeRequest(ep, body, { root, edits, now, env: {} });
const tripPath = () => path.join(root, 'trips', 'tokyo-sample', 'trip.ts');
const read = () => readFile(tripPath(), 'utf8');
const trip = async () => evalTrip(await read());
const T = 'tokyo-sample';

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'tripcode-v12-'));
  await mkdir(path.join(root, 'trips', T), { recursive: true });
  await copyFile(path.join(import.meta.dirname, 'trips', T, 'trip.ts'), tripPath());
});

test('endpoints are registered with the default body limit', () => {
  assert.ok(ENDPOINTS.includes('move-item' as never) && ENDPOINTS.includes('schedule-candidate' as never));
  assert.equal(bodyLimitFor('move-item'), 1_000_000);
});

describe('move-item', () => {
  test('reorders within a day, moves across days, and keeps the file valid', async () => {
    const t0 = await trip();
    const [a, b] = t0.days[0].items.map((i: any) => i.id);
    const r = await call('move-item', { tripId: T, itemId: a, toDate: t0.days[0].date, beforeItemId: b });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(await read(), evalSame(await read()));
    assert.deepEqual((r.json as any), { ok: true, itemId: a, toDate: t0.days[0].date });
    const r2 = await call('move-item', { tripId: T, itemId: a, toDate: t0.days[1].date });
    assert.equal(r2.status, 200);
    const t = await trip();
    assert.equal(t.days[1].items.at(-1).id, a);
    assert.ok(!t.days[0].items.some((i: any) => i.id === a));
    const total = (x: any) => x.days.reduce((n: number, d: any) => n + d.items.length, 0);
    assert.equal(total(t), total(t0));
    assert.ok(Array.isArray(checkTrip(t)));
  });

  test('same position is a byte-identical no-op', async () => {
    const t0 = await trip();
    const items = t0.days[0].items;
    const before = await read();
    const r = await call('move-item', { tripId: T, itemId: items[0].id, toDate: t0.days[0].date, beforeItemId: items[1].id });
    assert.equal(r.status, 200);
    assert.equal(await read(), before);
  });

  test('validates ids, dates and files; writes nothing on failure', async () => {
    const t0 = await trip();
    const id = t0.days[0].items[0].id;
    const d0 = t0.days[0].date;
    const cand = t0.candidates[0].id;
    const before = await read();
    const bads: any[] = [
      {}, { tripId: T }, { tripId: T, itemId: id }, { tripId: T, itemId: id, toDate: '2099-01-01' }, { tripId: T, itemId: id, toDate: 'tomorrow' },
      { tripId: T, itemId: 'nope', toDate: d0 }, { tripId: T, itemId: cand, toDate: d0 }, { tripId: T, itemId: 'Bad Id!', toDate: d0 },
      { tripId: T, itemId: id, toDate: d0, beforeItemId: id }, { tripId: T, itemId: id, toDate: d0, beforeItemId: 'nope' },
      { tripId: T, itemId: id, toDate: d0, beforeItemId: 5 }, { tripId: T, itemId: 5, toDate: d0 },
      { tripId: T, itemId: id, toDate: t0.days[1].date, beforeItemId: t0.days[0].items[1].id },
      { tripId: T, itemId: id, toDate: d0, file: '../trip.ts' }, { tripId: '../x', itemId: id, toDate: d0 }, { tripId: 'nope', itemId: id, toDate: d0 },
      { tripId: T, itemId: id, toDate: d0, file: 'missing.ts' },
    ];
    for (const bd of bads) {
      const r = await call('move-item', bd);
      assert.equal(r.status, 400, JSON.stringify(bd));
      assert.equal(r.json.ok, false);
    }
    assert.equal(await read(), before);
  });
});

describe('schedule-candidate', () => {
  test('turns a candidate into a poi at the end or before an item', async () => {
    const t0 = await trip();
    const cand = t0.candidates[0];
    const d = t0.days[1];
    const r = await call('schedule-candidate', { tripId: T, candidateId: cand.id, toDate: d.date, beforeItemId: d.items[0].id });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json, { ok: true, id: cand.id, toDate: d.date });
    const t = await trip();
    const moved = t.days[1].items[0];
    assert.equal(moved.id, cand.id);
    assert.equal(moved.kind, 'poi');
    assert.equal(moved.title, cand.title);
    assert.deepEqual(moved.loc, cand.loc);
    assert.equal(moved.note, cand.why);
    assert.equal(t.candidates.length, t0.candidates.length - 1);
    const r2 = await call('schedule-candidate', { tripId: T, candidateId: t0.candidates[1].id, toDate: d.date });
    assert.equal(r2.status, 200);
    assert.equal((await trip()).days[1].items.at(-1).id, t0.candidates[1].id);
  });

  test('validates ids and dates; scheduling twice fails', async () => {
    const t0 = await trip();
    const cand = t0.candidates[0].id;
    const d0 = t0.days[0].date;
    const before = await read();
    const bads: any[] = [
      { tripId: T, candidateId: 'nope', toDate: d0 }, { tripId: T, candidateId: t0.days[0].items[0].id, toDate: d0 },
      { tripId: T, candidateId: cand, toDate: '2099-01-01' }, { tripId: T, candidateId: cand }, { tripId: T, toDate: d0 },
      { tripId: T, candidateId: cand, toDate: d0, beforeItemId: cand }, { tripId: T, candidateId: cand, toDate: d0, beforeItemId: 'nope' },
      { tripId: T, candidateId: 'a b', toDate: d0 },
    ];
    for (const bd of bads) assert.equal((await call('schedule-candidate', bd)).status, 400, JSON.stringify(bd));
    assert.equal(await read(), before);
    assert.equal((await call('schedule-candidate', { tripId: T, candidateId: cand, toDate: d0 })).status, 200);
    assert.equal((await call('schedule-candidate', { tripId: T, candidateId: cand, toDate: d0 })).status, 400);
  });
});

describe('add-candidate with day', () => {
  test('inserts a poi at the end of that day', async () => {
    const t0 = await trip();
    const body = { tripId: T, title: 'New Spot', loc: { lat: 35.1234567, lng: 139.5 }, placeId: 'osm:node/1', day: 2 };
    const r = await call('add-candidate', body);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal((r.json as any).scheduled, true);
    assert.deepEqual((r.json as any).item, {
      id: 'new-spot', kind: 'poi', title: 'New Spot', placeId: 'osm:node/1', loc: { lat: 35.123457, lng: 139.5, fetchedAt: '2026-05-01T10:00:00.000Z' },
    });
    const t = await trip();
    assert.deepEqual(t.days[1].items.at(-1), (r.json as any).item);
    assert.equal(t.candidates.length, t0.candidates.length);
  });
});

function evalSame(s: string): string {
  evalTrip(s); // throws when the file no longer parses
  return s;
}
