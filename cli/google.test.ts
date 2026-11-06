import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  GoogleApiError,
  computeRoute,
  computeRouteMatrix,
  mapOpeningHours,
  parseDurationMinutes,
  parseLatLng,
  parseWaypoint,
  placeDetails,
  searchPlaces,
} from './google.ts';
import type { FetchLike } from './google.ts';

const now = () => new Date('2026-05-01T10:00:00.000Z');

function fakeFetch(payload: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init: init ?? {} });
    return new Response(JSON.stringify(payload), { status });
  };
  return { fetch, calls };
}

describe('searchPlaces', () => {
  test('maps response, sends key + field mask + bias', async () => {
    const { fetch, calls } = fakeFetch({
      places: [
        { id: 'P1', displayName: { text: '卡貝爾橋' }, formattedAddress: 'Luzern', location: { latitude: 47.05, longitude: 8.3 }, rating: 4.6 },
        { displayName: { text: 'no id' } },
      ],
    });
    const r = await searchPlaces({ apiKey: 'K', fetch, now }, 'chapel bridge', { near: { lat: 47, lng: 8 }, lang: 'zh-TW' });
    assert.equal(calls[0]!.url, 'https://places.googleapis.com/v1/places:searchText');
    assert.equal(calls[0]!.init.method, 'POST');
    const h = calls[0]!.init.headers as Record<string, string>;
    assert.equal(h['X-Goog-Api-Key'], 'K');
    assert.match(h['X-Goog-FieldMask']!, /places\.id/);
    const body = JSON.parse(String(calls[0]!.init.body));
    assert.equal(body.textQuery, 'chapel bridge');
    assert.equal(body.languageCode, 'zh-TW');
    assert.deepEqual(body.locationBias.circle.center, { latitude: 47, longitude: 8 });
    assert.equal(r.source, 'google-places');
    assert.equal(r.fetchedAt, '2026-05-01T10:00:00.000Z');
    assert.equal(r.results.length, 1);
    assert.deepEqual(r.results[0], {
      placeId: 'P1', name: '卡貝爾橋', address: 'Luzern',
      loc: { lat: 47.05, lng: 8.3, fetchedAt: '2026-05-01T10:00:00.000Z' }, rating: 4.6,
      source: 'google-places', fetchedAt: '2026-05-01T10:00:00.000Z',
    });
  });
  test('empty result', async () => {
    const { fetch } = fakeFetch({});
    assert.deepEqual((await searchPlaces({ apiKey: 'K', fetch, now }, 'zzz')).results, []);
  });
  test('API errors become GoogleApiError', async () => {
    const { fetch } = fakeFetch({ error: { message: 'API key not valid' } }, 403);
    await assert.rejects(searchPlaces({ apiKey: 'K', fetch, now }, 'x'), (e: unknown) => e instanceof GoogleApiError && e.status === 403 && /API key not valid/.test(e.message));
  });
  test('network failures become GoogleApiError', async () => {
    const fetch: FetchLike = async () => { throw new Error('ENOTFOUND'); };
    await assert.rejects(searchPlaces({ apiKey: 'K', fetch, now }, 'x'), /ENOTFOUND/);
  });
});

describe('placeDetails', () => {
  test('GET with mask; maps hours to Sourced<OpeningHours>', async () => {
    const { fetch, calls } = fakeFetch({
      id: 'P1', displayName: { text: 'Museum' }, businessStatus: 'OPERATIONAL',
      regularOpeningHours: { periods: [{ open: { day: 1, hour: 9, minute: 0 }, close: { day: 1, hour: 17, minute: 30 } }] },
    });
    const d = await placeDetails({ apiKey: 'K', fetch, now }, 'P1', { lang: 'zh-TW' });
    assert.equal(calls[0]!.url, 'https://places.googleapis.com/v1/places/P1?languageCode=zh-TW');
    assert.equal(calls[0]!.init.method, 'GET');
    assert.equal(calls[0]!.init.body, undefined);
    assert.equal(d.businessStatus, 'OPERATIONAL');
    assert.deepEqual(d.hours, {
      value: { periods: [{ day: 1, open: '09:00', close: '17:30' }] },
      source: 'google-places', fetchedAt: '2026-05-01T10:00:00.000Z', confidence: 'live',
    });
  });
  test('no hours → hours omitted', async () => {
    const { fetch } = fakeFetch({ id: 'P2', displayName: { text: 'x' } });
    assert.equal((await placeDetails({ apiKey: 'K', fetch, now }, 'P2')).hours, undefined);
  });
});

