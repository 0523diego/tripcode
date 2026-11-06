import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AXIAL_TILT,
  DEG,
  DIST_REST,
  TAN_HALF_FOV,
  autoRotateStep,
  clampLat,
  dragToAngles,
  easeInOutCubic,
  facing,
  inertiaStep,
  latLngToVec3,
  mulMat3,
  mulMat3Vec3,
  ndcToPx,
  normalizeAngle,
  planetRadiusPx,
  project,
  shortestDelta,
  transposeMat3,
  tweenProgress,
  tweenValue,
  vec3ToLatLng,
  viewMatrix,
  viewSpan,
  visibility,
  type Mat3,
  type Vec3,
} from './globe-math.ts';

function near(actual: number, expected: number, eps = 1e-9, msg?: string) {
  assert.ok(Math.abs(actual - expected) <= eps, msg ?? `expected ${actual} ≈ ${expected}`);
}

function nearVec(actual: Vec3, expected: Vec3, eps = 1e-9) {
  for (let i = 0; i < 3; i++) near(actual[i]!, expected[i]!, eps, `component ${i}: ${actual} vs ${expected}`);
}

const SPAN = viewSpan(1000, 1000);

test('latLngToVec3: canonical points and unit length', () => {
  nearVec(latLngToVec3(0, 0), [0, 0, 1]);
  nearVec(latLngToVec3(90, 0), [0, 1, 0]);
  nearVec(latLngToVec3(0, 90), [1, 0, 0]);
  nearVec(latLngToVec3(0, -90), [-1, 0, 0]);
  nearVec(latLngToVec3(0, 180), [0, 0, -1], 1e-9);
  const v = latLngToVec3(46.8, 8.2);
  near(Math.hypot(v[0], v[1], v[2]), 1);
});

test('vec3ToLatLng round-trips', () => {
  for (const [lat, lng] of [
    [46.8, 8.2],
    [35.7, 139.7],
    [-33.9, 151.2],
    [60, -110],
  ] as const) {
    const back = vec3ToLatLng(latLngToVec3(lat, lng));
    near(back.lat, lat, 1e-9);
    near(back.lng, lng, 1e-9);
  }
});

test('viewMatrix is a rotation (orthonormal) and the centre point faces the viewer', () => {
  const m = viewMatrix(0.7, 0.3);
  const id = mulMat3(m, transposeMat3(m));
  const expected: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let i = 0; i < 9; i++) near(id[i]!, expected[i]!, 1e-12);
  // The point at the view centre lands on +z regardless of the roll.
  for (const roll of [0, -AXIAL_TILT, 1.1]) {
    const c = viewMatrix(0.7, 0.3, roll);
    nearVec(mulMat3Vec3(c, latLngToVec3(0.3 / DEG, 0.7 / DEG)), [0, 0, 1], 1e-12);
  }
});

test('viewMatrix: north pole leans right with the default axial tilt, and east is on the right', () => {
  const north = mulMat3Vec3(viewMatrix(0, 0), latLngToVec3(90, 0));
  assert.ok(north[0] > 0 && north[1] > 0, 'north pole is up and to the right');
  near(Math.atan2(north[0], north[1]), AXIAL_TILT, 1e-12);
  const east = mulMat3Vec3(viewMatrix(0, 0, 0), latLngToVec3(0, 30));
  assert.ok(east[0] > 0, 'places east of the centre are on the right');
  const up = mulMat3Vec3(viewMatrix(0, 0, 0), latLngToVec3(30, 0));
  assert.ok(up[1] > 0, 'places north of the centre are higher');
});

test('project: centre maps to the middle of the screen; east maps right, north maps up', () => {
  const rot = viewMatrix(10 * DEG, 20 * DEG, 0);
  const mid = project(latLngToVec3(20, 10), rot, DIST_REST, SPAN);
  near(mid.x, 0);
  near(mid.y, 0);
  assert.ok(mid.facing > 0.9);
  const east = project(latLngToVec3(20, 40), rot, DIST_REST, SPAN);
  assert.ok(east.x > 0 && east.visibility > 0);
  const north = project(latLngToVec3(50, 10), rot, DIST_REST, SPAN);
  assert.ok(north.y > 0);
  const [px, py] = ndcToPx(0, 0, 800, 600);
  assert.deepEqual([px, py], [400, 300]);
  const [tx, ty] = ndcToPx(-1, 1, 800, 600);
  assert.deepEqual([tx, ty], [0, 0]);
});

