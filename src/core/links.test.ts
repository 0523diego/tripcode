import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayMapsLinks, googlePlaceId } from './links.ts';
import type { Day, Item } from './types.ts';

const poi = (id: string, extra: Record<string, unknown> = {}): Item => ({ id, kind: 'poi', title: id, ...extra }) as Item;
const at = (id: string, lat: number, lng: number): Item => poi(id, { loc: { lat, lng } });
const day = (items: Item[]): Day => ({ date: '2026-06-14', items });
const params = (url: string) => new URL(url).searchParams;

test('two stops: origin, destination, default travelmode transit', () => {
  const [url, ...rest] = dayMapsLinks(day([at('a', 47.1, 8.2), at('b', 47.3, 8.5)]));
  assert.equal(rest.length, 0);
  assert.equal(url, 'https://www.google.com/maps/dir/?api=1&origin=47.1,8.2&destination=47.3,8.5&travelmode=transit');
});

test('waypoints joined with |, travelmode override', () => {
  const [url] = dayMapsLinks(day([at('a', 1, 1), at('b', 2, 2), at('c', 3, 3), at('d', 4, 4)]), { travelmode: 'walking' });
  const p = params(url as string);
  assert.equal(p.get('origin'), '1,1');
  assert.equal(p.get('destination'), '4,4');
  assert.equal(p.get('waypoints'), '2,2|3,3');
  assert.equal(p.get('travelmode'), 'walking');
  assert.equal(p.get('waypoint_place_ids'), null);
});

test('place_id params when every stop has a placeId; title is the encoded label', () => {
  const items = [poi('Kapellbrücke Luzern', { placeId: 'P1' }), poi('Pilatus', { placeId: 'P2' }), poi('Rigi', { placeId: 'P3' })];
  const [url] = dayMapsLinks(day(items));
  assert.ok((url as string).includes('origin=Kapellbr%C3%BCcke%20Luzern'));
  const p = params(url as string);
  assert.equal(p.get('origin'), 'Kapellbrücke Luzern');
  assert.equal(p.get('origin_place_id'), 'P1');
  assert.equal(p.get('destination_place_id'), 'P3');
  assert.equal(p.get('waypoints'), 'Pilatus');
  assert.equal(p.get('waypoint_place_ids'), 'P2');
});

test('placeId stop without a title falls back to lat,lng label; mixed waypoints omit waypoint_place_ids', () => {
  const items = [poi('a', { placeId: 'P1', loc: { lat: 1, lng: 2 } }), at('b', 3, 4), poi('c', { placeId: 'P3' })];
  const p = params(dayMapsLinks(day(items))[0] as string);
  assert.equal(p.get('origin_place_id'), 'P1');
  assert.equal(p.get('waypoints'), '3,4');
  assert.equal(p.get('waypoint_place_ids'), null);
});

test('skips transit/free/meal/flight items without a location, keeps located ones', () => {
  const items: Item[] = [
    at('a', 1, 1),
    { id: 't', kind: 'transit', mode: 'train', title: 'train' },
    { id: 'f', kind: 'free', title: 'free' },
    { id: 'm', kind: 'meal', title: 'lunch' },
    { id: 'fl', kind: 'flight', flightNo: 'X', title: 'flight' },
    { id: 'st', kind: 'transit', mode: 'train', title: 'Station', loc: { lat: 5, lng: 5 } },
    at('b', 2, 2),
  ];
  const p = params(dayMapsLinks(day(items))[0] as string);
  assert.equal(p.get('waypoints'), '5,5');
  assert.equal(p.get('destination'), '2,2');
});

test('poi/hotel without location are looked up by title', () => {
  const items: Item[] = [{ id: 'h', kind: 'hotel', title: 'Hotel Schweizerhof', nights: 2 }, at('b', 2, 2)];
  const p = params(dayMapsLinks(day(items))[0] as string);
  assert.equal(p.get('origin'), 'Hotel Schweizerhof');
});

