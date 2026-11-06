import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { before, describe, test } from 'node:test';
import { CliError, parseArgs } from './context.ts';
import type { CliContext, Core } from './context.ts';
import type { Trip } from '../src/core/types.ts';
import { run } from './tripcode.ts';

const trip: Trip = {
  title: '瑞士',
  start: '2026-05-02',
  end: '2026-05-03',
  tz: 'Europe/Zurich',
  party: { adults: 2, childrenAges: [] },
  days: [
    { date: '2026-05-02', title: '露臺恩', items: [{ id: 'bridge', kind: 'poi', title: '卡貝爾橋', placeId: 'PB', start: '09:30' }, { id: 'lunch', kind: 'meal', title: '午餐' }] },
    { date: '2026-05-03', items: [] },
  ],
  candidates: [],
};

let root: string;
let out: string;
let err: string;
let fetchCalls: { url: string; init: RequestInit }[];
let fetchPayload: unknown;
let core: Core;
let hoursSeen: unknown;

function ctxWith(env: Record<string, string | undefined>): CliContext {
  out = '';
  err = '';
  fetchCalls = [];
  return {
    root,
    env,
    fetch: async (url, init) => {
      fetchCalls.push({ url, init: init ?? {} });
      return new Response(JSON.stringify(fetchPayload), { status: 200 });
    },
    stdout: (s) => (out += s),
    stderr: (s) => (err += s),
    now: () => new Date('2026-05-01T10:00:00.000Z'),
    loadCore: async () => core,
    loadTrip: async () => trip,
  };
}

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'tripcode-cli-'));
  await mkdir(path.join(root, 'trips', 'swiss'), { recursive: true });
  await writeFile(path.join(root, 'trips', 'swiss', 'trip.ts'), '// stub');
  await writeFile(path.join(root, 'trips', 'swiss', 'variant-b.ts'), '// stub');
  await mkdir(path.join(root, 'trips', 'not-a-trip'), { recursive: true });
  core = {
    checkTrip: (_t, opts) => {
      hoursSeen = opts?.hoursFor?.({ placeId: 'PB' });
      return [{ level: 'warn', code: 'transit-gap', date: '2026-05-02', itemId: 'bridge', message: '轉乘時間不足' }];
    },
    dayMapsLinks: (d) => (d.items.length ? [`https://maps.example/${d.date}`] : []),
    tripToIcs: () => 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n',
  };
});

describe('parseArgs', () => {
  test('flags, = form, positionals, negative coords', () => {
    const a = parseArgs(['places', 'search', 'a b', '--near=1,2', '--pretty', '--lang', 'zh-TW', '-33.8,151.2']);
    assert.deepEqual(a.positionals, ['places', 'search', 'a b', '-33.8,151.2']);
    assert.deepEqual(a.flags, { near: '1,2', pretty: true, lang: 'zh-TW' });
  });
  test('errors', () => {
    assert.throws(() => parseArgs(['--bogus']), CliError);
    assert.throws(() => parseArgs(['--near']), CliError);
    assert.throws(() => parseArgs(['--pretty=1']), CliError);
  });
});

describe('dispatch', () => {
  test('no command prints usage and exits 1; --help exits 0', async () => {
    assert.equal(await run([], ctxWith({})), 1);
    assert.match(out, /places search/);
    assert.equal(await run(['--help'], ctxWith({})), 0);
  });
  test('unknown command', async () => {
    assert.equal(await run(['frobnicate'], ctxWith({})), 1);
    assert.match(err, /未知的指令/);
  });
});