describe('mapOpeningHours', () => {
  test('overnight periods split at midnight', () => {
    assert.deepEqual(
      mapOpeningHours([{ open: { day: 5, hour: 18 }, close: { day: 6, hour: 2 } }]),
      { periods: [{ day: 5, open: '18:00', close: '24:00' }, { day: 6, open: '00:00', close: '02:00' }] },
    );
  });
  test('close at next-day midnight', () => {
    assert.deepEqual(
      mapOpeningHours([{ open: { day: 0, hour: 10 }, close: { day: 1, hour: 0 } }]),
      { periods: [{ day: 0, open: '10:00', close: '24:00' }] },
    );
  });
  test('24/7 place (no close) → seven full days', () => {
    const r = mapOpeningHours([{ open: { day: 0, hour: 0, minute: 0 } }])!;
    assert.equal(r.periods.length, 7);
    assert.deepEqual(r.periods[3], { day: 3, open: '00:00', close: '24:00' });
  });
  test('empty → undefined', () => {
    assert.equal(mapOpeningHours([]), undefined);
    assert.equal(mapOpeningHours(undefined), undefined);
  });
});

describe('computeRoute', () => {
  const payload = {
    routes: [{
      duration: '1805s', distanceMeters: 12000,
      legs: [{ steps: [
        { travelMode: 'WALK', staticDuration: '300s', distanceMeters: 400 },
        { travelMode: 'TRANSIT', staticDuration: '1200s', transitDetails: { transitLine: { name: 'Intercity', nameShort: 'IC3', vehicle: { type: 'HEAVY_RAIL' } } } },
      ] }],
    }],
  };
  test('POST body, mask, mapping', async () => {
    const { fetch, calls } = fakeFetch(payload);
    const r = await computeRoute({ apiKey: 'K', fetch, now }, 'place_id:AAA', '47.05,8.3', { mode: 'transit', depart: '2026-05-02T09:00:00+02:00' });
    assert.equal(calls[0]!.url, 'https://routes.googleapis.com/directions/v2:computeRoutes');
    const body = JSON.parse(String(calls[0]!.init.body));
    assert.deepEqual(body.origin, { placeId: 'AAA' });
    assert.deepEqual(body.destination, { location: { latLng: { latitude: 47.05, longitude: 8.3 } } });
    assert.equal(body.travelMode, 'TRANSIT');
    assert.equal(body.departureTime, '2026-05-02T07:00:00.000Z');
    assert.match((calls[0]!.init.headers as Record<string, string>)['X-Goog-FieldMask']!, /routes\.duration/);
    assert.equal(r.minutes, 31);
    assert.equal(r.distanceMeters, 12000);
    assert.deepEqual(r.steps[1], { mode: 'transit', minutes: 20, line: 'IC3', vehicle: 'HEAVY_RAIL' });
    assert.deepEqual(r.duration, { value: 31, source: 'google-routes', fetchedAt: '2026-05-01T10:00:00.000Z', confidence: 'live' });
  });
  test('walk omits departureTime', async () => {
    const { fetch, calls } = fakeFetch(payload);
    await computeRoute({ apiKey: 'K', fetch, now }, '1,2', '3,4', { mode: 'walk', depart: '2026-05-02T09:00:00Z' });
    const body = JSON.parse(String(calls[0]!.init.body));
    assert.equal(body.travelMode, 'WALK');
    assert.equal(body.departureTime, undefined);
  });
  test('no routes → error', async () => {
    const { fetch } = fakeFetch({});
    await assert.rejects(computeRoute({ apiKey: 'K', fetch, now }, '1,2', '3,4'), /找不到/);
  });
  test('bad waypoint / depart', async () => {
    const { fetch } = fakeFetch(payload);
    await assert.rejects(computeRoute({ apiKey: 'K', fetch, now }, 'nowhere', '3,4'), /格式錯誤/);
    await assert.rejects(computeRoute({ apiKey: 'K', fetch, now }, '1,2', '3,4', { depart: 'tomorrow-ish' }), /ISO/);
  });
});