test('visibility: the far side is hidden, the near side is shown, the limb fades', () => {
  const rot = viewMatrix(0, 0, 0);
  const back = project(latLngToVec3(0, 180), rot, DIST_REST, SPAN);
  assert.equal(back.visibility, 0);
  assert.ok(back.facing < 0);
  const front = project(latLngToVec3(10, 5), rot, DIST_REST, SPAN);
  assert.equal(front.visibility, 1);
  // The silhouette of a sphere seen from distance d is at acos(1/d) from the centre.
  const limbAngle = Math.acos(1 / DIST_REST) / DEG;
  const justInside = project(latLngToVec3(0, limbAngle - 3), rot, DIST_REST, SPAN);
  const justOutside = project(latLngToVec3(0, limbAngle + 3), rot, DIST_REST, SPAN);
  assert.ok(justInside.facing > 0 && justOutside.facing < 0);
  near(facing([Math.sin(Math.acos(1 / DIST_REST)), 0, 1 / DIST_REST], DIST_REST), 0, 1e-12);
  assert.ok(visibility(0.1) > 0 && visibility(0.1) < 1);
  let prev = -1;
  for (let f = -0.2; f <= 0.5; f += 0.02) {
    const v = visibility(f);
    assert.ok(v >= prev);
    prev = v;
  }
});

test('planetRadiusPx matches the projected silhouette', () => {
  for (const dist of [1.5, 3, DIST_REST]) {
    const theta = Math.acos(1 / dist);
    const rot = viewMatrix(0, 0, 0);
    const limb = project([Math.sin(theta), 0, Math.cos(theta)], rot, dist, viewSpan(1000, 1000));
    near(limb.x * 500, planetRadiusPx(1000, 1000, dist), 1e-6);
  }
  // Fits at rest: radius is below half the shorter side, in a wide and in a tall container.
  assert.ok(planetRadiusPx(1600, 900, DIST_REST) < 450);
  assert.ok(planetRadiusPx(400, 900, DIST_REST) < 200);
  assert.ok(planetRadiusPx(1600, 900, DIST_REST) > 450 * 0.6);
});

test('viewSpan: shorter side spans the field of view', () => {
  assert.deepEqual(viewSpan(2000, 1000), [TAN_HALF_FOV * 2, TAN_HALF_FOV]);
  assert.deepEqual(viewSpan(500, 1000), [TAN_HALF_FOV, TAN_HALF_FOV * 2]);
  assert.deepEqual(viewSpan(0, 0), [TAN_HALF_FOV, TAN_HALF_FOV]);
});

test('normalizeAngle / shortestDelta take the short way round', () => {
  near(normalizeAngle(3 * Math.PI), Math.PI);
  near(normalizeAngle(-3 * Math.PI), Math.PI);
  near(normalizeAngle(0.25), 0.25);
  near(shortestDelta(350 * DEG, 10 * DEG), 20 * DEG, 1e-12);
  near(shortestDelta(10 * DEG, 350 * DEG), -20 * DEG, 1e-12);
  near(shortestDelta(-170 * DEG, 170 * DEG), -20 * DEG, 1e-12);
  near(shortestDelta(1, 1), 0);
});

test('easing and tween helpers', () => {
  near(easeInOutCubic(0), 0);
  near(easeInOutCubic(1), 1);
  near(easeInOutCubic(0.5), 0.5);
  assert.ok(easeInOutCubic(0.25) < 0.25 && easeInOutCubic(0.75) > 0.75);
  near(easeInOutCubic(-3), 0);
  near(easeInOutCubic(4), 1);
  assert.equal(tweenProgress(600, 1200), 0.5);
  assert.equal(tweenProgress(5000, 1200), 1);
  assert.equal(tweenProgress(0, 0), 1);
  near(tweenValue(10, 20, 0), 10);
  near(tweenValue(10, 20, 1), 30);
  // A wrapped tween from 350° towards 10° ends exactly on the target.
  const from = 350 * DEG;
  const delta = shortestDelta(from, 10 * DEG);
  near(normalizeAngle(tweenValue(from, delta, 1)), 10 * DEG, 1e-12);
});

