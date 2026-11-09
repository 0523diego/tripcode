import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clusterByDistance, MAX_TILES, minimalPan, visibleTiles } from './tiles.ts';

test('visibleTiles never leaves the map empty: a big window at any zoom still gets tiles, within the request budget', () => {
  // A 2560×1440 window sweeping through every zoom between two tile levels (scale = px per world unit). The sharpest level
  // would need more than MAX_TILES tiles just before the level switches; it used to return nothing, i.e. a black basemap.
  let steps = 0;
  for (let k = 1; k <= 2; k += 0.02) {
    const scale = 256 * 2 ** 12 * k;
    const tiles = visibleTiles(scale, -scale * 0.54 + 1280, -scale * 0.37 + 720, 2560, 1440, 19);
    assert.ok(tiles.length > 0, `no tiles at k=${k.toFixed(2)}`);
    assert.ok(tiles.length <= MAX_TILES, `${tiles.length} tiles at k=${k.toFixed(2)}`);
    steps++;
  }
  assert.ok(steps > 40);
});

test('visibleTiles steps down to a coarser level, with larger tiles, instead of dropping the basemap', () => {
  const scale = 256 * 2 ** 12 * 1.42; // rounds up to level 13, whose tiles are ~177 px: far too many for 2560×1440
  const ox = -scale * 0.5 + 1280;
  const oy = -scale * 0.3 + 720;
  const tiles = visibleTiles(scale, ox, oy, 2560, 1440, 19);
  assert.ok(tiles.length > 0);
  assert.ok(tiles.every((t) => t.z <= 12), 'coarser than the sharpest level');
  assert.ok(tiles.every((t) => t.size > 250), 'tiles are drawn larger when a coarser level is used');
  // together they still cover the whole window
  const left = Math.min(...tiles.map((t) => t.sx));
  const right = Math.max(...tiles.map((t) => t.sx + t.size));
  const top = Math.min(...tiles.map((t) => t.sy));
  const bottom = Math.max(...tiles.map((t) => t.sy + t.size));
  assert.ok(left <= 0 && right >= 2560 && top <= 0 && bottom >= 1440);
});

test('visibleTiles on an ordinary window keeps the sharp level', () => {
  const scale = 256 * 2 ** 12 * 1.42;
  const tiles = visibleTiles(scale, -scale * 0.5 + 500, -scale * 0.3 + 300, 1000, 600, 19);
  assert.ok(tiles.length > 0 && tiles.every((t) => t.z === 13));
});

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
