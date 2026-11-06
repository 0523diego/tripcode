import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { planStages, stageSummary } from './plan.ts';
import type { Item, Trip } from './types.ts';

const NOW = new Date('2026-11-04T12:00:00Z');
const trip = (days: { date: string; items: Item[] }[]): Trip =>
  ({ title: 't', start: days[0]!.date, end: days.at(-1)!.date, tz: 'Europe/Rome', party: { adults: 1, childrenAges: [] }, days, candidates: [] }) as Trip;
const poi = (id: string, over: Partial<Item> = {}): Item => ({ id, kind: 'poi', title: id, loc: { lat: 1, lng: 1, fetchedAt: '2026-11-01T00:00:00Z' }, ...over }) as Item;
const hotel = (id: string, nights: number): Item => ({ id, kind: 'hotel', title: id, nights, locked: true, loc: { lat: 1, lng: 1, fetchedAt: '2026-11-01T00:00:00Z' } }) as Item;
const status = (s: ReturnType<typeof planStages>) => s.map((x) => `${x.n}${x.status[0]}`).join(' ');

describe('planStages', () => {
  test('there are always the same five stages in the same order', () => {
    const s = planStages(trip([{ date: '2026-11-21', items: [] }]), { now: NOW });
    assert.deepEqual(s.map((x) => x.id), ['inventory', 'itinerary', 'review', 'booking', 'departure']);
    assert.ok(s.every((x) => x.criteria && x.next && x.skill));
  });
  test('an empty trip is at step 1, and nothing after it counts as done just because it has nothing to check', () => {
    const s = planStages(trip([{ date: '2026-11-12', items: [] }, { date: '2026-11-13', items: [] }]), { now: NOW });
    assert.equal(status(s), '1d 2t 3t 4t 5t');
    assert.equal(stageSummary(s).startsWith('現在在第 1 步：盤點'), true);
  });
  test('a filled trip with an unfilled brief is still at step 1', () => {
    const s = planStages(trip([{ date: '2026-11-21', items: [poi('a')] }]), { now: NOW, brief: '偏好：（待填）' });
    assert.equal(s[0]!.status, 'doing');
  });
  test('days with nothing planned keep it at step 2', () => {
    const s = planStages(trip([{ date: '2026-11-21', items: [poi('a')] }, { date: '2026-11-22', items: [] }]), { now: NOW, brief: '偏好：慢慢走' });
    assert.equal(status(s), '1d 2d 3t 4t 5t');
  });
  test('an unbought required ticket holds it at step 4, and the stage says what to do', () => {
    const t = trip([{ date: '2026-11-21', items: [hotel('h', 1), poi('a', { booking: { need: 'required', status: 'todo' } })] }, { date: '2026-11-22', items: [poi('b')] }]);
    const s = planStages(t, { now: NOW, brief: '偏好：慢慢走' });
    assert.equal(s[3]!.status, 'doing');
    assert.equal(s[3]!.skill, 'booking-checklist');
    assert.ok(s[3]!.open >= 1);
  });
  test('everything settled: five done, one line to say so', () => {
    const ok = { value: 'https://t.example.org/', source: 'https://example.org/', fetchedAt: '2026-11-03T00:00:00Z', confidence: 'recent' as const };
    const meal = (id: string, start: string) => ({ id, kind: 'meal', title: id, placeId: 'p1', start, loc: { lat: 1, lng: 1, fetchedAt: '2026-11-01T00:00:00Z' } }) as Item;
    const t = trip([
      { date: '2026-11-21', items: [hotel('h', 1), poi('a', { booking: { need: 'required', status: 'booked', bookingUrl: ok } }), meal('l1', '12:30'), meal('d1', '20:00')] },
      { date: '2026-11-22', items: [poi('b'), meal('l2', '12:30'), meal('d2', '20:00')] },
    ]);
    const s = planStages(t, { now: NOW, brief: '偏好：慢慢走', check: [] });
    assert.equal(status(s), '1d 2d 3d 4d 5d');
    assert.equal(stageSummary(s), '五個步驟都完成了');
  });
  test('step 3 counts health-check problems and the day-structure notes', () => {
    const s = planStages(trip([{ date: '2026-11-21', items: [poi('a')] }]), { now: NOW, brief: 'x', check: [{ level: 'warn', code: 'overlap', message: 'x' }] });
    assert.equal(s[2]!.status, 'doing');
    assert.equal(s[2]!.open, 1);
  });
  test('every night needs a lodging point before the days count as planned; an undecided one is enough', () => {
    const days = (withHotel: boolean) => [
      { date: '2026-11-21', items: [...(withHotel ? [{ id: 'h', kind: 'hotel', title: '住宿（待選）', nights: 2, loc: { lat: 1, lng: 1, fetchedAt: '2026-11-01T00:00:00Z' } } as Item] : []), poi('a')] },
      { date: '2026-11-22', items: [poi('b')] },
      { date: '2026-11-23', items: [poi('c')] },
    ];
    const without = planStages(trip(days(false)), { now: NOW, brief: 'x' });
    assert.equal(without[1]!.status, 'doing');
    assert.equal(without[1]!.skill, 'create-trip');
    assert.ok(without[1]!.open >= 1);
    const placeholder = planStages(trip(days(true)), { now: NOW, brief: 'x' });
    assert.equal(placeholder[1]!.status, 'done', 'a hotel that is not booked yet still counts as where you sleep');
  });
});