test('fewer than two stops → no links', () => {
  assert.deepEqual(dayMapsLinks(day([])), []);
  assert.deepEqual(dayMapsLinks(day([at('a', 1, 1)])), []);
  assert.deepEqual(dayMapsLinks(day([at('a', 1, 1), { id: 'f', kind: 'free', title: 'x' }])), []);
});

test('consecutive duplicate stops collapse (same placeId or same coordinates)', () => {
  assert.deepEqual(dayMapsLinks(day([at('a', 1, 1), at('a2', 1, 1)])), []);
  const links = dayMapsLinks(day([poi('h', { placeId: 'H' }), poi('h again', { placeId: 'H' }), at('b', 2, 2)]));
  assert.equal(links.length, 1);
  assert.equal(params(links[0] as string).get('waypoints'), null);
  // but returning to the hotel at the end is a real leg
  assert.equal(dayMapsLinks(day([at('a', 1, 1), at('b', 2, 2), at('a', 1, 1)]))[0]?.includes('waypoints=2,2'), true);
});

function many(n: number): Item[] {
  return Array.from({ length: n }, (_, i) => at(`s${i}`, i, i));
}

test('exactly 10 stops (8 waypoints) fit in one link', () => {
  const links = dayMapsLinks(day(many(10)));
  assert.equal(links.length, 1);
  assert.equal(params(links[0] as string).get('waypoints')?.split('|').length, 8);
});

test('11 stops split at >8 waypoints; next link starts at previous destination', () => {
  const links = dayMapsLinks(day(many(11)));
  assert.equal(links.length, 2);
  const a = params(links[0] as string);
  const b = params(links[1] as string);
  assert.equal(a.get('origin'), '0,0');
  assert.equal(a.get('destination'), '9,9');
  assert.equal(b.get('origin'), '9,9');
  assert.equal(b.get('destination'), '10,10');
  assert.equal(b.get('waypoints'), null);
});

test('long day: every consecutive pair is covered exactly once', () => {
  const links = dayMapsLinks(day(many(25)));
  assert.equal(links.length, 3);
  const covered: string[] = [];
  let prevDest: string | null = null;
  for (const url of links) {
    const p = params(url);
    if (prevDest !== null) assert.equal(p.get('origin'), prevDest);
    const wps = p.get('waypoints')?.split('|') ?? [];
    assert.ok(wps.length <= 8);
    covered.push(p.get('origin') as string, ...wps);
    prevDest = p.get('destination');
  }
  covered.push(prevDest as string);
  const expected = Array.from({ length: 25 }, (_, i) => `${i},${i}`);
  assert.deepEqual([...new Set(covered)], expected);
});

test('titles with reserved characters are encoded', () => {
  const [url] = dayMapsLinks(day([poi('A & B | C', { placeId: 'P1' }), poi('x', { placeId: 'P2' })]));
  assert.equal(params(url as string).get('origin'), 'A & B | C');
  assert.ok(!(url as string).includes('A & B'));
});

test('osm: ids are never sent to Google as place ids; coordinates are used instead', () => {
  const day = {
    date: '2027-06-12',
    items: [
      { id: 'a', kind: 'poi', title: 'A', placeId: 'osm:way/1', loc: { lat: 47.05, lng: 8.3 } },
      { id: 'b', kind: 'poi', title: 'B', placeId: 'ChIJabc', loc: { lat: 47.06, lng: 8.31 } },
    ],
  } as unknown as Day;
  const [url] = dayMapsLinks(day);
  assert.ok(url);
  assert.ok(!url.includes('osm'), url);
  assert.ok(url.includes('origin=47.05%2C8.3') || url.includes('origin=47.05,8.3'), url);
  assert.ok(url.includes('destination_place_id=ChIJabc'), url);
  assert.equal(googlePlaceId('osm:node/5'), undefined);
  assert.equal(googlePlaceId('ChIJxyz'), 'ChIJxyz');
});
