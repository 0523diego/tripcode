import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkTrip } from './check.ts';
import type { Day, Item, OpeningHours, Sourced, Trip } from './types.ts';

const src = <T>(value: T): Sourced<T> => ({ value, source: 'user', fetchedAt: '2026-06-01T10:00:00Z', confidence: 'recent' });

function trip(days: Day[], extra: Partial<Trip> = {}): Trip {
  return {
    title: 'T',
    start: '2026-06-14', // Sunday
    end: '2026-06-20',
    tz: 'Europe/Zurich',
    party: { adults: 2, childrenAges: [] },
    days,
    candidates: [],
    ...extra,
  };
}
const poi = (id: string, start?: string, end?: string, rest: Partial<Item> = {}): Item =>
  ({ id, kind: 'poi', title: id, start, end, ...rest }) as Item;
const day = (date: string, items: Item[]): Day => ({ date, items });
// `leg-endpoints` has its own tests below; the other tests build bare flights and legs, so they do not count it.
const codes = (t: Trip, opts?: Parameters<typeof checkTrip>[1]) => checkTrip(t, opts).map((i) => i.code).filter((c) => c !== 'leg-endpoints');
const legCodes = (t: Trip) => checkTrip(t).map((i) => i.code);
const issuesOf = (t: Trip, opts?: Parameters<typeof checkTrip>[1]) => checkTrip(t, opts).filter((i) => i.code !== 'leg-endpoints');

test('clean trip has no issues', () => {
  const t = trip([day('2026-06-14', [poi('a', '09:00', '10:00'), poi('b', '10:00', '11:00')])]);
  assert.deepEqual(issuesOf(t), []);
});

test('date-range: outside trip, malformed, out of order and duplicate dates', () => {
  const t = trip([day('2026-06-13', []), day('2026-06-21', []), day('2026-06-16', []), day('2026-06-16', []), day('2026-06-15', []), day('bad', [])]);
  const issues = issuesOf(t).filter((i) => i.code === 'date-range');
  assert.equal(issues.length, 6);
  assert.ok(issues.every((i) => i.level === 'error'));
  assert.ok(issues.some((i) => i.message.includes('重複')));
  assert.ok(issues.some((i) => i.message.includes('格式')));
});

test('date-range: in-range ascending days are fine', () => {
  assert.deepEqual(codes(trip([day('2026-06-14', []), day('2026-06-15', []), day('2026-06-20', [])])), []);
});

test('time-order: end earlier than start', () => {
  const issues = issuesOf(trip([day('2026-06-14', [poi('a', '10:00', '09:00')])]));
  assert.deepEqual(issues.map((i) => i.code), ['time-order']);
  assert.equal(issues[0]?.itemId, 'a');
  assert.equal(issues[0]?.level, 'error');
  assert.equal(issues[0]?.date, '2026-06-14');
});

test('time-order: equal times fine; overnight flight is not flagged', () => {
  const flight: Item = { id: 'f', kind: 'flight', title: 'TPE→ZRH', flightNo: 'BR1', start: '23:50', end: '06:30' };
  assert.deepEqual(codes(trip([day('2026-06-14', [poi('a', '09:00', '09:00'), flight])])), []);
});

test('invalid-time: malformed HH:MM', () => {
  const issues = issuesOf(trip([day('2026-06-14', [poi('a', '9:00', '25:00')])]));
  assert.deepEqual(issues.map((i) => i.code), ['invalid-time', 'invalid-time']);
});

test('overlap: starts before previous timed item ends', () => {
  const t = trip([day('2026-06-14', [poi('a', '09:00', '10:30'), poi('b', '10:00', '11:00')])]);
  const issues = issuesOf(t);
  assert.deepEqual(issues.map((i) => i.code), ['overlap']);
  assert.equal(issues[0]?.itemId, 'b');
});

