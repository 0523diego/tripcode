import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffDay, formatMinutes, hotelByDay, hotelChanges, timedMinutes, tripDayStats, tripMetrics } from './compare.ts';
import { sampleTrip } from './fixtures/sample-trip.ts';
import { variantFixture } from './fixtures/variant-fixture.ts';
import type { Trip } from '../core/types.ts';

test('metrics count days, pois, transit legs and candidates', () => {
  const m = tripMetrics(sampleTrip);
  assert.equal(m.days, sampleTrip.days.length);
  assert.equal(m.candidates, sampleTrip.candidates.length);
  const pois = sampleTrip.days.flatMap((d) => d.items).filter((i) => i.kind === 'poi').length;
  assert.equal(m.pois, pois);
});

test('hotelByDay spreads nights over following days; changes = distinct stays - 1', () => {
  const trip: Trip = {
    ...sampleTrip,
    days: [1, 2, 3, 4].map((n) => ({ date: `2027-06-1${n}`, items: [] })),
  };
  const d = trip.days;
  d[0]?.items.push({ id: 'h1', kind: 'hotel', title: 'A', nights: 2 });
  d[2]?.items.push({ id: 'h2', kind: 'hotel', title: 'B', nights: 1 });
  assert.deepEqual(hotelByDay(trip), ['A', 'A', 'B', undefined]);
  assert.equal(hotelChanges(trip), 1);
  assert.equal(hotelChanges({ ...trip, days: [] }), 0);
});

test('timedMinutes only counts items with valid start and end', () => {
  assert.equal(
    timedMinutes([
      { id: 'a', kind: 'poi', title: 'a', start: '09:00', end: '10:30' },
      { id: 'b', kind: 'poi', title: 'b', start: '11:00' },
      { id: 'c', kind: 'free', title: 'c', start: '12:00', end: '11:00' },
    ]),
    90,
  );
  assert.equal(formatMinutes(90), '1 小時 30 分');
  assert.equal(formatMinutes(0), '0 分');
});

test('diffDay flags the changed day and lists items only on one side', () => {
  const a = tripDayStats(sampleTrip);
  const b = tripDayStats(variantFixture);
  assert.equal(diffDay(a[0], b[0]).differs, false);
  const d = diffDay(a[1], b[1]);
  assert.equal(d.differs, true);
  assert.equal(d.title, true);
  assert.ok(d.onlyB.includes('多出來的景點'));
  assert.equal(diffDay(a[0], undefined).differs, true);
});
