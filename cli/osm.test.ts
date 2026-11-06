import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Throttle, buildLookupUrl, buildSearchUrl, isOsmId, parseOsmOpeningHours, placeDetailsOsm, searchPlacesOsm, userAgentFor } from './osm.ts';
import type { FetchLike } from './google.ts';

const now = () => new Date('2026-05-01T10:00:00.000Z');
const UA = 'TripCode/0.0.0 (open-source travel planner; local CLI)';

function fakeFetch(payload: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init: init ?? {} });
    return new Response(JSON.stringify(payload), { status });
  };
  return { fetch, calls };
}
const noWait = new Throttle({ clock: () => 0, sleep: async () => {} });

describe('URL building', () => {
  test('search', () => {
    const u = new URL(buildSearchUrl('Kapellbrücke Luzern', { lang: 'zh-TW', near: { lat: 47, lng: 8 } }));
    assert.equal(u.origin + u.pathname, 'https://nominatim.openstreetmap.org/search');
    assert.equal(u.searchParams.get('format'), 'jsonv2');
    assert.equal(u.searchParams.get('q'), 'Kapellbrücke Luzern');
    assert.equal(u.searchParams.get('limit'), '5');
    assert.equal(u.searchParams.get('accept-language'), 'zh-TW');
    assert.equal(u.searchParams.get('viewbox'), '7.9,47.1,8.1,46.9');
    assert.equal(u.searchParams.get('bounded'), null);
  });
  test('search without extras has no viewbox/lang', () => {
    const u = new URL(buildSearchUrl('x'));
    assert.equal(u.searchParams.get('viewbox'), null);
    assert.equal(u.searchParams.get('accept-language'), null);
  });
  test('lookup', () => {
    const u = new URL(buildLookupUrl('osm:node/123'));
    assert.equal(u.pathname, '/lookup');
    assert.equal(u.searchParams.get('osm_ids'), 'N123');
    assert.equal(u.searchParams.get('extratags'), '1');
    assert.equal(new URL(buildLookupUrl('osm:relation/9')).searchParams.get('osm_ids'), 'R9');
    assert.throws(() => buildLookupUrl('ChIJ123'));
  });
  test('isOsmId', () => {
    assert.ok(isOsmId('osm:way/1'));
    assert.ok(!isOsmId('osm:foo/1'));
    assert.ok(!isOsmId('ChIJabc'));
  });
});

describe('searchPlacesOsm', () => {
  test('maps results, sends User-Agent', async () => {
    const { fetch, calls } = fakeFetch([
      { osm_type: 'way', osm_id: 42, lat: '47.0516', lon: '8.3074', name: 'Kapellbrücke', display_name: 'Kapellbrücke, Luzern, Schweiz' },
      { osm_type: 'node', osm_id: 5, lat: '1', lon: '2', display_name: 'Unnamed, Somewhere' },
      { display_name: 'no id' },
    ]);
    const r = await searchPlacesOsm({ fetch, now, userAgent: UA, throttle: noWait }, 'Kapellbrücke');
    assert.equal((calls[0]!.init.headers as Record<string, string>)['User-Agent'], UA);
    assert.equal(r.source, 'openstreetmap-nominatim');
    assert.equal(r.results.length, 2);
    assert.deepEqual(r.results[0], {
      placeId: 'osm:way/42', name: 'Kapellbrücke', address: 'Kapellbrücke, Luzern, Schweiz',
      loc: { lat: 47.0516, lng: 8.3074, fetchedAt: '2026-05-01T10:00:00.000Z' },
      source: 'openstreetmap-nominatim', fetchedAt: '2026-05-01T10:00:00.000Z',
    });
    assert.equal(r.results[1]!.name, 'Unnamed');
  });
  test('HTTP error', async () => {
    const { fetch } = fakeFetch('blocked', 429);
    await assert.rejects(searchPlacesOsm({ fetch, now, userAgent: UA, throttle: noWait }, 'x'), /429/);
  });
});

