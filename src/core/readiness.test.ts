import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readiness, readinessSummary } from './readiness.ts';
import type { Item, Trip } from './types.ts';

const NOW = new Date('2026-11-04T12:00:00Z');
const trip = (days: { date: string; items: Item[] }[], over: Partial<Trip> = {}): Trip =>
  ({ title: 't', start: days[0]!.date, end: days.at(-1)!.date, tz: 'Europe/Rome', party: { adults: 1, childrenAges: [] }, days, candidates: [], ...over }) as Trip;
const poi = (id: string, over: Partial<Item> = {}): Item => ({ id, kind: 'poi', title: id, loc: { lat: 1, lng: 1, fetchedAt: '2026-11-01T00:00:00Z' }, ...over }) as Item;
const codes = (t: Trip, brief?: string) => readiness(t, { now: NOW, brief }).map((i) => i.code);

describe('readiness', () => {
  test('an empty trip says so once, not once per day', () => {
    const t = trip([{ date: '2026-11-12', items: [] }, { date: '2026-11-13', items: [] }, { date: '2026-11-14', items: [] }]);
    const c = codes(t);
    assert.equal(c.filter((x) => x === 'empty-trip').length, 1);
    assert.equal(c.includes('empty-day'), false);
    assert.ok(c.includes('lodging-gap'));
  });
  test('a day with only a hotel counts as empty', () => {
    const t = trip([{ date: '2026-11-12', items: [poi('a')] }, { date: '2026-11-13', items: [{ id: 'h', kind: 'hotel', title: 'h', nights: 2, locked: true } as Item] }]);
    assert.deepEqual(readiness(t, { now: NOW }).filter((i) => i.code === 'empty-day').map((i) => i.date), ['2026-11-13']);
  });
  test('an unfilled brief is a note', () => {
    const t = trip([{ date: '2026-11-12', items: [poi('a')] }]);
    assert.ok(codes(t, '偏好：（待填）').includes('brief-unfilled'));
    assert.equal(codes(t, '偏好：慢慢走').includes('brief-unfilled'), false);
  });
  test('unbought required items, sale dates and deadlines are warnings; bought ones are not', () => {
    const t = trip([
      {
        date: '2026-11-08',
        items: [
          poi('train', { booking: { need: 'required', status: 'todo', opensAt: { value: '2026-11-05T09:00:00+01:00', source: 's', fetchedAt: '2026-11-04T00:00:00Z', confidence: 'recent' }, deadline: { value: '2026-11-06T12:00:00Z', source: 's', fetchedAt: '2026-11-04T00:00:00Z', confidence: 'recent' } } }),
          poi('done', { booking: { need: 'required', status: 'booked' } }),
        ],
      },
    ]);
    const issues = readiness(t, { now: NOW });
    const mine = issues.filter((i) => i.itemId === 'train').map((i) => i.code).sort();
    assert.deepEqual(mine, ['booking-deadline', 'booking-opens', 'booking-required']);
    assert.equal(issues.some((i) => i.itemId === 'done'), false);
    assert.ok(issues.filter((i) => i.itemId === 'train').every((i) => i.level === 'warn'));
  });
  test('keyword guesses are merged into one line and named as guesses', () => {
    const t = trip([{ date: '2026-11-21', items: [poi('a', { note: '尚未訂票' }), poi('b', { note: '尚未訂票' }), { id: 'h', kind: 'hotel', title: 'h', nights: 1, locked: true } as Item] }, { date: '2026-11-22', items: [poi('c')] }]);
    const r = readiness(t, { now: NOW }).filter((i) => i.code === 'booking-unbought');
    assert.equal(r.length, 1);
    assert.match(r[0]!.message, /2 項.*a、b/);
  });
  test('meals, missing coordinates and unchecked transit are notes, merged per day', () => {
    const t = trip([{ date: '2026-11-21', items: [poi('a'), poi('b', { loc: undefined }), { id: 'tr', kind: 'transit', title: 'tr', mode: 'bus' } as Item] }]);
    const r = readiness(t, { now: NOW });
    for (const code of ['meal-gap', 'missing-loc', 'transit-unverified']) {
      const found = r.filter((i) => i.code === code);
      assert.equal(found.length, 1, code);
      assert.equal(found[0]!.level, 'info');
    }
  });
  test('stale sources and old coordinates are noticed', () => {
    const old = { value: 'x', source: 's', fetchedAt: '2026-08-01T00:00:00Z', confidence: 'reference' as const };
    const t = trip([{ date: '2026-11-21', items: [poi('a', { loc: { lat: 1, lng: 1, fetchedAt: '2026-08-01T00:00:00Z' }, booking: { need: 'required', status: 'todo', cancellation: old } })] }]);
    const c = codes(t);
    assert.ok(c.includes('booking-stale') && c.includes('coords-stale'));
  });
  test('the past is ignored', () => {
    const t = trip([{ date: '2026-10-01', items: [] }, { date: '2026-10-02', items: [poi('a', { note: '尚未訂票' })] }]);
    assert.equal(readiness(t, { now: NOW }).some((i) => i.date && i.date < '2026-11-04'), false);
  });
  test('the summary says what to do first', () => {
    assert.match(readinessSummary([{ level: 'warn', code: 'x', message: 'm' }, { level: 'info', code: 'y', message: 'm' }]).text, /1 件必辦、1 項提醒/);
    assert.match(readinessSummary([]).text, /都就緒/);
  });
});

