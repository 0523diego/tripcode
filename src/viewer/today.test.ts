import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Day, Trip } from '../core/types.ts';
import { dateInTz, nextItem, timeInTz, todayDayIdx, todayOverride, viewerNow } from './today.ts';

const day = (date: string, items: Array<{ id: string; start?: string }>): Day => ({
  date,
  items: items.map((i) => ({ id: i.id, title: i.id, kind: 'free', ...(i.start ? { start: i.start } : {}) })) as Day['items'],
});

const trip: Pick<Trip, 'start' | 'end' | 'days'> = {
  start: '2026-10-21',
  end: '2026-10-23',
  days: [day('2026-10-21', []), day('2026-10-22', []), day('2026-10-23', [])],
};

test('dateInTz uses the trip time zone, not the machine zone', () => {
  const t = new Date('2026-10-21T23:30:00Z');
  assert.equal(dateInTz('UTC', t), '2026-10-21');
  assert.equal(dateInTz('Asia/Taipei', t), '2026-10-22');
  assert.equal(timeInTz('Asia/Taipei', t), '07:30');
});

test('todayDayIdx lands on today only inside the trip range', () => {
  assert.equal(todayDayIdx(trip, '2026-10-22'), 1);
  assert.equal(todayDayIdx(trip, '2026-10-21'), 0);
  assert.equal(todayDayIdx(trip, '2026-10-20'), null);
  assert.equal(todayDayIdx(trip, '2026-10-24'), null);
});

test('todayDayIdx is null when a day inside the range has no entry', () => {
  assert.equal(todayDayIdx({ ...trip, days: [trip.days[0]!, trip.days[2]!] }, '2026-10-22'), null);
});

test('todayOverride only accepts a well-formed date', () => {
  assert.equal(todayOverride('?today=2026-10-22'), '2026-10-22');
  assert.equal(todayOverride('?today=tomorrow'), null);
  assert.equal(todayOverride(''), null);
  assert.equal(viewerNow('UTC', '?today=2026-10-22').date, '2026-10-22');
});

test('nextItem: first unstarted timed item today, first timed item otherwise', () => {
  const d = day('2026-10-22', [{ id: 'a', start: '09:00' }, { id: 'b' }, { id: 'c', start: '14:00' }, { id: 'd', start: '18:30' }]);
  assert.equal(nextItem(d, '13:59')?.id, 'c');
  assert.equal(nextItem(d, '14:00')?.id, 'c');
  assert.equal(nextItem(d, '19:00'), null);
  assert.equal(nextItem(d, null)?.id, 'a');
  assert.equal(nextItem(day('x', [{ id: 'only' }]), '10:00')?.id, 'only');
  assert.equal(nextItem(day('x', []), null), null);
});