describe('google commands', () => {
  test('no key: places search uses OSM (informational note, not an error)', async () => {
    fetchPayload = [{ osm_type: 'way', osm_id: 7, lat: '47.05', lon: '8.30', name: 'Kapellbrücke', display_name: 'Kapellbrücke, Luzern' }];
    const ctx = ctxWith({});
    assert.equal(await run(['places', 'search', 'Kapellbrücke', '--near', '47,8'], ctx), 0);
    assert.match(err, /OpenStreetMap/);
    assert.equal(fetchCalls.length, 1);
    assert.match(fetchCalls[0]!.url, /^https:\/\/nominatim\.openstreetmap\.org\/search\?/);
    assert.match((fetchCalls[0]!.init.headers as Record<string, string>)['User-Agent']!, /^TripCode\//);
    const j = JSON.parse(out);
    assert.equal(j.source, 'openstreetmap-nominatim');
    assert.equal(j.results[0].placeId, 'osm:way/7');
  });
  test('--provider google without key is an error; unknown provider too', async () => {
    assert.equal(await run(['places', 'search', 'x', '--provider', 'google'], ctxWith({})), 1);
    assert.match(err, /GOOGLE_MAPS_API_KEY/);
    assert.equal(fetchCalls.length, 0);
    assert.equal(await run(['places', 'search', 'x', '--provider', 'bing'], ctxWith({})), 1);
  });
  test('places details: Google id without key explains; bad osm id rejected', async () => {
    assert.equal(await run(['places', 'details', 'P'], ctxWith({})), 1);
    assert.match(err, /GOOGLE_MAPS_API_KEY/);
    assert.equal(await run(['places', 'details', 'osm:foo'], ctxWith({})), 1);
    assert.equal(fetchCalls.length, 0);
  });
  test('routes without key → haversine estimate, no fetch', async () => {
    const ctx = ctxWith({});
    assert.equal(await run(['routes', '47.05,8.30', '47.06,8.31', '--mode', 'walk'], ctx), 0);
    const j = JSON.parse(out);
    assert.equal(j.source, 'haversine-estimate');
    assert.equal(j.duration.confidence, 'reference');
    assert.equal(j.estimate, true);
    assert.match(j.note, /Google|時刻表/);
    assert.equal(fetchCalls.length, 0);
    assert.equal(await run(['routes', 'place_id:A', '1,2'], ctxWith({})), 1);
  });
  test('--provider osm with a key still uses OSM', async () => {
    fetchPayload = [];
    assert.equal(await run(['places', 'search', 'x', '--provider', 'osm'], ctxWith({ GOOGLE_MAPS_API_KEY: 'K' })), 0);
    assert.match(fetchCalls[0]!.url, /nominatim/);
  });
  test('places search JSON output', async () => {
    fetchPayload = { places: [{ id: 'P1', displayName: { text: 'Bridge' }, location: { latitude: 1, longitude: 2 } }] };
    const ctx = ctxWith({ GOOGLE_MAPS_API_KEY: 'K' });
    assert.equal(await run(['places', 'search', 'chapel', 'bridge', '--near', '47,8'], ctx), 0);
    const j = JSON.parse(out);
    assert.equal(j.source, 'google-places');
    assert.equal(j.results[0].placeId, 'P1');
    assert.equal(JSON.parse(String(fetchCalls[0]!.init.body)).textQuery, 'chapel bridge');
  });
  test('places search --pretty', async () => {
    fetchPayload = { places: [{ id: 'P1', displayName: { text: 'Bridge' } }] };
    assert.equal(await run(['places', 'search', 'x', '--pretty'], ctxWith({ GOOGLE_MAPS_API_KEY: 'K' })), 0);
    assert.match(out, /1\. Bridge/);
  });
  test('bad --near and API failure', async () => {
    assert.equal(await run(['places', 'search', 'x', '--near', 'nope'], ctxWith({ GOOGLE_MAPS_API_KEY: 'K' })), 1);
    assert.match(err, /--near/);
    const ctx = ctxWith({ GOOGLE_MAPS_API_KEY: 'K' });
    ctx.fetch = async () => new Response(JSON.stringify({ error: { message: 'denied' } }), { status: 403 });
    assert.equal(await run(['places', 'details', 'P'], ctx), 1);
    assert.match(err, /denied/);
  });
  test('routes with negative coordinate positionals', async () => {
    fetchPayload = { routes: [{ duration: '600s', distanceMeters: 1000, legs: [{ steps: [] }] }] };
    const ctx = ctxWith({ GOOGLE_MAPS_API_KEY: 'K' });
    assert.equal(await run(['routes', '-33.8,151.2', 'place_id:ABC', '--mode', 'walk'], ctx), 0);
    assert.equal(JSON.parse(out).minutes, 10);
    const body = JSON.parse(String(fetchCalls[0]!.init.body));
    assert.equal(body.origin.location.latLng.latitude, -33.8);
    assert.equal(body.destination.placeId, 'ABC');
  });
  test('routes rejects bad mode', async () => {
    assert.equal(await run(['routes', '1,2', '3,4', '--mode', 'rocket'], ctxWith({ GOOGLE_MAPS_API_KEY: 'K' })), 1);
  });
});

describe('check', () => {
  test('warnings only → exit 0; JSON shape', async () => {
    assert.equal(await run(['check', 'swiss'], ctxWith({})), 0);
    const j = JSON.parse(out);
    assert.equal(j.ok, true);
    assert.equal(j.warnings, 1);
    assert.equal(j.issues[0].code, 'transit-gap');
  });
  test('errors → exit 1; pretty output', async () => {
    const orig = core.checkTrip;
    core.checkTrip = () => [{ level: 'error', code: 'overlap', message: '重疊' }];
    assert.equal(await run(['check', 'swiss', '--pretty'], ctxWith({})), 1);
    assert.match(out, /\[錯誤\] overlap/);
    core.checkTrip = orig;
  });
  test('--live fetches hours once per placeId and feeds hoursFor', async () => {
    fetchPayload = { id: 'PB', displayName: { text: 'x' }, regularOpeningHours: { periods: [{ open: { day: 1, hour: 9 }, close: { day: 1, hour: 17 } }] } };
    const ctx = ctxWith({ GOOGLE_MAPS_API_KEY: 'K' });
    assert.equal(await run(['check', 'swiss', '--live'], ctx), 0);
    assert.equal(fetchCalls.length, 1);
    assert.deepEqual(hoursSeen, { periods: [{ day: 1, open: '09:00', close: '17:00' }] });
  });
  test('--live without key fails', async () => {
    assert.equal(await run(['check', 'swiss', '--live'], ctxWith({})), 1);
    assert.match(err, /\.env/);
  });
  test('validates tripId, file, existence', async () => {
    assert.equal(await run(['check', '../x'], ctxWith({})), 1);
    assert.equal(await run(['check', 'swiss', '--file', '../trip.ts'], ctxWith({})), 1);
    assert.equal(await run(['check', 'ghost'], ctxWith({})), 1);
    assert.match(err, /找不到行程檔/);
    assert.equal(await run(['check'], ctxWith({})), 1);
  });
});

describe('export and list', () => {
  test('export ics writes trips/<id>/export/trip.ics', async () => {
    assert.equal(await run(['export', 'ics', 'swiss'], ctxWith({})), 0);
    assert.equal(JSON.parse(out).written, path.join('trips', 'swiss', 'export', 'trip.ics'));
    assert.match(await readFile(path.join(root, 'trips/swiss/export/trip.ics'), 'utf8'), /VCALENDAR/);
  });
  test('export links writes links.md', async () => {
    assert.equal(await run(['export', 'links', 'swiss'], ctxWith({})), 0);
    const md = await readFile(path.join(root, 'trips/swiss/export/links.md'), 'utf8');
    assert.match(md, /## 第 1 天 2026-05-02 露臺恩/);
    assert.match(md, /\[路線\]\(https:\/\/maps\.example\/2026-05-02\)/);
    assert.match(md, /沒有可導航/);
  });
  test('variant export gets its own name', async () => {
    await run(['export', 'ics', 'swiss', '--file', 'variant-b.ts'], ctxWith({}));
    assert.match(await readFile(path.join(root, 'trips/swiss/export/variant-b.ics'), 'utf8'), /VCALENDAR/);
  });
  test('export bad kind', async () => {
    assert.equal(await run(['export', 'pdf', 'swiss'], ctxWith({})), 1);
  });
  test('list', async () => {
    assert.equal(await run(['list'], ctxWith({})), 0);
    const j = JSON.parse(out);
    assert.equal(j.length, 1);
    assert.deepEqual(j[0], { id: 'swiss', title: '瑞士', start: '2026-05-02', end: '2026-05-03', days: 2, candidates: 0, variants: ['variant-b.ts'] });
    assert.equal(await run(['list', '--pretty'], ctxWith({})), 0);
    assert.match(out, /swiss {2}瑞士/);
  });
});
