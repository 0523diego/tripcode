import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dayColorSlots, dayColorVar, dayStayIds, isDayColor, PALETTE_SIZE, sameStayDates } from './day-colors.ts';
import type { Day, Item } from './types.ts';

const hotel = (id: string, nights: number): Item => ({ id, kind: 'hotel', title: id, nights });
const poi = (id: string): Item => ({ id, kind: 'poi', title: id });
const day = (date: string, items: Item[] = [], color?: number): Day => ({ date, items, ...(color !== undefined ? { color } : {}) });

// Milan 2 nights, then Rome 3 nights, leaving on 11/25.
const trip = {
  days: [
    day('2026-11-20', [hotel('milan', 2)]),
    day('2026-11-21', [poi('duomo')]),
    day('2026-11-22', [hotel('rome', 3)]), // check-out of Milan and check-in at Rome the same day
    day('2026-11-23', [poi('forum')]),
    day('2026-11-24', []),
    day('2026-11-25', [poi('airport')]), // leaves: slept at Rome last night
  ],
};

test('days that sleep in the same hotel share a color, handed out in the order the trip reaches the hotels', () => {
  assert.deepEqual(dayStayIds(trip), ['milan', 'milan', 'rome', 'rome', 'rome', 'rome']);
  assert.deepEqual(dayColorSlots(trip), [1, 1, 2, 2, 2, 2]);
});

test('a trip with no hotels keeps one color per day, exactly as before', () => {
  const bare = { days: ['2026-11-20', '2026-11-21', '2026-11-22'].map((d) => day(d)) };
  assert.deepEqual(dayColorSlots(bare), [1, 2, 3]);
  const long = { days: Array.from({ length: 10 }, (_, i) => day(`2026-11-${String(10 + i).padStart(2, '0')}`)) };
  assert.deepEqual(dayColorSlots(long), [1, 2, 3, 4, 5, 6, 7, 8, 1, 2], 'wraps after the 8 palette slots');
});

test('a day that sleeps nowhere gets a color of its own; the day you leave a hotel still belongs to it', () => {
  const t = { days: [day('2026-11-20', [hotel('a', 1)]), day('2026-11-21'), day('2026-11-22', [hotel('b', 1)])] };
  assert.deepEqual(dayStayIds(t), ['a', 'a', 'b'], '11/21 is the day you leave a');
  const gap = { days: [day('2026-11-20', [hotel('a', 1)]), day('2026-11-22', [hotel('b', 1)]), day('2026-11-24')] };
  assert.deepEqual(dayStayIds(gap), ['a', 'b', undefined]);
  assert.deepEqual(dayColorSlots(gap), [1, 2, 3]);
});

test("a day's own color wins and does not shift anyone else's", () => {
  const t = { ...trip, days: trip.days.map((d, i) => (i === 3 ? { ...d, color: 7 } : d)) };
  assert.deepEqual(dayColorSlots(t), [1, 1, 2, 7, 2, 2]);
});

test('an invalid color is ignored', () => {
  for (const bad of [0, 9, 2.5, -1, NaN]) {
    const t = { days: trip.days.map((d, i) => (i === 0 ? { ...d, color: bad } : d)) };
    assert.deepEqual(dayColorSlots(t), [1, 1, 2, 2, 2, 2], String(bad));
  }
  assert.equal(isDayColor(1), true);
  assert.equal(isDayColor(PALETTE_SIZE), true);
  assert.equal(isDayColor('3'), false);
});

test('sameStayDates lists the days a hotel color change should reach', () => {
  assert.deepEqual(sameStayDates(trip, '2026-11-23'), ['2026-11-22', '2026-11-23', '2026-11-24', '2026-11-25']);
  assert.deepEqual(sameStayDates(trip, '2026-11-20'), ['2026-11-20', '2026-11-21']);
  const gap = { days: [day('2026-11-20', [hotel('a', 1)]), day('2026-11-22')] };
  assert.deepEqual(sameStayDates(gap, '2026-11-22'), ['2026-11-22'], 'no hotel: only itself');
  assert.deepEqual(sameStayDates(trip, '2030-01-01'), []);
});

test('the CSS variable name follows the slot', () => {
  assert.equal(dayColorVar(3), '--day-3');
});