describe('placeDetailsOsm', () => {
  const base = { osm_type: 'node', osm_id: 1, lat: '1', lon: '2', name: 'Cafe', display_name: 'Cafe, Town' };
  test('parsed hours', async () => {
    const { fetch } = fakeFetch([{ ...base, extratags: { opening_hours: 'Mo-Fr 09:00-17:00; Sa 10:00-14:00' } }]);
    const d = await placeDetailsOsm({ fetch, now, userAgent: UA, throttle: noWait }, 'osm:node/1');
    assert.equal(d.hours?.confidence, 'reference');
    assert.equal(d.hours?.source, 'openstreetmap-nominatim');
    assert.equal(d.hours?.value.periods.length, 6);
    assert.equal(d.hoursRaw, 'Mo-Fr 09:00-17:00; Sa 10:00-14:00');
  });
  test('unparseable hours → null + raw', async () => {
    const { fetch } = fakeFetch([{ ...base, extratags: { opening_hours: 'Mo-Fr 09:00-17:00; PH off' } }]);
    const d = await placeDetailsOsm({ fetch, now, userAgent: UA, throttle: noWait }, 'osm:node/1');
    assert.equal(d.hours, null);
    assert.equal(d.hoursRaw, 'Mo-Fr 09:00-17:00; PH off');
  });
  test('no hours, and not found', async () => {
    const d = await placeDetailsOsm({ fetch: fakeFetch([base]).fetch, now, userAgent: UA, throttle: noWait }, 'osm:node/1');
    assert.equal(d.hours, null);
    assert.equal(d.hoursRaw, undefined);
    await assert.rejects(placeDetailsOsm({ fetch: fakeFetch([]).fetch, now, userAgent: UA, throttle: noWait }, 'osm:node/1'), /找不到/);
  });
});

describe('parseOsmOpeningHours', () => {
  test('24/7', () => assert.equal(parseOsmOpeningHours('24/7')!.periods.length, 7));
  test('weekday range + Saturday', () => {
    const h = parseOsmOpeningHours('Mo-Fr 09:00-17:00; Sa 10:00-14:00')!;
    assert.deepEqual(h.periods.map((p) => p.day), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(h.periods[5], { day: 6, open: '10:00', close: '14:00' });
  });
  test('lists, split ranges, wrapping day range', () => {
    const h = parseOsmOpeningHours('Mo,We 09:00-12:00,14:00-18:00')!;
    assert.equal(h.periods.length, 4);
    assert.deepEqual(parseOsmOpeningHours('Sa-Mo 08:00-09:00')!.periods.map((p) => p.day), [6, 0, 1]);
  });
  test('overnight splits at midnight', () => {
    assert.deepEqual(parseOsmOpeningHours('Fr 22:00-02:00')!.periods, [
      { day: 5, open: '22:00', close: '24:00' },
      { day: 6, open: '00:00', close: '02:00' },
    ]);
  });
  test('unsupported forms → undefined', () => {
    for (const s of ['Mo-Fr 09:00-17:00; PH off', 'sunrise-sunset', 'Mo-Fr 09:00+', 'Jan-Mar Mo 09:00-10:00', 'Mo off', '', 'Mo 25:00-26:00']) {
      assert.equal(parseOsmOpeningHours(s), undefined, s);
    }
  });
});

describe('Throttle', () => {
  test('first call immediate, later calls wait out the 1s interval', async () => {
    let t = 1000;
    const slept: number[] = [];
    const th = new Throttle({ clock: () => t, sleep: async (ms) => { slept.push(ms); t += ms; } });
    await th.wait();
    t += 300;
    await th.wait();
    t += 2000;
    await th.wait();
    assert.deepEqual(slept, [700]);
  });
  test('searchPlacesOsm uses the throttle', async () => {
    const slept: number[] = [];
    const th = new Throttle({ clock: () => 5, sleep: async (ms) => { slept.push(ms); } });
    const { fetch } = fakeFetch([]);
    await searchPlacesOsm({ fetch, now, userAgent: UA, throttle: th }, 'a');
    await searchPlacesOsm({ fetch, now, userAgent: UA, throttle: th }, 'b');
    assert.deepEqual(slept, [1000]);
  });
});

test('userAgentFor reads package.json version', () => {
  assert.match(userAgentFor(new URL('..', import.meta.url).pathname), /^TripCode\/\S+ \(open-source travel planner; local CLI\)$/);
  assert.equal(userAgentFor('/nonexistent'), UA);
});