test('overlap: untimed items are skipped, back-to-back ok, previous without end ok', () => {
  const t = trip([
    day('2026-06-14', [
      poi('a', '09:00', '10:00'),
      { id: 'free', kind: 'free', title: 'free' },
      poi('b', '10:00', '11:00'),
      poi('c', '11:00'),
      poi('d', '11:00', '12:00'),
    ]),
  ]);
  assert.deepEqual(issuesOf(t), []);
});

test('overlap does not cross days', () => {
  const t = trip([day('2026-06-14', [poi('a', '20:00', '23:00')]), day('2026-06-15', [poi('b', '08:00', '09:00')])]);
  assert.deepEqual(issuesOf(t), []);
});

const monToSat: OpeningHours = {
  periods: [1, 2, 3, 4, 5, 6].map((d) => ({ day: d, open: '09:00', close: '17:00' })),
  closedDates: ['2026-06-16'],
};

test('closed: weekday with no period (item.hours fallback)', () => {
  // 2026-06-14 is Sunday
  const t = trip([day('2026-06-14', [poi('museum', '10:00', '11:00', { hours: src(monToSat) })])]);
  const issues = issuesOf(t);
  assert.deepEqual(issues.map((i) => i.code), ['closed']);
  assert.equal(issues[0]?.level, 'error');
  assert.match(issues[0]?.message ?? '', /週日/);
});

test('closed: closedDates', () => {
  const t = trip([day('2026-06-16', [poi('museum', '10:00', '11:00', { hours: src(monToSat) })])]);
  const issues = issuesOf(t);
  assert.deepEqual(issues.map((i) => i.code), ['closed']);
  assert.match(issues[0]?.message ?? '', /公休/);
});

test('outside-hours: warn when start..end not inside an open period', () => {
  const t = trip([
    day('2026-06-15', [
      poi('ok', '09:00', '17:00', { hours: src(monToSat) }),
      poi('early', '08:00', '09:30', { hours: src(monToSat) }),
      poi('late', '16:00', '18:00', { hours: src(monToSat) }),
      poi('startOnly', '17:30', undefined, { hours: src(monToSat) }),
    ]),
  ]);
  const issues = issuesOf(t).filter((i) => i.code === 'outside-hours');
  assert.deepEqual(issues.map((i) => i.itemId), ['early', 'late', 'startOnly']);
  assert.ok(issues.every((i) => i.level === 'warn'));
});

test('outside-hours: split periods and gap between them', () => {
  const split: OpeningHours = { periods: [{ day: 1, open: '09:00', close: '12:00' }, { day: 1, open: '14:00', close: '18:00' }] };
  const t = trip([
    day('2026-06-15', [
      poi('am', '09:30', '11:30', { hours: src(split) }),
      poi('lunch', '12:30', '13:30', { hours: src(split) }),
      poi('pm', '14:00', '15:00', { hours: src(split) }),
    ]),
  ]);
  assert.deepEqual(issuesOf(t).filter((i) => i.code === 'outside-hours').map((i) => i.itemId), ['lunch']);
});

test('hours: overnight period and spill-over into the next weekday', () => {
  // open Sat(6) 20:00 -> 02:00 Sun
  const bar: OpeningHours = { periods: [{ day: 6, open: '20:00', close: '02:00' }] };
  const t = trip([
    day('2026-06-14', [poi('lateSun', '00:30', '01:30', { hours: src(bar) })]), // Sunday early morning
    day('2026-06-20', [poi('sat', '21:00', '23:30', { hours: src(bar) })]), // Saturday
  ]);
  assert.deepEqual(issuesOf(t), []);
});

test('hours: 00:00-00:00 means open all day; empty periods are treated as unknown', () => {
  const all: OpeningHours = { periods: [{ day: 0, open: '00:00', close: '00:00' }] };
  const unknown: OpeningHours = { periods: [] };
  const t = trip([day('2026-06-14', [poi('a', '03:00', '23:00', { hours: src(all) }), poi('b', '23:30', '23:45', { hours: src(unknown) })])]);
  assert.deepEqual(issuesOf(t), []);
});

