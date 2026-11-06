import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { before, describe, test } from 'node:test';
import type { CliContext } from './context.ts';
import type { Trip } from '../src/core/types.ts';
import { run } from './tripcode.ts';

// Four stops roughly on a north-south line near Lucerne; the day visits them out of order.
const at = (lat: number) => ({ lat, lng: 8.3 });
const trip: Trip = {
  title: '測試',
  start: '2027-06-12',
  end: '2027-06-13',
  tz: 'Europe/Zurich',
  party: { adults: 2, childrenAges: [] },
  days: [
    {
      date: '2027-06-12',
      title: '亂序的一天',
      items: [
        { id: 'hotel', kind: 'hotel', title: '飯店', nights: 1, loc: at(47.0), locked: true },
        { id: 'far', kind: 'poi', title: '遠景點', loc: at(47.3) },
        { id: 'walk', kind: 'transit', mode: 'walk', title: '步行' },
        { id: 'near', kind: 'poi', title: '近景點', loc: at(47.05) },
        { id: 'mid', kind: 'poi', title: '中景點', loc: at(47.15) },
      ],
    },
    { date: '2027-06-13', items: [{ id: 'solo', kind: 'poi', title: '單點', loc: at(47.0) }] },
  ],
  candidates: [{ id: 'c1', title: '候選', loc: at(47.1), status: 'unconfirmed', sources: ['claude'] }],
};

let root: string;
let out: string;
let err: string;
let calls: { url: string; init: RequestInit }[];
let payload: unknown;

function ctxWith(env: Record<string, string | undefined>): CliContext {
  out = '';
  err = '';
  calls = [];
  return {
    root,
    env,
    fetch: async (url, init) => {
      calls.push({ url, init: init ?? {} });
      return new Response(JSON.stringify(payload), { status: 200 });
    },
    stdout: (s) => (out += s),
    stderr: (s) => (err += s),
    now: () => new Date('2027-06-01T10:00:00.000Z'),
    loadCore: async () => ({}) as never,
    loadTrip: async () => trip,
  };
}

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'tripcode-opt-'));
  await mkdir(path.join(root, 'trips', 'demo'), { recursive: true });
  await writeFile(path.join(root, 'trips', 'demo', 'trip.ts'), '// stub');
});

describe('optimize --offline', () => {
  test('proposes a shorter order, labelled as an estimate, and does not touch the trip file', async () => {
    const ctx = ctxWith({});
    assert.equal(await run(['optimize', 'demo', '--day', '1', '--offline'], ctx), 0);
    assert.equal(calls.length, 0, 'offline never fetches');
    assert.equal(err, '', 'explicit --offline is not a warning');
    const j = JSON.parse(out);
    assert.equal(j.source, 'haversine-estimate');
    assert.equal(j.confidence, 'reference');
    assert.equal(j.estimate, true);
    assert.deepEqual(j.current, ['hotel', 'far', 'near', 'mid']);
    assert.deepEqual(j.order, ['hotel', 'near', 'mid', 'far']);
    assert.ok(j.after < j.before);
    assert.equal(j.savedMinutes, j.before - j.after);
    assert.equal(j.changed, true);
    assert.match(j.moves[0], /^把 .+ 移到 .+ 之前，少走 \d+ 分鐘$/);
    assert.equal(j.matrix.length, 4);
    assert.ok(j.notes.some((n: string) => /直線估算/.test(n)));
    assert.equal(await readFile(path.join(root, 'trips/demo/trip.ts'), 'utf8'), '// stub');
    assert.deepEqual(await readdir(path.join(root, 'trips', 'demo')), ['trip.ts']);
  });

  test('--pretty shows current and suggested order', async () => {
    assert.equal(await run(['optimize', 'demo', '--day', '1', '--offline', '--pretty'], ctxWith({})), 0);
    assert.match(out, /目前順序/);
    assert.match(out, /建議順序/);
    assert.match(out, /飯店（已確定）/);
    assert.match(out, /直線估算/);
  });

  test('--keep keeps the relative order and rejects unknown ids', async () => {
    assert.equal(await run(['optimize', 'demo', '--day', '1', '--offline', '--keep', 'far,near'], ctxWith({})), 0);
    const j = JSON.parse(out);
    assert.ok(j.order.indexOf('far') < j.order.indexOf('near'));
    assert.equal(await run(['optimize', 'demo', '--day', '1', '--offline', '--keep', 'nope'], ctxWith({})), 1);
    assert.match(err, /--keep/);
  });

  test('a day with fewer than two stops needs no optimization', async () => {
    assert.equal(await run(['optimize', 'demo', '--day', '2', '--offline'], ctxWith({})), 0);
    const j = JSON.parse(out);
    assert.equal(j.changed, false);
    assert.deepEqual(j.moves, []);
  });

  test('argument errors', async () => {
    assert.equal(await run(['optimize', 'demo', '--offline'], ctxWith({})), 1);
    assert.match(err, /--day/);
    assert.equal(await run(['optimize', 'demo', '--day', '0'], ctxWith({})), 1);
    assert.equal(await run(['optimize', 'demo', '--day', '9', '--offline'], ctxWith({})), 1);
    assert.match(err, /沒有第 9 天/);
    assert.equal(await run(['optimize', 'demo', '--day', '1', '--mode', 'rocket'], ctxWith({})), 1);
    assert.equal(await run(['optimize', 'ghost', '--day', '1'], ctxWith({})), 1);
    assert.match(err, /找不到行程檔/);
    assert.equal(await run(['optimize', '--day', '1'], ctxWith({})), 1);
  });
});

