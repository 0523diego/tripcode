import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { BookingList, BookingTodo } from '../../core/bookings.ts';
import type { MealGap } from '../../core/meals.ts';
import type { Day, Item } from '../../core/types.ts';
import { anchorChoices, counts, countdowns, filterTodos, groupByPlace, insertionPoint, placeOf, relTime, shortDate, weekdayZh } from './booking-model.ts';

const todo = (over: Partial<BookingTodo>): BookingTodo => ({ itemId: 'x', date: '2026-11-20', title: 'x', category: 'entry', need: 'required', status: 'todo', reason: 'r', basis: 'explicit', urgency: 'later', links: [], hasVoucher: false, ...over });

describe('booking-model', () => {
  const list: BookingList = { items: [todo({ itemId: 'a', urgency: 'overdue' }), todo({ itemId: 'b', urgency: 'now' }), todo({ itemId: 'c', urgency: 'soon' }), todo({ itemId: 'd', status: 'booked', urgency: 'none' }), todo({ itemId: 'e', status: 'not-needed', urgency: 'none' })], unknown: [] };
  test('filters and counts', () => {
    assert.deepEqual(filterTodos(list, 'todo').map((t) => t.itemId), ['a', 'b', 'c']);
    assert.deepEqual(counts(list), { todo: 3, booked: 1, 'not-needed': 1, all: 5 });
  });
  const hotel = (id: string, title: string, nights: number): Item => ({ id, kind: 'hotel', title, nights });
  test('without a city, things group under the hotel you sleep in; the day you leave belongs to the last stay', () => {
    const trip = { days: [{ date: '2026-11-20', items: [hotel('m', 'Hotel Milano（米蘭中央）', 1)] }, { date: '2026-11-21', items: [hotel('r', 'Hotel Roma', 3)] }, { date: '2026-11-22', items: [] }, { date: '2026-11-23', items: [] }, { date: '2026-11-24', items: [] }] };
    const place = placeOf(trip);
    assert.deepEqual([place('2026-11-20'), place('2026-11-22'), place('2026-11-24')].map((p) => [p.key, p.label, p.kind]), [['stay:m', 'Hotel Milano', 'stay'], ['stay:r', 'Hotel Roma', 'stay'], ['stay:r', 'Hotel Roma', 'stay']]);
    assert.equal(place('2026-12-30').kind, 'none', 'no hotel at all: its own group, never guessed');
  });
  test('a day\'s own city wins over the hotel and merges non-adjacent visits', () => {
    const trip = { days: [{ date: '2026-11-20', city: '米蘭', items: [hotel('m', 'Hotel Milano', 1)] }, { date: '2026-11-21', city: '羅馬', items: [hotel('r', 'Hotel Roma', 3)] }, { date: '2026-11-24', city: '米蘭', items: [hotel('m2', 'Seveso', 1)] }] };
    const groups = groupByPlace([{ date: '2026-11-24', n: 'c' }, { date: '2026-11-20', n: 'a' }, { date: '2026-11-21', n: 'b' }], placeOf(trip));
    assert.deepEqual(groups.map((g) => [g.label, g.from, g.to, g.items.map((i) => i.n)]), [['米蘭', '2026-11-20', '2026-11-24', ['a', 'c']], ['羅馬', '2026-11-21', '2026-11-21', ['b']]]);
  });
  test('countdown wording', () => {
    assert.deepEqual(countdowns({ opensOn: '2026-11-03', deadlineOn: '2026-11-05' }, '2026-11-04'), ['已開賣', '明天截止']);
    assert.deepEqual(countdowns({ opensOn: '2026-11-04' }, '2026-11-04'), ['今天開賣']);
    assert.deepEqual(countdowns({ opensOn: '2026-11-14' }, '2026-11-04'), ['10 天後開賣（11/14）']);
    assert.deepEqual(countdowns({}, '2026-11-04'), []);
  });
  test('dates in Chinese', () => {
    assert.equal(weekdayZh('2026-11-27'), '週五');
    assert.equal(shortDate('2026-11-07'), '11/7');
  });
  const day: Day = { date: '2026-11-22', items: [{ id: 'a', kind: 'poi', title: 'A' }, { id: 'b', kind: 'poi', title: 'B' }, { id: 'c', kind: 'poi', title: 'C' }] };
  const gap: MealGap = { date: day.date, slot: 'lunch', kind: 'missing', window: { from: '12:00', to: '14:30' }, prev: { itemId: 'a', title: 'A' }, next: { itemId: 'b', title: 'B' }, hotel: { itemId: 'h', title: 'H' }, defaultAnchor: 'prev', basis: 'positional' };
  test('the meal goes where the user chose', () => {
    assert.equal(insertionPoint(day, gap, 'prev'), 'b');
    assert.equal(insertionPoint(day, gap, 'next'), 'b');
    assert.equal(insertionPoint(day, { ...gap, prev: { itemId: 'c', title: 'C' }, next: undefined }, 'prev'), undefined, 'after the last stop = end of day');
    assert.equal(insertionPoint(day, gap, 'hotel'), undefined);
    assert.equal(insertionPoint(undefined, gap, 'prev'), undefined);
  });
  test('only anchors that exist are offered', () => {
    assert.deepEqual(anchorChoices({ ...gap, hotel: undefined }).map((a) => a.key), ['prev', 'next']);
    assert.deepEqual(anchorChoices({ ...gap, prev: undefined, next: undefined, hotel: undefined }), []);
  });
  test('relative time in Chinese', () => {
    const now = Date.parse('2026-11-01T12:00:00Z');
    assert.equal(relTime('2026-11-01T11:59:50Z', now), '剛剛');
    assert.equal(relTime('2026-11-01T11:55:00Z', now), '5 分鐘前');
    assert.equal(relTime('2026-11-01T10:00:00Z', now), '2 小時前');
    assert.equal(relTime(undefined, now), '');
  });
});