test('hoursFor takes precedence over item.hours and receives item and day', () => {
  const seen: string[] = [];
  const open: OpeningHours = { periods: [{ day: 0, open: '08:00', close: '20:00' }] };
  const t = trip([day('2026-06-14', [poi('m', '10:00', '11:00', { hours: src(monToSat) })])]);
  const issues = issuesOf(t, {
    hoursFor: (item, d) => {
      seen.push(`${item.id}@${d.date}`);
      return open;
    },
  });
  assert.deepEqual(issues, []);
  assert.deepEqual(seen, ['m@2026-06-14']);
});

test('hoursFor returning undefined falls back to item.hours; untimed items are not hour-checked', () => {
  const t = trip([day('2026-06-14', [poi('m', '10:00', '11:00', { hours: src(monToSat) }), poi('untimed', undefined, undefined, { hours: src(monToSat) })])]);
  assert.deepEqual(codes(t, { hoursFor: () => undefined }), ['closed']);
});

test('transit-gap: window shorter than duration', () => {
  const tr = (end: string): Item => ({ id: 't', kind: 'transit', mode: 'train', title: 'IC', start: '10:00', end, duration: src(45) });
  assert.deepEqual(codes(trip([day('2026-06-14', [tr('10:30')])])), ['transit-gap']);
  assert.deepEqual(codes(trip([day('2026-06-14', [tr('10:45')])])), []);
  const noDuration: Item = { id: 't2', kind: 'transit', mode: 'bus', title: 'bus', start: '10:00', end: '10:05' };
  assert.deepEqual(codes(trip([day('2026-06-14', [noDuration])])), []);
});

const landing: Item = { id: 'fl', kind: 'flight', flightNo: 'LX1', title: 'ZRH 抵達', start: '06:00', end: '08:05' };

test('arrival: first non-flight item too soon after landing', () => {
  const t = trip([day('2026-06-14', [landing, poi('kapell', '08:30')])]);
  const issues = issuesOf(t);
  assert.deepEqual(issues.map((i) => i.code), ['arrival']);
  assert.equal(issues[0]?.level, 'warn');
  assert.equal(issues[0]?.itemId, 'kapell');
});

test('arrival: message format and 60 minute boundary', () => {
  const early = trip([day('2026-06-14', [landing, poi('kapell', '08:30', undefined, { title: '卡貝爾橋' })])]);
  assert.equal(issuesOf(early)[0]?.message, '08:30 卡貝爾橋早於抵達後可行時間（08:05 抵達）');
  const exact = trip([day('2026-06-14', [landing, poi('kapell', '09:05')])]);
  assert.deepEqual(issuesOf(exact), []);
});

test('arrival: only the first non-flight item is checked; departing flights do not trigger it', () => {
  const t = trip([day('2026-06-14', [landing, poi('a', '10:00', '11:00'), poi('b', '09:00', '09:30')])]);
  // b overlaps a? b starts before a ends → overlap, but arrival only concerns a
  assert.ok(!codes(t).includes('arrival'));
  const departing: Item = { id: 'dep', kind: 'flight', flightNo: 'LX2', title: 'depart', start: '18:00', end: '20:00' };
  assert.deepEqual(issuesOf(trip([day('2026-06-14', [poi('a', '09:00', '10:00'), departing])])), []);
});

test('arrival: first item without a start time is not checked', () => {
  assert.deepEqual(issuesOf(trip([day('2026-06-14', [landing, { id: 'h', kind: 'hotel', title: 'Hotel', nights: 2 }, poi('a', '08:30')])])), []);
});

