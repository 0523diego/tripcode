import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, test } from 'node:test';
import { ENDPOINTS, bodyLimitFor, handleTripcodeRequest } from './vite-plugin-tripcode.ts';
import type { HandlerDeps, SourceEdits } from './vite-plugin-tripcode.ts';
import * as realEdits from './src/core/source-edit.ts';
import { checkTrip } from './src/core/check.ts';
import type { Trip } from './src/core/types.ts';

const edits = realEdits as unknown as SourceEdits;
const now = () => new Date('2026-05-01T10:00:00.000Z');
const REPO = import.meta.dirname;

function evalTrip(src: string): any {
  const body = src.replace(/^import .*$/m, '').replace(/export default defineTrip\(/, 'return (');
  return new Function(body)();
}

let root: string;
const call = (ep: string, body: unknown, extra: Partial<HandlerDeps> = {}) => handleTripcodeRequest(ep, body, { root, edits, now, env: {}, ...extra });
const tripPath = () => path.join(root, 'trips', 'tokyo-sample', 'trip.ts');
const read = () => readFile(tripPath(), 'utf8');
const trip = async () => evalTrip(await read());
const T = 'tokyo-sample';

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'tripcode-v13-'));
  await mkdir(path.join(root, 'trips', T), { recursive: true });
  await copyFile(path.join(REPO, 'trips', T, 'trip.ts'), tripPath());
});

test('endpoints are registered with the default body limit', () => {
  for (const ep of ['remove-item', 'set-locked', 'optimize']) {
    assert.ok(ENDPOINTS.includes(ep as never), ep);
    assert.equal(bodyLimitFor(ep), 1_000_000);
  }
});

