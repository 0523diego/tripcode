import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lodgingByDay, stayByNight } from './lodging.ts';
import { dayMapsLinks } from './links.ts';
import type { Day, Item } from './types.ts';

const hotel = (id: string, nights: number, loc?: { lat: number; lng: number }): Item =>
  ({ id, kind: 'hotel', title: id, nights, ...(loc ? { loc } : {}) }) as Item;
const poi = (id: string, loc?: { lat: number; lng: number }): Item => ({ id, kind: 'poi', title: id, ...(loc ? { loc } : {}) }) as Item;
const day = (date: string, items: Item[]): Day => ({ date, items });

test('a hotel covers every night of its stay, not only its check-in day', () => {
  const trip = { days: [day('2026-11-22', [hotel('rome', 3)]), day('2026-11-23', []), day('2026-11-24', []), day('2026-11-25', [])] };
  const nights = stayByNight(trip);
  assert.deepEqual([...nights.keys()], ['2026-11-22', '2026-11-23', '2026-11-24']);
});

test('days start at last night\'s hotel and end at tonight\'s', () => {
  const trip = {
    days: [
      day('2026-11-22', [hotel('rome', 2), poi('a')]),
      day('2026-11-23', [poi('b')]),
      day('2026-11-24', [poi('c')]),
    ],
  };
  const l = lodgingByDay(trip);
  assert.equal(l[0]?.start, undefined, 'first day has no previous night');
  assert.equal(l[0]?.end?.item.id, 'rome');
  assert.equal(l[1]?.start?.item.id, 'rome');
  assert.equal(l[1]?.end?.item.id, 'rome');
  assert.equal(l[1]?.start?.dayIdx, 0);
  assert.equal(l[2]?.start?.item.id, 'rome');
  assert.equal(l[2]?.end, undefined, 'checkout day ends elsewhere');
});

test('moving day: starts at the old hotel, ends at the new one', () => {
  const trip = {
    days: [day('2026-11-21', [hotel('milan', 1)]), day('2026-11-22', [poi('train'), hotel('rome', 1)]), day('2026-11-23', [])],
  };
  const l = lodgingByDay(trip);
  assert.equal(l[1]?.start?.item.id, 'milan');
  assert.equal(l[1]?.end, undefined, 'the day already closes with the new hotel check-in');
  assert.equal(l[2]?.start?.item.id, 'rome');
});

test('a hotel check-in in the middle of the day still gets a return-to-hotel at the end', () => {
  const trip = { days: [day('2026-11-22', [hotel('rome', 1), poi('dinner')]), day('2026-11-23', [])] };
  assert.equal(lodgingByDay(trip)[0]?.end?.item.id, 'rome');
});

test('a hand-written stop at the hotel is not duplicated', () => {
  const at = { lat: 51.5, lng: -0.19 };
  const trip = {
    days: [day('2026-10-21', [hotel('h', 2, at)]), day('2026-10-22', [poi('start-hotel', { lat: 51.50001, lng: -0.19001 }), poi('far', { lat: 51.6, lng: -0.1 })])],
  };
  const l = lodgingByDay(trip)[1];
  assert.equal(l?.start, undefined);
  assert.equal(l?.end?.item.id, 'h');
});

test('dayMapsLinks brackets the day with the hotels', () => {
  const h1 = hotel('h1', 1, { lat: 1, lng: 1 });
  const h2 = hotel('h2', 1, { lat: 9, lng: 9 });
  const [url] = dayMapsLinks(day('2026-11-22', [poi('a', { lat: 5, lng: 5 })]), { start: h1, end: h2 });
  const p = new URL(url as string).searchParams;
  assert.equal(p.get('origin'), '1,1');
  assert.equal(p.get('waypoints'), '5,5');
  assert.equal(p.get('destination'), '9,9');
});