test('inertiaStep decays monotonically and eventually stops', () => {
  let v = 2;
  let travelled = 0;
  let steps = 0;
  while (v !== 0 && steps < 10_000) {
    const prev = v;
    const r = inertiaStep(v, 1 / 60);
    assert.ok(r.delta > 0);
    assert.ok(r.velocity < prev);
    v = r.velocity;
    travelled += r.delta;
    steps++;
  }
  assert.equal(v, 0);
  assert.ok(steps < 600, 'stops within ten seconds');
  // Total distance is close to v0 / rate (the integral of the exponential), a bit less because of the cut-off.
  assert.ok(travelled < 2 / 3 && travelled > 2 / 3 - 0.01);
  // Same distance whatever the frame rate.
  const a = inertiaStep(2, 1 / 30);
  const b1 = inertiaStep(2, 1 / 60);
  const b2 = inertiaStep(b1.velocity, 1 / 60);
  near(a.delta, b1.delta + b2.delta, 1e-12);
  near(a.velocity, b2.velocity, 1e-12);
  // Negative velocities mirror.
  assert.equal(inertiaStep(-2, 0.1).delta, -inertiaStep(2, 0.1).delta);
  assert.deepEqual(inertiaStep(0, 0.1), { delta: 0, velocity: 0 });
});

test('autoRotateStep: one turn per 90 s, eastward (centre longitude decreases)', () => {
  let lng = 0.3;
  for (let i = 0; i < 90 * 60; i++) lng = autoRotateStep(lng, 1 / 60);
  near(normalizeAngle(lng - 0.3), 0, 1e-9);
  assert.ok(autoRotateStep(0, 1) < 0);
  near(autoRotateStep(0, 90 / 4), -Math.PI / 2, 1e-12);
  // The wrap stays inside (-PI, PI].
  const wrapped = autoRotateStep(-Math.PI + 0.001, 1);
  assert.ok(wrapped > 0 && wrapped <= Math.PI);
});

test('dragToAngles: dragging right brings the west into view, dragging down brings the north into view', () => {
  const right = dragToAngles(100, 0, 0, 200);
  near(right.dLng, -0.5);
  near(right.dLat, 0);
  const down = dragToAngles(0, 100, 0, 200);
  near(down.dLat, 0.5);
  near(down.dLng, 0);
  // With a tilt, a drag along the tilted equator is still a pure spin about the axis.
  const roll = -AXIAL_TILT;
  const along = dragToAngles(100 * Math.cos(roll), -100 * Math.sin(roll), roll, 200);
  near(along.dLat, 0, 1e-12);
  near(along.dLng, -0.5, 1e-12);
  // The bigger the planet on screen, the smaller the angle per pixel.
  assert.ok(Math.abs(dragToAngles(50, 0, 0, 400).dLng) < Math.abs(dragToAngles(50, 0, 0, 200).dLng));
});

test('clampLat keeps the tilt within bounds', () => {
  near(clampLat(2), 80 * DEG);
  near(clampLat(-2), -80 * DEG);
  near(clampLat(0.4), 0.4);
  near(clampLat(1, 0.5), 0.5);
});

test('a focus turn: after easing to a target, the target faces the viewer at the middle of the screen', () => {
  const target = { lat: 46.8, lng: 8.2 };
  let lng = -120 * DEG;
  const delta = shortestDelta(lng, target.lng * DEG);
  lng = tweenValue(lng, delta, 1);
  const lat = target.lat * DEG;
  const p = project(latLngToVec3(target.lat, target.lng), viewMatrix(lng, lat), DIST_REST, SPAN);
  near(p.x, 0, 1e-12);
  near(p.y, 0, 1e-12);
  assert.equal(p.visibility, 1);
  // And on the way (halfway round) it travelled the short way: Switzerland is 128° east of -120°.
  assert.ok(delta > 0 && delta < Math.PI);
});
