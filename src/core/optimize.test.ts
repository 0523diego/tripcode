import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimateMatrix, estimateMinutes, haversineKm, optimizeDay, routableStops } from './optimize.ts';
import type { Day, Item } from './types.ts';

function poi(id: string, extra: Partial<Item> = {}): Item {
  return { id, kind: 'poi', title: `地點${id}`, loc: { lat: 47, lng: 8 }, ...extra } as Item;
}

function dayOf(items: Item[]): Day {
  return { date: '2027-06-13', items };
}

/** Stops sit on a line at the given positions; travel minutes = distance. */
function lineMatrix(pos: number[]): number[][] {
  return pos.map((a) => pos.map((b) => Math.abs(a - b)));
}

function pathCost(order: string[], ids: string[], matrix: number[][]): number {
  let c = 0;
  for (let k = 1; k < order.length; k++) c += matrix[ids.indexOf(order[k - 1]!)]![ids.indexOf(order[k]!)]!;
  return c;
}

/** Deterministic PRNG so random-matrix tests are reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randomMatrix(n: number, rand: () => number): number[][] {
  const pts = Array.from({ length: n }, () => [rand() * 60, rand() * 60] as const);
  return pts.map((a) => pts.map((b) => Math.round(Math.hypot(a[0] - b[0], a[1] - b[1]))));
}

function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs.slice()];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
}

test('routableStops excludes transit/free and items without a place', () => {
  const day = dayOf([
    poi('a'),
    { id: 't', kind: 'transit', mode: 'train', title: '火車', loc: { lat: 1, lng: 1 } },
    { id: 'f', kind: 'free', title: '自由活動', loc: { lat: 1, lng: 1 } },
    { id: 'n', kind: 'poi', title: '沒地點' },
    { id: 'p', kind: 'meal', title: '午餐', placeId: 'PID' },
  ]);
  assert.deepEqual(routableStops(day).map((i) => i.id), ['a', 'p']);
});

test('reorders a scrambled line into walking order and explains the move', () => {
  const ids = ['a', 'd', 'b', 'c'];
  const pos = [0, 30, 10, 20];
  const day = dayOf(ids.map((id) => poi(id)));
  const m = lineMatrix(pos);
  const r = optimizeDay(day, m);
  assert.deepEqual(r.order, ['a', 'b', 'c', 'd']);
  assert.equal(r.before, 60);
  assert.equal(r.after, 30);
  assert.ok(r.moves.length >= 1);
  assert.match(r.moves[0]!, /^把 地點\w 移到 地點\w 之前，少走 \d+ 分鐘$/);
});

test('already optimal order is returned unchanged with no moves', () => {
  const day = dayOf(['a', 'b', 'c'].map((id) => poi(id)));
  const r = optimizeDay(day, lineMatrix([0, 10, 20]));
  assert.deepEqual(r.order, ['a', 'b', 'c']);
  assert.equal(r.before, r.after);
  assert.deepEqual(r.moves, []);
});

test('equal-cost alternatives do not change the order', () => {
  const day = dayOf(['a', 'b', 'c'].map((id) => poi(id)));
  const flat = [
    [0, 5, 5],
    [5, 0, 5],
    [5, 5, 0],
  ];
  const r = optimizeDay(day, flat);
  assert.deepEqual(r.order, ['a', 'b', 'c']);
});

test('locked stops stay at their position', () => {
  const ids = ['hotel', 'd', 'b', 'c', 'e'];
  const pos = [0, 30, 10, 20, 5];
  const day = dayOf(ids.map((id) => (id === 'hotel' || id === 'c' ? poi(id, { locked: true }) : poi(id))));
  const r = optimizeDay(day, lineMatrix(pos));
  assert.equal(r.order[0], 'hotel');
  assert.equal(r.order[3], 'c');
  assert.deepEqual([...r.order].sort(), [...ids].sort());
  assert.ok(r.after <= r.before);
  // the only free slots are 1, 2, 4: best is e(5) b(10) ... d(30)
  const best = Math.min(
    ...permutations(['d', 'b', 'e']).map((p) => pathCost(['hotel', p[0]!, p[1]!, 'c', p[2]!], ids, lineMatrix(pos))),
  );
  assert.equal(r.after, best);
});

test('moves never name a locked stop as the moved item', () => {
  const ids = ['hotel', 'd', 'b', 'c'];
  const day = dayOf(ids.map((id) => (id === 'hotel' ? poi(id, { locked: true }) : poi(id))));
  const r = optimizeDay(day, lineMatrix([0, 30, 10, 20]));
  assert.ok(r.moves.length > 0);
  for (const line of r.moves) assert.ok(!line.startsWith('把 地點hotel'));
});

test('keepOrder preserves the relative order of the listed items', () => {
  const ids = ['a', 'd', 'b', 'c'];
  const pos = [0, 30, 10, 20];
  const day = dayOf(ids.map((id) => poi(id)));
  const m = lineMatrix(pos);
  const free = optimizeDay(day, m);
  assert.deepEqual(free.order, ['a', 'b', 'c', 'd']);
  const kept = optimizeDay(day, m, { keepOrder: ['d', 'b'] });
  assert.ok(kept.order.indexOf('d') < kept.order.indexOf('b'));
  assert.ok(kept.after <= kept.before);
  assert.ok(kept.after >= free.after);
});

test('keepOrder is respected on random exact searches', () => {
  const rand = rng(7);
  for (let t = 0; t < 20; t++) {
    const ids = Array.from({ length: 7 }, (_, i) => `s${i}`);
    const day = dayOf(ids.map((id) => poi(id)));
    const keep = ['s1', 's4', 's5'];
    const r = optimizeDay(day, randomMatrix(7, rand), { keepOrder: keep });
    const idx = keep.map((k) => r.order.indexOf(k));
    assert.deepEqual(idx, [...idx].sort((x, y) => x - y));
  }
});

test('exact search (≤8 movable) matches brute force and never worsens', () => {
  const rand = rng(42);
  for (let t = 0; t < 15; t++) {
    const n = 5 + (t % 4); // 5..8
    const ids = Array.from({ length: n }, (_, i) => `s${i}`);
    const m = randomMatrix(n, rand);
    const day = dayOf(ids.map((id, i) => poi(id, i === 0 ? { locked: true } : {})));
    const r = optimizeDay(day, m);
    const brute = Math.min(...permutations(ids.slice(1)).map((p) => pathCost(['s0', ...p], ids, m)));
    assert.equal(r.after, brute, `trial ${t}`);
    assert.ok(r.after <= r.before);
    assert.equal(r.order[0], 's0');
    assert.equal(r.before, pathCost(ids, ids, m));
  }
});

test('more than 8 movable stops: heuristic never worsens and fixes a scrambled line', () => {
  const pos = [50, 0, 90, 20, 70, 10, 80, 30, 60, 40, 100];
  const ids = pos.map((_, i) => `s${i}`);
  const day = dayOf(ids.map((id) => poi(id)));
  const m = lineMatrix(pos);
  const r = optimizeDay(day, m);
  assert.ok(r.after < r.before);
  assert.equal(r.after, 100); // monotone sweep is optimal on a line
  assert.equal(r.order.length, ids.length);
  assert.deepEqual([...r.order].sort(), [...ids].sort());

  const rand = rng(3);
  for (let t = 0; t < 5; t++) {
    const n = 12;
    const ids2 = Array.from({ length: n }, (_, i) => `s${i}`);
    const day2 = dayOf(ids2.map((id, i) => poi(id, i === 5 ? { locked: true } : {})));
    const r2 = optimizeDay(day2, randomMatrix(n, rand), { keepOrder: ['s2', 's9'] });
    assert.ok(r2.after <= r2.before);
    assert.equal(r2.order[5], 's5');
    assert.ok(r2.order.indexOf('s2') < r2.order.indexOf('s9'));
  }
});

test('time windows are respected', () => {
  // a=0, w=25, b=50. The shortest path is a,w,b (50) but a 30-minute stay at a plus 25 minutes of
  // travel reaches w at 09:55, after its fixed 09:30 start. Only orders with w first stay on time.
  const ids = ['w', 'a', 'b'];
  const pos = [25, 0, 50];
  const day = dayOf([
    poi('w', { start: '09:30', end: '10:30' }),
    poi('a', { minutes: 30 }),
    poi('b', { minutes: 30 }),
  ]);
  const r = optimizeDay(day, lineMatrix(pos), { dayStart: '09:00' });
  assert.equal(r.order[0], 'w');
  assert.equal(r.after, 75);
  // without the window the 50-minute order exists, so the window is what blocked it
  const free = optimizeDay(dayOf(ids.map((id) => poi(id, id === 'w' ? {} : { minutes: 30 }))), lineMatrix(pos), { dayStart: '09:00' });
  assert.equal(free.after, 50);
});

test('a reachable window item may still move when it fits', () => {
  const day = dayOf([
    poi('a', { minutes: 30 }),
    poi('w', { start: '14:00', end: '15:00' }),
    poi('b', { minutes: 30 }),
  ]);
  // a=0, b=5, w=10 → a,b,w is cheaper than a,w,b and w is still on time.
  const r = optimizeDay(day, lineMatrix([0, 10, 5]), { dayStart: '09:00' });
  assert.deepEqual(r.order, ['a', 'b', 'w']);
});

test('optimization never increases window lateness', () => {
  // Original order is already late for w (arrives 10:40 > 10:00); optimizer must not make it worse.
  const day = dayOf([poi('a', { minutes: 60 }), poi('w', { start: '10:00', end: '10:30' }), poi('b')]);
  const m = lineMatrix([0, 40, 10]);
  const r = optimizeDay(day, m, { dayStart: '09:00' });
  assert.ok(r.after <= r.before + 1000);
  assert.ok(r.order.indexOf('w') <= 1);
});

test('fewer than two stops and matrix validation', () => {
  assert.deepEqual(optimizeDay(dayOf([]), []), { order: [], before: 0, after: 0, moves: [] });
  assert.deepEqual(optimizeDay(dayOf([poi('a')]), [[0]]).order, ['a']);
  assert.throws(() => optimizeDay(dayOf([poi('a'), poi('b')]), [[0]]), RangeError);
  assert.throws(() => optimizeDay(dayOf([poi('a'), poi('b')]), lineMatrix([0, 1]), { dayStart: 'nope' }), RangeError);
  // transit items are not stops, so the matrix excludes them
  const withTransit = dayOf([poi('a'), { id: 't', kind: 'transit', mode: 'bus', title: '巴士' }, poi('b')]);
  assert.deepEqual(optimizeDay(withTransit, lineMatrix([0, 5])).order, ['a', 'b']);
});

test('unusable matrix entries are treated as very long, not as free', () => {
  const day = dayOf(['a', 'b', 'c'].map((id) => poi(id)));
  const m = [
    [0, NaN, 10],
    [NaN, 0, 10],
    [10, 10, 0],
  ];
  const r = optimizeDay(day, m);
  assert.ok(r.after < 9999);
});

test('estimate matrix: haversine, mode speeds and overhead', () => {
  const lucerne = { lat: 47.05, lng: 8.31 };
  const zurich = { lat: 47.3769, lng: 8.5417 };
  const km = haversineKm(lucerne, zurich);
  assert.ok(km > 35 && km < 45, `distance ${km}`);
  const walk = estimateMinutes(lucerne, zurich, 'walk');
  const transit = estimateMinutes(lucerne, zurich, 'transit');
  const drive = estimateMinutes(lucerne, zurich, 'drive');
  assert.ok(walk > transit && transit > drive);
  assert.equal(walk, Math.ceil((km / 4.5) * 60) + 5);
  assert.equal(estimateMinutes(lucerne, lucerne, 'walk'), 5);
  const mx = estimateMatrix([lucerne, zurich], 'transit');
  assert.equal(mx[0]![0], 0);
  assert.equal(mx[0]![1], mx[1]![0]);
});
