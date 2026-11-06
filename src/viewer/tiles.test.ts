import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clusterByDistance, minimalPan } from './tiles.ts';

test('clusterByDistance groups points closer than the radius around a leader', () => {
  const pts = [
    { id: 'a', x: 0, y: 0 },
    { id: 'b', x: 30, y: 0 },
    { id: 'c', x: 100, y: 0 },
    { id: 'd', x: 110, y: 20 },
    { id: 'e', x: 400, y: 400 },
  ];
  const groups = clusterByDistance(pts, 56).map((g) => g.map((p) => p.id));
  assert.deepEqual(groups, [['a', 'b'], ['c', 'd'], ['e']]);
});

test('clusterByDistance does not chain points through a middle one', () => {
  const pts = [0, 40, 80, 120].map((x) => ({ x, y: 0 }));
  const groups = clusterByDistance(pts, 56);
  assert.equal(groups.length, 2);
  assert.equal(groups[0]!.length, 2);
});

test('clusterByDistance keeps coincident points together and an empty list empty', () => {
  assert.equal(clusterByDistance([{ x: 5, y: 5 }, { x: 5, y: 5 }], 56).length, 1);
  assert.deepEqual(clusterByDistance([], 56), []);
});

test('minimalPan leaves a comfortable point alone and nudges only as far as needed', () => {
  const box = { l: 100, r: 900, t: 0, b: 600 };
  assert.deepEqual(minimalPan(500, 300, box, 56), { dx: 0, dy: 0 });
  assert.deepEqual(minimalPan(120, 300, box, 56), { dx: 36, dy: 0 });
  assert.deepEqual(minimalPan(500, 590, box, 56), { dx: 0, dy: -46 });
  assert.deepEqual(minimalPan(950, -10, box, 56), { dx: -106, dy: 66 });
});