test('missing-source: empty source or bad fetchedAt on any Sourced field', () => {
  const bad = (): Sourced<number> => ({ value: 1, source: ' ', fetchedAt: '2026-06-01T00:00:00Z', confidence: 'live' });
  const badDate = (): Sourced<any> => ({ value: 1, source: 'x', fetchedAt: 'yesterday', confidence: 'live' });
  const t = trip([
    day('2026-06-14', [
      { id: 'p', kind: 'poi', title: 'p', ticket: { value: { amount: 1, currency: 'CHF' }, source: '', fetchedAt: '2026-06-01', confidence: 'live' } },
      { id: 'h', kind: 'hotel', title: 'h', nights: 1, price: { value: { amount: 1, currency: 'CHF' }, source: 'x', fetchedAt: '', confidence: 'live' } },
      { id: 't', kind: 'transit', mode: 'train', title: 't', duration: bad(), fare: badDate() },
      { id: 'f', kind: 'flight', flightNo: 'X', title: 'f', price: badDate() },
      poi('hr', undefined, undefined, { hours: { value: { periods: [] }, source: '', fetchedAt: '2026-06-01', confidence: 'live' } }),
    ]),
  ]);
  const issues = issuesOf(t).filter((i) => i.code === 'missing-source');
  assert.deepEqual(issues.map((i) => i.itemId), ['p', 'h', 't', 't', 'f', 'hr']);
  assert.ok(issues.every((i) => i.level === 'error'));
});

test('missing-source: a bare number where Sourced is required is rejected; valid values pass', () => {
  const bare = { id: 't', kind: 'transit', mode: 'train', title: 't', duration: 45 } as unknown as Item;
  assert.deepEqual(codes(trip([day('2026-06-14', [bare])])), ['missing-source']);
  const ok: Item = { id: 't', kind: 'transit', mode: 'train', title: 't', duration: src(45), fare: src({ amount: 5, currency: 'CHF' }) };
  assert.deepEqual(issuesOf(trip([day('2026-06-14', [ok])])), []);
});

test('duplicate-id: across days and between item and candidate', () => {
  const t = trip(
    [day('2026-06-14', [poi('a'), poi('a')]), day('2026-06-15', [poi('b')])],
    { candidates: [{ id: 'b', title: 'B', status: 'unconfirmed', sources: ['claude'] }, { id: 'c', title: 'C', status: 'unconfirmed', sources: [] }] },
  );
  const issues = issuesOf(t).filter((i) => i.code === 'duplicate-id');
  assert.deepEqual(issues.map((i) => i.itemId), ['a', 'b']);
  assert.equal(issues[0]?.date, '2026-06-14');
  assert.equal(issues[1]?.date, undefined);
});

test('check never throws on bad dates or times', () => {
  const t = trip([day('nonsense', [poi('a', 'xx', 'yy', { hours: src(monToSat) })])]);
  assert.doesNotThrow(() => issuesOf(t));
});

// ---- missing-transit / day-overload ------------------------------------------------------

const at = (lat: number, lng = 8.3) => ({ lat, lng });
const stop = (id: string, loc: { lat: number; lng: number }, rest: Record<string, unknown> = {}): Item => ({ id, kind: 'poi', title: `地點${id}`, loc, ...rest }) as Item;
const bus = (id: string, rest: Record<string, unknown> = {}): Item => ({ id, kind: 'transit', mode: 'bus', title: '巴士', ...rest }) as Item;

test('missing-transit: far-apart adjacent stops without transit warn and name both places', () => {
  // ~33 km apart: straight-line transit estimate is far above 20 minutes.
  const issues = issuesOf(trip([day('2026-06-14', [stop('a', at(47.0)), stop('b', at(47.3))])])).filter((i) => i.code === 'missing-transit');
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.level, 'warn');
  assert.equal(issues[0]?.itemId, 'b');
  assert.equal(issues[0]?.date, '2026-06-14');
  assert.ok(issues[0]?.message.includes('地點a') && issues[0]?.message.includes('地點b'));
  assert.ok(issues[0]?.message.includes('沒有安排交通'));
});

