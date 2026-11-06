import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { dayLoad, walkLimitFromProfile } from './load.ts';
import type { Day, Item } from './types.ts';

const at = (km: number) => ({ lat: km / 111.2, lng: 0 });
const stop = (id: string, km: number, over: Partial<Item> = {}): Item => ({ id, kind: 'poi', title: id, loc: at(km), ...over }) as Item;
const day = (items: Item[]): Day => ({ date: '2026-11-21', items });

describe('dayLoad', () => {
  test('walking is the straight line between located stops times one labelled detour factor', () => {
    const l = dayLoad(day([stop('a', 0), stop('b', 2), stop('c', 4)]));
    assert.deepEqual([l.straightKm, l.walkKm, l.walkMin, l.stops], [4, 5.2, 69, 3]);
  });
  test('legs across a transit item are not walking; a sourced duration or fixed times are used as they are', () => {
    const bus = { id: 'bus', kind: 'transit', title: 'bus', mode: 'bus', duration: { value: 25, source: 's', fetchedAt: '2026-11-01T00:00:00Z', confidence: 'recent' } } as Item;
    const train = { id: 't', kind: 'transit', title: 't', mode: 'train', start: '10:00', end: '12:30' } as Item;
    const l = dayLoad(day([stop('a', 0), bus, stop('b', 9), train, stop('c', 90)]));
    assert.equal(l.walkKm, 0);
    assert.deepEqual([l.transitMin, l.blockedMin], [25, 150]);
  });
  test('a flight blocks its time plus an hour, and breaks the chain of walking legs', () => {
    const f = { id: 'f', kind: 'flight', title: 'f', flightNo: 'X1', start: '08:00', end: '10:00' } as Item;
    const l = dayLoad(day([stop('a', 0), f, stop('b', 500), stop('c', 500.5)]));
    assert.equal(l.blockedMin, 180);
    assert.equal(l.straightKm, 0.5);
  });
  test('unknowns are listed, not guessed: no coordinates, no flight times', () => {
    const f = { id: 'f', kind: 'flight', title: '航班 X1', flightNo: 'X1' } as Item;
    const l = dayLoad(day([f, stop('a', 0), { id: 'z', kind: 'poi', title: 'z' } as Item]));
    assert.equal(l.unknown.length, 2);
    assert.match(l.unknown.join(' '), /航班「航班 X1」沒有起訖時間/);
  });
  test('a leg longer than 3 km with no transport is a guessed ride, not a walk, and the page says so', () => {
    const l = dayLoad(day([stop('a', 0), stop('b', 5)]));
    assert.equal(l.walkKm, 0);
    assert.ok(l.transitMin > 0);
    assert.match(l.unknown.join(' '), /1 段超過 3 公里的移動沒有安排交通/);
  });
  test('the hotel the day starts and ends at counts as the ends of the walk', () => {
    const hotel = { id: 'h', kind: 'hotel', title: 'h', nights: 2, loc: at(0) } as Item;
    const l = dayLoad(day([stop('a', 3)]), { start: { item: hotel as never, dayIdx: 0 }, end: { item: hotel as never, dayIdx: 0 } });
    assert.equal(l.straightKm, 6);
  });
});

describe('walkLimitFromProfile', () => {
  test('reads a range in km, a single km, or steps; says nothing otherwise', () => {
    assert.equal(walkLimitFromProfile('每天可接受的步行：約 10,000 步（約 7–8 公里）'), 8);
    assert.equal(walkLimitFromProfile('每天最多走 6 公里'), 6);
    assert.equal(walkLimitFromProfile('一天 10,000 步'), 7);
    assert.equal(walkLimitFromProfile('走路都可以'), undefined);
    assert.equal(walkLimitFromProfile(undefined), undefined);
  });
});