test('helpers', () => {
  assert.equal(parseDurationMinutes('60s'), 1);
  assert.equal(parseDurationMinutes('61s'), 2);
  assert.equal(parseDurationMinutes(undefined), 0);
  assert.deepEqual(parseLatLng('-33.8, 151.2'), { lat: -33.8, lng: 151.2 });
  assert.equal(parseLatLng('91,0'), undefined);
  assert.equal(parseLatLng('abc'), undefined);
  assert.deepEqual(parseWaypoint('place_id:X'), { placeId: 'X' });
});

describe('computeRouteMatrix', () => {
  const pts = [{ placeId: 'AAA' }, { loc: { lat: 47.05, lng: 8.3 } }, { placeId: 'CCC', loc: { lat: 1, lng: 2 } }];
  test('POST body, field mask, mapping, diagonal and missing routes', async () => {
    const { fetch, calls } = fakeFetch([
      { originIndex: 0, destinationIndex: 1, duration: '601s', condition: 'ROUTE_EXISTS' },
      { originIndex: 1, destinationIndex: 0, duration: '1200s' },
      { originIndex: 0, destinationIndex: 2, condition: 'ROUTE_NOT_FOUND' },
      { originIndex: 2, destinationIndex: 2, duration: '0s', condition: 'ROUTE_EXISTS' },
    ]);
    const r = await computeRouteMatrix({ apiKey: 'K', fetch, now }, pts, { mode: 'transit' });
    assert.equal(calls[0]!.url, 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix');
    assert.equal(calls[0]!.init.method, 'POST');
    const headers = calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers['X-Goog-FieldMask'], 'originIndex,destinationIndex,duration,condition');
    assert.equal(headers['X-Goog-Api-Key'], 'K');
    const body = JSON.parse(String(calls[0]!.init.body));
    assert.equal(body.travelMode, 'TRANSIT');
    assert.deepEqual(body.origins, body.destinations);
    assert.deepEqual(body.origins[0], { waypoint: { placeId: 'AAA' } });
    assert.deepEqual(body.origins[1], { waypoint: { location: { latLng: { latitude: 47.05, longitude: 8.3 } } } });
    assert.deepEqual(body.origins[2], { waypoint: { placeId: 'CCC' } }, 'placeId wins over loc');
    assert.deepEqual(r.matrix, [
      [0, 11, null],
      [20, 0, null],
      [null, null, 0],
    ]);
    assert.equal(r.source, 'google-routes');
    assert.equal(r.fetchedAt, '2026-05-01T10:00:00.000Z');
  });
  test('size limits and unplaceable points', async () => {
    const { fetch, calls } = fakeFetch([]);
    const eleven = Array.from({ length: 11 }, (_, i) => ({ placeId: `P${i}` }));
    await assert.rejects(computeRouteMatrix({ apiKey: 'K', fetch, now }, eleven, { mode: 'transit' }), /最多查 100/);
    await assert.rejects(computeRouteMatrix({ apiKey: 'K', fetch, now }, [{}, { placeId: 'x' }]), GoogleApiError);
    assert.equal(calls.length, 0);
    await computeRouteMatrix({ apiKey: 'K', fetch, now }, eleven, { mode: 'walk' });
    assert.equal(calls.length, 1);
  });
});