test('missing-transit: beyond 30 km only the distance is quoted, never minutes', () => {
  // 47.0 → 48.4 is ~155 km
  const issues = issuesOf(trip([day('2026-06-14', [stop('a', at(47.0)), stop('b', at(48.4))])])).filter((i) => i.code === 'missing-transit');
  assert.equal(issues.length, 1);
  assert.match(issues[0]!.message, /相距約 15\d 公里/);
  assert.ok(!issues[0]!.message.includes('分鐘'));
  // within 30 km the estimate is still given
  const near = issuesOf(trip([day('2026-06-14', [stop('a', at(47.0)), stop('b', at(47.2))])])).filter((i) => i.code === 'missing-transit');
  assert.match(near[0]!.message, /直線估算約 \d+ 分鐘/);
});

test('missing-transit: a locked item at either end or in between silences the pair', () => {
  const far = at(47.3);
  assert.deepEqual(codes(trip([day('2026-06-14', [stop('a', at(47.0), { locked: true }), stop('b', far)])])), []);
  assert.deepEqual(codes(trip([day('2026-06-14', [stop('a', at(47.0)), stop('b', far, { locked: true })])])), []);
  assert.deepEqual(codes(trip([day('2026-06-14', [stop('a', at(47.0)), { id: 'k', kind: 'free', title: '已訂團', locked: true } as Item, stop('b', far)])])), []);
  // the lock only covers its own pairs: b → c is still reported
  assert.deepEqual(codes(trip([day('2026-06-14', [stop('a', at(47.0), { locked: true }), stop('b', far), stop('c', at(47.0))])])), ['missing-transit']);
});

test('missing-transit: a locked item without a location (booked tour) silences the rest of that day only', () => {
  const tour = { id: 'tour', kind: 'poi', title: '已訂巴士團', locked: true } as Item;
  const t = trip([
    day('2026-06-14', [stop('a', at(47.0)), tour, stop('b', at(47.3)), stop('c', at(48.4)), stop('d', at(47.0))]),
    day('2026-06-15', [stop('e', at(47.0)), stop('f', at(47.3))]),
  ]);
  assert.deepEqual(issuesOf(t).map((i) => [i.code, i.date]), [['missing-transit', '2026-06-15']]);
  // a locked hotel (has a location) only covers its own pairs
  const hotel = { id: 'h', kind: 'hotel', title: '飯店', nights: 1, loc: at(47.0), locked: true } as Item;
  assert.deepEqual(codes(trip([day('2026-06-14', [hotel, stop('b', at(47.3)), stop('c', at(47.0))])])), ['missing-transit']);
});

test('missing-transit: transit between the stops, close stops, and stops without coordinates do not warn', () => {
  assert.deepEqual(codes(trip([day('2026-06-14', [stop('a', at(47.0)), bus('t'), stop('b', at(47.3))])])), []);
  assert.deepEqual(codes(trip([day('2026-06-14', [stop('a', at(47.0)), stop('b', at(47.001))])])), []);
  assert.deepEqual(codes(trip([day('2026-06-14', [stop('a', at(47.0)), { id: 'n', kind: 'poi', title: 'n' } as Item])])), []);
});

test('missing-transit: an unlocated item in between does not hide the gap between located stops', () => {
  assert.deepEqual(codes(trip([day('2026-06-14', [stop('a', at(47.0)), poi('free-text'), stop('b', at(47.3))])])), ['missing-transit']);
});

test('missing-transit: only adjacent located stops are compared, per day, and flights are ignored', () => {
  const flight: Item = { id: 'f', kind: 'flight', title: 'TPE→ZRH', flightNo: 'BR1', loc: at(25.0, 121.2) };
  const t = trip([day('2026-06-14', [flight, stop('a', at(47.0)), stop('b', at(47.3)), bus('t'), stop('c', at(47.0))]), day('2026-06-15', [stop('d', at(47.3))])]);
  assert.deepEqual(codes(t), ['missing-transit']);
});