describe('remove-item', () => {
  test('removes the item and its attached comment, responds {ok, itemId}, file stays valid', async () => {
    await call('comment', { tripId: T, targetId: 'senso-ji', anchor: 'item', text: '早點去' });
    assert.match(await read(), /@trip-comment\(item\): 早點去/);
    const before = await trip();
    const r = await call('remove-item', { tripId: T, itemId: 'senso-ji' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json, { ok: true, itemId: 'senso-ji' });
    const src = await read();
    assert.ok(!src.includes('senso-ji') && !src.includes('早點去'));
    const after = await trip();
    const count = (t: any) => t.days.reduce((n: number, d: any) => n + d.items.length, 0);
    assert.equal(count(after), count(before) - 1);
    assert.deepEqual(checkTrip(after).filter((i) => i.level === 'error'), []);
  });

  test('unknown id, a candidate id and bad input → 400 and nothing is written', async () => {
    const before = await read();
    for (const body of [
      { tripId: T, itemId: 'nope' },
      { tripId: T, itemId: 'ghibli-museum' },
      { tripId: T },
      { tripId: T, itemId: "x' }" },
      { tripId: 'Bad Id', itemId: 'senso-ji' },
      { tripId: T, file: '../trip.ts', itemId: 'senso-ji' },
    ]) {
      const r = await call('remove-item', body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.json.ok, false);
    }
    assert.equal(await read(), before);
  });
});

describe('set-locked', () => {
  test('locks, unlocks (property removed) and echoes {ok, itemId, locked}', async () => {
    const r = await call('set-locked', { tripId: T, itemId: 'senso-ji', locked: true });
    assert.deepEqual(r.json, { ok: true, itemId: 'senso-ji', locked: true });
    const locked = await trip();
    assert.equal(locked.days[1].items.find((i: any) => i.id === 'senso-ji').locked, true);
    const r2 = await call('set-locked', { tripId: T, itemId: 'senso-ji', locked: false });
    assert.deepEqual(r2.json, { ok: true, itemId: 'senso-ji', locked: false });
    assert.equal(await read(), await readFile(path.join(REPO, 'trips', T, 'trip.ts'), 'utf8'));
  });

  test('unlocking an already-locked item removes `locked`; other fields are untouched', async () => {
    const r = await call('set-locked', { tripId: T, itemId: 'hotel-shinjuku', locked: false });
    assert.equal(r.status, 200);
    const t = await trip();
    const hotel = t.days[0].items.find((i: any) => i.id === 'hotel-shinjuku');
    assert.equal('locked' in hotel, false);
    assert.equal(hotel.nights, 3);
  });

  test('validation: locked must be a boolean; unknown ids → 400', async () => {
    for (const body of [
      { tripId: T, itemId: 'senso-ji', locked: 'true' },
      { tripId: T, itemId: 'senso-ji' },
      { tripId: T, itemId: 'nope', locked: true },
      { tripId: T, itemId: 'ghibli-museum', locked: true },
    ]) {
      const r = await call('set-locked', body);
      assert.equal(r.status, 400, JSON.stringify(body));
    }
  });
});

describe('optimize', () => {
  const real = { root: REPO };

  test('returns the documented shape from a keyless haversine estimate and never writes', async () => {
    const before = await readFile(path.join(REPO, 'trips', T, 'trip.ts'), 'utf8');
    const r = await call('optimize', { tripId: T, day: 2 }, real);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const j = r.json as any;
    assert.equal(j.ok, true);
    assert.equal(j.source, 'haversine-estimate');
    assert.equal(j.confidence, 'reference');
    assert.equal(typeof j.currentMinutes, 'number');
    assert.equal(typeof j.bestMinutes, 'number');
    assert.equal(j.savedMinutes, j.currentMinutes - j.bestMinutes);
    assert.ok(j.bestMinutes <= j.currentMinutes && j.savedMinutes >= 0);
    assert.ok(Array.isArray(j.order) && j.order.every((x: unknown) => typeof x === 'string'));
    assert.equal(await readFile(path.join(REPO, 'trips', T, 'trip.ts'), 'utf8'), before);
  });

  const at = (lat: number) => ({ lat, lng: 8.3 });
  const fake: Trip = {
    title: 't', start: '2027-06-12', end: '2027-06-12', tz: 'Europe/Zurich', party: { adults: 1, childrenAges: [] }, candidates: [],
    days: [
      { date: '2027-06-12', items: [
        { id: 'a', kind: 'poi', title: 'A', loc: at(47.0) },
        { id: 'far', kind: 'poi', title: 'Far', loc: at(47.3) },
        { id: 'near', kind: 'poi', title: 'Near', loc: at(47.05) },
      ] },
      { date: '2027-06-13', items: [{ id: 'solo', kind: 'poi', title: 'Solo', loc: at(47.0) }] },
    ],
  } as Trip;
  const loadTrip = async () => fake;

  test('finds a shorter order for an out-of-order day', async () => {
    const r = await call('optimize', { tripId: T, day: 1 }, { loadTrip });
    const j = r.json as any;
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(j.order, ['a', 'near', 'far']);
    assert.ok(j.savedMinutes > 0);
    assert.equal(j.changed, true);
  });

  test('a day with fewer than two routable stops is a zero-saving no-op', async () => {
    const r = await call('optimize', { tripId: T, day: 2 }, { loadTrip });
    assert.deepEqual({ ...(r.json as any), notes: undefined }, { ok: true, currentMinutes: 0, bestMinutes: 0, savedMinutes: 0, order: ['solo'], source: 'haversine-estimate', confidence: 'reference', changed: false, notes: undefined });
  });

  test('with a Google key it uses the Routes matrix and reports google-routes', async () => {
    let calls = 0;
    const fetchFake = async (url: string) => {
      calls++;
      assert.match(url, /computeRouteMatrix/);
      // 3 stops: symmetric 10-minute hops except a↔far which is 100 minutes.
      const dur = (i: number, j: number) => (i === j ? 0 : (i === 0 && j === 1) || (i === 1 && j === 0) ? 6000 : 600);
      const els = [];
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) els.push({ originIndex: i, destinationIndex: j, duration: `${dur(i, j)}s`, condition: 'ROUTE_EXISTS' });
      return new Response(JSON.stringify(els), { status: 200 });
    };
    const r = await call('optimize', { tripId: T, day: 1 }, { loadTrip, env: { GOOGLE_MAPS_API_KEY: 'k' }, fetch: fetchFake });
    const j = r.json as any;
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(calls, 1);
    assert.equal(j.source, 'google-routes');
    assert.equal(j.confidence, 'live');
    assert.deepEqual(j.order, ['a', 'near', 'far']);
  });

  test('a failing Google call falls back to the estimate and says so', async () => {
    const fetchFake = async () => new Response('nope', { status: 500 });
    const r = await call('optimize', { tripId: T, day: 1 }, { loadTrip, env: { GOOGLE_MAPS_API_KEY: 'k' }, fetch: fetchFake });
    const j = r.json as any;
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(j.source, 'haversine-estimate');
    assert.ok(j.notes.some((n: string) => n.includes('Google')));
  });

  test('validation: bad day / mode / missing trip → 400', async () => {
    for (const body of [
      { tripId: T },
      { tripId: T, day: 0 },
      { tripId: T, day: 1.5 },
      { tripId: T, day: '1' },
      { tripId: T, day: 9 },
      { tripId: T, day: 1, mode: 'fly' },
      { tripId: 'no-such-trip', day: 1 },
    ]) {
      const r = await call('optimize', body, real);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.json.ok, false);
    }
  });
});