describe('optimize with a key', () => {
  test('missing key falls back to the estimate and says so on stderr', async () => {
    assert.equal(await run(['optimize', 'demo', '--day', '1'], ctxWith({})), 0);
    assert.match(err, /GOOGLE_MAPS_API_KEY/);
    const j = JSON.parse(out);
    assert.equal(j.source, 'haversine-estimate');
    assert.equal(j.confidence, 'reference');
  });

  test('calls computeRouteMatrix with the injected fetch and uses its minutes', async () => {
    // Stops: hotel(0) far(1) near(2) mid(3). Make travel symmetric = |index distance by latitude|.
    const lat = [47.0, 47.3, 47.05, 47.15];
    const els: unknown[] = [];
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        els.push({ originIndex: i, destinationIndex: j, duration: `${Math.round(Math.abs(lat[i]! - lat[j]!) * 6000)}s`, condition: 'ROUTE_EXISTS' });
      }
    }
    payload = els;
    const ctx = ctxWith({ GOOGLE_MAPS_API_KEY: 'K' });
    assert.equal(await run(['optimize', 'demo', '--day', '1', '--mode', 'walk'], ctx), 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix');
    const h = calls[0]!.init.headers as Record<string, string>;
    assert.equal(h['X-Goog-Api-Key'], 'K');
    assert.equal(h['X-Goog-FieldMask'], 'originIndex,destinationIndex,duration,condition');
    const body = JSON.parse(String(calls[0]!.init.body));
    assert.equal(body.travelMode, 'WALK');
    assert.equal(body.origins.length, 4);
    assert.deepEqual(body.origins[1], { waypoint: { location: { latLng: { latitude: 47.3, longitude: 8.3 } } } });
    const j = JSON.parse(out);
    assert.equal(j.source, 'google-routes');
    assert.equal(j.confidence, 'live');
    assert.equal(j.estimate, false);
    assert.deepEqual(j.order, ['hotel', 'near', 'mid', 'far']);
    assert.equal(j.matrix[0][1], 30);
  });

  test('pairs Google could not route are filled from the estimate and reported', async () => {
    payload = [
      { originIndex: 0, destinationIndex: 1, duration: '600s', condition: 'ROUTE_EXISTS' },
      { originIndex: 1, destinationIndex: 0, condition: 'ROUTE_NOT_FOUND' },
    ];
    assert.equal(await run(['optimize', 'demo', '--day', '1'], ctxWith({ GOOGLE_MAPS_API_KEY: 'K' })), 0);
    const j = JSON.parse(out);
    assert.ok(j.notes.some((n: string) => /查無結果/.test(n)));
    assert.equal(j.matrix[0][1], 10);
    assert.ok(j.matrix[1][0] > 0);
  });

  test('API failure is reported, not silently estimated', async () => {
    const ctx = ctxWith({ GOOGLE_MAPS_API_KEY: 'K' });
    ctx.fetch = async () => new Response(JSON.stringify({ error: { message: 'denied' } }), { status: 403 });
    assert.equal(await run(['optimize', 'demo', '--day', '1'], ctx), 1);
    assert.match(err, /denied/);
  });
});

describe('export kml', () => {
  test('writes trips/<id>/export/trip.kml (and a variant name for --file)', async () => {
    assert.equal(await run(['export', 'kml', 'demo'], ctxWith({})), 0);
    assert.equal(JSON.parse(out).written, path.join('trips', 'demo', 'export', 'trip.kml'));
    const kml = await readFile(path.join(root, 'trips/demo/export/trip.kml'), 'utf8');
    assert.match(kml, /<kml xmlns="http:\/\/www\.opengis\.net\/kml\/2\.2">/);
    assert.match(kml, /Day 1 · 06\/12 亂序的一天/);
    assert.match(kml, /候選（未確認）/);
    await writeFile(path.join(root, 'trips', 'demo', 'variant-b.ts'), '// stub');
    assert.equal(await run(['export', 'kml', 'demo', '--file', 'variant-b.ts'], ctxWith({})), 0);
    assert.match(await readFile(path.join(root, 'trips/demo/export/variant-b.kml'), 'utf8'), /<kml /);
  });
});