test('day-overload: stays plus estimated travel longer than the timed span warns', () => {
  const t = trip([day('2026-06-14', [stop('a', at(47.0), { start: '09:00', end: '10:00' }), stop('b', at(47.3), { start: '10:00', end: '11:00' })])]);
  const issues = issuesOf(t).filter((i) => i.code === 'day-overload');
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.level, 'warn');
  assert.equal(issues[0]?.date, '2026-06-14');
  assert.equal(issues[0]?.itemId, undefined);
  assert.ok(issues[0]?.message.includes('這天可能排不完'));
});

test('day-overload: a transit item without a known duration adds nothing (no invented travel time)', () => {
  const t = trip([day('2026-06-14', [stop('a', at(47.0), { start: '09:00', end: '10:00' }), bus('t'), stop('b', at(47.3), { start: '10:00', end: '11:00' })])]);
  assert.deepEqual(codes(t), []);
});

test('day-overload: items after the last timed item are not weighed against the span', () => {
  const t = trip([day('2026-06-14', [stop('a', at(47.0), { start: '09:00', end: '10:00' }), bus('t'), stop('b', at(47.0), { start: '10:30', end: '11:00' }), stop('c', at(47.9)), stop('d', at(47.0))])]);
  assert.ok(!codes(t).includes('day-overload'));
});

test('day-overload: a known transit duration replaces the estimate', () => {
  const dur = { value: 5, source: 'user', fetchedAt: '2026-06-01T10:00:00Z', confidence: 'recent' as const };
  const t = trip([
    day('2026-06-14', [stop('a', at(47.0), { start: '09:00', end: '10:00' }), bus('t', { duration: dur }), stop('b', at(47.3), { start: '10:10', end: '11:00' })]),
  ]);
  assert.deepEqual(codes(t), []);
});

test('day-overload: roomy days, single-timed days and days without stay info are skipped', () => {
  assert.deepEqual(codes(trip([day('2026-06-14', [stop('a', at(47.0), { start: '09:00', end: '10:00' }), bus('t'), stop('b', at(47.3), { start: '15:00', end: '16:00' })])])), []);
  assert.deepEqual(codes(trip([day('2026-06-14', [stop('a', at(47.0), { start: '09:00', end: '12:00' }), bus('t'), stop('b', at(47.3)), bus('u'), stop('c', at(47.0))])])), []);
  assert.deepEqual(codes(trip([day('2026-06-14', [stop('a', at(47.0), { minutes: 600 }), bus('t'), stop('b', at(47.3), { minutes: 600 })])])), []);
  assert.deepEqual(codes(trip([day('2026-06-14', [stop('a', at(47.0), { start: '09:00' }), bus('t'), stop('b', at(47.3))])])), []);
});

test('day-overload: overlapping windows are merged, not double counted', () => {
  const t = trip([day('2026-06-14', [poi('a', '09:00', '10:30'), poi('b', '10:00', '11:00')])]);
  assert.deepEqual(codes(t), ['overlap']);
});

test('day-overload: poi.minutes counts as stay when there is no end time', () => {
  const t = trip([day('2026-06-14', [stop('a', at(47.0), { start: '09:00', minutes: 120 }), bus('t'), stop('b', at(47.0), { start: '10:00', minutes: 30 })])]);
  assert.deepEqual(codes(t), ['day-overload']);
});

test('a day color outside 1–8 is a warning, a valid one is not', () => {
  const ok = trip([{ ...day('2026-06-15', []), color: 3 }]);
  assert.equal(codes(ok).includes('day-color'), false);
  for (const bad of [0, 9, 2.5]) {
    const t = trip([{ ...day('2026-06-15', []), color: bad }]);
    const issue = issuesOf(t).find((i) => i.code === 'day-color');
    assert.equal(issue?.level, 'warn', String(bad));
    assert.equal(issue?.date, '2026-06-15');
  }
});