describe('day-structure rules (distance and time, not counts)', () => {
  const day = (date: string, items: Item[], accepted?: string[]) => ({ date, items, ...(accepted ? { accepted } : {}) });
  /** A point `km` kilometres north of the origin (one degree of latitude is about 111.2 km). */
  const at = (km: number) => ({ lat: km / 111.2, lng: 0, fetchedAt: '2026-11-01T00:00:00Z' });
  const stop = (id: string, km: number, over: Partial<Item> = {}): Item => ({ id, kind: 'poi', title: id, loc: at(km), ...over }) as Item;
  const meal = (id: string, km: number): Item => ({ id, kind: 'meal', title: id, loc: at(km), placeId: 'p' }) as Item;
  const found = { value: 'https://tickets.example.org/', source: 'https://example.org/', fetchedAt: '2026-11-04T00:00:00Z', confidence: 'recent' as const };

  test('a row with only a search link is flagged once, until someone has researched it', () => {
    const base = (booking?: Item['booking']) => trip([day('2026-11-21', [poi('louvre', { note: '尚未訂票', ...(booking ? { booking } : {}) } as Partial<Item>)])]);
    assert.equal(codes(base()).includes('booking-link-missing'), true);
    assert.equal(codes(base({ need: 'required', status: 'todo' })).includes('booking-link-missing'), false, '「找不到」 is an answer');
    assert.equal(codes(base({ need: 'required', status: 'todo', bookingUrl: found })).includes('booking-link-missing'), false);
  });

  test('eight sights within a few hundred metres are an easy day; the same count spread over the city is not', () => {
    const close = trip([day('2026-11-21', Array.from({ length: 8 }, (_, n) => stop(`c${n}`, n * 0.05)))]);
    const spread = trip([day('2026-11-21', [stop('a', 0), stop('b', 2.5), stop('c', 5), stop('d', 7.5)])]);
    assert.equal(codes(close).includes('walking-heavy'), false);
    assert.equal(codes(close).includes('day-time-tight'), false);
    const heavy = readiness(spread, { now: NOW }).find((i) => i.code === 'walking-heavy')!;
    assert.ok(heavy, 'four stops 2.5 km apart: about 9.75 km on foot');
    assert.match(heavy.message, /9\.[78] 公里.*直線距離 7\.5 公里 × 1\.3.*上限/);
  });

  test('a long leg with no transport planned is not a walk: it is estimated as a ride and said so', () => {
    const t = trip([day('2026-11-21', [stop('a', 0), stop('b', 15), stop('c', 15.1)])]);
    assert.equal(codes(t).includes('walking-heavy'), false, 'fifteen kilometres is not walking');
  });

  test('a leg with a transit item between is not counted as walking, and the 30 km cap keeps far legs out', () => {
    const bus = { id: 'bus', kind: 'transit', title: 'bus', mode: 'bus' } as Item;
    assert.equal(codes(trip([day('2026-11-21', [stop('a', 0), bus, stop('b', 12), stop('c', 12.1)])])).includes('walking-heavy'), false);
    assert.equal(codes(trip([day('2026-11-21', [stop('a', 0), stop('b', 400)])])).includes('walking-heavy'), false);
  });

  test('the walking limit comes from profile.md when it says one', () => {
    const t = trip([day('2026-11-21', [stop('a', 0), stop('b', 3), stop('c', 6)])]); // 6 km straight, 7.8 km on foot
    assert.equal(codes(t).includes('walking-heavy'), false, 'under the default 8 km');
    const strict = readiness(t, { now: NOW, profile: '每天可接受的步行：約 4 公里' }).map((i) => i.code);
    assert.equal(strict.includes('walking-heavy'), true);
  });

  test('a long train leaves little time: the note counts time per stop, so close sights still pass', () => {
    const train = { id: 't', kind: 'transit', title: 'train', mode: 'train', start: '09:00', end: '18:00', locked: true } as Item;
    const few = trip([day('2026-11-21', [train, stop('a', 0), stop('b', 0.1)])]);
    assert.equal(codes(few).includes('day-time-tight'), false, 'two sights: not enough stops to call it rushed');
    const many = trip([day('2026-11-21', [train, stop('a', 0), stop('b', 0.1), stop('c', 0.2), stop('d', 0.3), meal('m', 0.3)])]);
    const note = readiness(many, { now: NOW }).find((i) => i.code === 'day-time-tight')!;
    assert.ok(note);
    assert.match(note.message, /9 小時.*平均每個約 4\d 分鐘/);
    const flightOnly = { id: 'f', kind: 'flight', title: 'f', flightNo: 'X1', start: '10:00', end: '12:00' } as Item;
    assert.equal(codes(trip([day('2026-11-21', [flightOnly, stop('a', 0), stop('b', 0.1), stop('c', 0.2)])])).includes('day-time-tight'), false, 'a short flight leaves plenty');
  });

  test('what the estimate could not see is said, not hidden', () => {
    const train = { id: 't', kind: 'transit', title: 'train', mode: 'train', start: '09:00', end: '18:00', locked: true } as Item;
    const t = trip([day('2026-11-21', [train, stop('a', 0), stop('b', 0.1), stop('c', 0.2), stop('d', 0.3), meal('m', 0.3), poi('x', { loc: undefined })])]);
    assert.match(readiness(t, { now: NOW }).find((i) => i.code === 'day-time-tight')!.message, /沒算到：1 個地點沒有座標/);
  });

  test('five hard days in a row leave no easy day; one light day breaks the run', () => {
    const hard = (d: string) => day(d, [stop('a' + d, 0), stop('b' + d, 2.9), stop('c' + d, 5.8)]); // 5.8 km straight, 7.5 km on foot: hard, not over the limit
    const five = ['2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24', '2026-11-25'].map(hard);
    assert.equal(codes(trip(five)).includes('no-easy-day'), true);
    assert.equal(codes(trip(five)).includes('walking-heavy'), false);
    const broken = [...five.slice(0, 2), day('2026-11-23', [stop('x', 0)]), ...five.slice(3)];
    assert.equal(codes(trip(broken)).includes('no-easy-day'), false);
  });

  test('a day the user accepted stops raising that note, and only that note and that day', () => {
    const far = (d: string, accepted?: string[]) => day(d, [stop('a' + d, 0), stop('b' + d, 2.5), stop('c' + d, 5), stop('e' + d, 7.5), stop('f' + d, 10)], accepted);
    const t = trip([far('2026-11-21', ['walking-heavy']), far('2026-11-22')]);
    assert.deepEqual(readiness(t, { now: NOW }).filter((i) => i.code === 'walking-heavy').map((i) => i.date), ['2026-11-22']);
    assert.equal(codes(trip([far('2026-11-21', ['no-easy-day'])])).includes('walking-heavy'), true, 'accepting a different note does not hide this one');
  });

  test('all of them are notes, never warnings', () => {
    const issues = readiness(trip([day('2026-11-21', [stop('a', 0), stop('b', 2.5), stop('c', 5), stop('d', 7.5), stop('e', 10)])]), { now: NOW }).filter((i) => ['walking-heavy', 'day-time-tight', 'no-easy-day', 'booking-link-missing'].includes(i.code));
    assert.ok(issues.length > 0 && issues.every((i) => i.level === 'info'));
  });
});


test('a restaurant chosen from the food guide is re-checked before leaving once its proof is a month old', () => {
  const t = (fetchedAt: string): Trip => ({
    title: 'T', start: '2026-12-01', end: '2026-12-02', tz: 'Europe/Rome', party: { adults: 2, childrenAges: [] }, candidates: [],
    days: [{ date: '2026-12-01', items: [{ id: 'm', kind: 'meal', title: 'Luzzi', loc: { lat: 1, lng: 1, fetchedAt }, placeId: 'osm:node/1', checks: { exists: { value: true, source: 'osm:node/1', fetchedAt, confidence: 'recent' } } } as never] }],
  });
  const now = new Date('2026-11-20T10:00:00Z');
  assert.equal(readiness(t('2026-11-15T10:00:00Z'), { now }).some((i) => i.code === 'meal-check-stale'), false, 'five days old: fine');
  const stale = readiness(t('2026-10-01T10:00:00Z'), { now }).find((i) => i.code === 'meal-check-stale');
  assert.ok(stale && stale.level === 'info' && /Luzzi/.test(stale.message));
});
