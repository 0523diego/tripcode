import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { findMealGaps, parseMapsLink, restaurantsNearUrl } from './meals.ts';
import type { Item, Trip } from './types.ts';

const trip = (days: { date: string; items: Item[] }[]): Trip =>
  ({ title: 't', start: days[0]!.date, end: days.at(-1)!.date, tz: 'Europe/Rome', party: { adults: 2, childrenAges: [] }, days, candidates: [] }) as Trip;
const poi = (id: string, over: Partial<Item> = {}): Item => ({ id, kind: 'poi', title: id, loc: { lat: 41.9, lng: 12.5 }, ...over }) as Item;
const meal = (id: string, over: Partial<Item> = {}): Item => ({ id, kind: 'meal', title: id, ...over }) as Item;

describe('findMealGaps', () => {
  test('a day of sights without meals has a lunch and a dinner gap, anchored by position when nothing has a time', () => {
    const g = findMealGaps(trip([{ date: '2026-11-22', items: [poi('a'), poi('b'), poi('c'), poi('d')] }]));
    assert.deepEqual(g.map((x) => [x.slot, x.kind, x.basis, x.prev?.itemId, x.next?.itemId]), [
      ['lunch', 'missing', 'positional', 'b', 'c'],
      ['dinner', 'missing', 'positional', 'd', undefined],
    ]);
  });
  test('with times, the stops around the window are the anchors', () => {
    const g = findMealGaps(trip([{ date: '2026-11-22', items: [poi('a', { start: '09:30', end: '11:30' }), poi('b', { start: '15:00', end: '17:00' })] }]));
    const lunch = g.find((x) => x.slot === 'lunch')!;
    assert.deepEqual([lunch.basis, lunch.prev?.itemId, lunch.next?.itemId], ['timed', 'a', 'b']);
  });
  test('a placeholder meal is filled in, not duplicated; a real one closes the gap', () => {
    const g = findMealGaps(trip([{ date: '2026-11-22', items: [poi('a'), meal('lunch-tbd', { title: '午餐：待選' }), poi('b'), meal('dinner-real', { title: '晚餐 Roscioli', placeId: 'p1', start: '20:00' })] }]));
    assert.deepEqual(g.map((x) => [x.slot, x.kind, x.existingItemId]), [['lunch', 'undecided', 'lunch-tbd']]);
  });
  test('a locked evening show pulls dinner earlier and makes the show the default anchor', () => {
    const g = findMealGaps(trip([{ date: '2026-11-21', items: [poi('a', { start: '10:00', end: '12:00' }), poi('show', { locked: true, start: '20:00', end: '22:30', title: 'La Scala' })] }]));
    const dinner = g.find((x) => x.slot === 'dinner')!;
    assert.deepEqual([dinner.window.to, dinner.blockedBy, dinner.defaultAnchor], ['19:30', 'La Scala', 'next']);
  });
  test('a locked item covering the window means there is no gap', () => {
    const g = findMealGaps(trip([{ date: '2026-11-21', items: [poi('tour', { locked: true, start: '11:00', end: '15:00' })] }]));
    assert.equal(g.some((x) => x.slot === 'lunch'), false);
  });
  test('empty or travel-only days are not meal problems', () => {
    const g = findMealGaps(trip([{ date: '2026-11-20', items: [] }, { date: '2026-11-21', items: [{ id: 'f', kind: 'flight', title: 'f', flightNo: 'X' } as Item] }]));
    assert.deepEqual(g, []);
  });
  test('the anchor falls back to the side that has coordinates', () => {
    const g = findMealGaps(trip([{ date: '2026-11-22', items: [poi('a', { loc: undefined }), poi('b')] }]));
    assert.equal(g[0]!.defaultAnchor, 'next');
  });
  test('custom windows are honoured', () => {
    const g = findMealGaps(trip([{ date: '2026-11-22', items: [poi('a')] }]), { windows: [{ slot: 'dinner', from: '19:30', to: '22:00' }] });
    assert.deepEqual(g.map((x) => [x.slot, x.window.from, x.window.to]), [['dinner', '19:30', '22:00']]);
  });
});

describe('parseMapsLink', () => {
  test('place link: name and the places own pin', () => {
    const r = parseMapsLink('https://www.google.com/maps/place/Trattoria+da+Enzo+al+29/@41.8892,12.4698,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x1!8m2!3d41.8896!4d12.4695');
    assert.equal(r.name, 'Trattoria da Enzo al 29');
    assert.deepEqual(r.loc, { lat: 41.8896, lng: 12.4695 });
  });
  test('place link without a pin falls back to the viewport', () => {
    const r = parseMapsLink('https://www.google.com/maps/place/Pizzeria%20Da%20Baffetto/@41.8993,12.4707,17z');
    assert.deepEqual([r.name, r.loc], ['Pizzeria Da Baffetto', { lat: 41.8993, lng: 12.4707 }]);
  });
  test('search-api links: coordinates or a name', () => {
    assert.deepEqual(parseMapsLink('https://www.google.com/maps/search/?api=1&query=41.9,12.5').loc, { lat: 41.9, lng: 12.5 });
    assert.equal(parseMapsLink('https://www.google.com/maps/search/?api=1&query=Roscioli+Salumeria').name, 'Roscioli Salumeria');
  });
  test('short links, other sites and empty links are refused with a hint', () => {
    assert.throws(() => parseMapsLink('https://maps.app.goo.gl/abc'), /長網址/);
    assert.throws(() => parseMapsLink('https://evil.example/maps/place/x'), /Google 地圖/);
    assert.throws(() => parseMapsLink('http://www.google.com/maps/place/x'), /https/);
    assert.throws(() => parseMapsLink('https://www.google.com/maps'), /找不到店名或座標/);
    assert.throws(() => parseMapsLink('nope'), /不是網址/);
  });
  test('the search link is plain free text with no key and no tracking', () => {
    const u = restaurantsNearUrl('萬神殿 Pantheon（羅馬）', 'Rome');
    assert.equal(u, 'https://www.google.com/maps/search/?api=1&query=restaurants%20near%20%E8%90%AC%E7%A5%9E%E6%AE%BF%20Pantheon%20Rome');
  });
});