test('a meal\'s checks are Sourced facts: a missing source is an error, a proper one passes', () => {
  const meal = (checks: unknown): Item => ({ id: 'm', kind: 'meal', title: 'Luzzi', checks }) as unknown as Item;
  const good = { exists: src(true), openAtSlot: src(true), recommendedBy: [{ ...src('文章推薦'), source: 'https://example.com/guide' }] };
  assert.deepEqual(issuesOf(trip([day('2026-06-14', [meal(good)])])).filter((i) => i.code === 'missing-source'), []);
  const bare = issuesOf(trip([day('2026-06-14', [meal({ exists: true })])])).filter((i) => i.code === 'missing-source');
  assert.equal(bare.length, 1);
  assert.match(bare[0]!.message, /餐廳存在/);
  const noDate = issuesOf(trip([day('2026-06-14', [meal({ exists: { value: true, source: 'osm:node/1', confidence: 'recent' } })])])).filter((i) => i.code === 'missing-source');
  assert.equal(noDate.length, 1);
});

// ---- leg-endpoints: a ticket leg shows where it starts and where it ends ----
const legBus = (id: string, rest: Partial<Item> = {}): Item => ({ id, kind: 'transit', mode: 'bus', title: id, start: '11:00', end: '15:45', ...rest }) as Item;
const here = { lat: 48.14, lng: 11.55 };
const there = { lat: 50.09, lng: 14.44 };

test('leg-endpoints: a bus with its departure loc and an arrival stop is complete', () => {
  const t = trip([day('2026-06-14', [legBus('bus', { loc: here }), poi('florenc', '15:45', undefined, { loc: there })])]);
  assert.deepEqual(legCodes(t), []);
});

test('leg-endpoints: only the arrival stop (the real 12/16 case) warns that the start is missing', () => {
  const t = trip([day('2026-06-14', [legBus('bus'), poi('florenc', '15:45', undefined, { loc: there })])]);
  const issues = checkTrip(t).filter((i) => i.code === 'leg-endpoints');
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.level, 'warn');
  assert.equal(issues[0]!.itemId, 'bus');
  assert.ok(issues[0]!.message.includes('出發點'));
});

test('leg-endpoints: a bus with loc but nothing after it warns that the end is missing', () => {
  const t = trip([day('2026-06-14', [legBus('bus', { loc: here })])]);
  const issues = checkTrip(t).filter((i) => i.code === 'leg-endpoints');
  assert.equal(issues.length, 1);
  assert.ok(issues[0]!.message.includes('抵達點'));
});

test('leg-endpoints: a metro leg between two located stops needs no loc of its own; a walk is never checked', () => {
  const between = trip([day('2026-06-14', [poi('a', '09:00', '10:00', { loc: here }), { id: 'ride', kind: 'transit', mode: 'train', title: 'ride', start: '10:00', end: '10:20' } as Item, poi('b', '10:20', '11:00', { loc: there })])]);
  assert.deepEqual(legCodes(between), []);
  const walk = trip([day('2026-06-14', [{ id: 'w', kind: 'transit', mode: 'walk', title: 'w', start: '10:00', end: '10:10' } as Item])]);
  assert.deepEqual(legCodes(walk), []);
});

test('leg-endpoints: a flight needs both airports; an overnight flight needs only the departure', () => {
  const fl = (rest: Partial<Item>): Item => ({ id: 'fl', kind: 'flight', flightNo: 'VY1160', title: 'fl', start: '06:50', end: '09:00', ...rest }) as Item;
  assert.deepEqual(legCodes(trip([day('2026-06-14', [fl({ loc: here })])])), ['leg-endpoints']);
  assert.deepEqual(legCodes(trip([day('2026-06-14', [fl({ loc: here, start: '22:00', end: '06:00' })])])), []);
  assert.deepEqual(legCodes(trip([day('2026-06-14', [fl({ loc: here }), poi('muc', '10:30', undefined, { loc: there })])])), []);
});
