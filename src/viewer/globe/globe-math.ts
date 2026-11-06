// Pure maths for the globe: no DOM, no WebGL, so it can be unit tested with node:test.
//
// Conventions
//   World space: unit sphere, +y = north pole, lat/lng (0, 0) = (0, 0, 1), lng grows eastward:
//     v = (cos(lat) sin(lng), sin(lat), cos(lat) cos(lng))
//   View space: camera on +z looking down -z at the origin, +x right, +y up. A world point p becomes M * p, where
//     M = Rz(roll) * Rx(centerLat) * Ry(-centerLng)
//   so the point (centerLat, centerLng) lands on (0, 0, 1) (the middle of the disc), and `roll` is the axial tilt
//   seen by the viewer. Matrices are column-major (the layout WebGL's uniformMatrix3fv wants).

export type Vec3 = readonly [number, number, number];
export type Mat3 = readonly [number, number, number, number, number, number, number, number, number];

export const DEG = Math.PI / 180;
/** Earth's axial tilt, used as the viewer's roll (negative = north pole leans to the right). */
export const AXIAL_TILT = 23.4 * DEG;
/** Largest |latitude| the view centre may reach. */
export const MAX_CENTER_LAT = 80 * DEG;
/** Vertical half field of view as a tangent (applied to the shorter side of the view). */
export const TAN_HALF_FOV = 0.278;
/** Camera distance (planet radius = 1) at rest: the whole planet fits with a comfortable margin. */
export const DIST_REST = 4.5;
/** Camera distance after zooming in: the planet overflows the view. */
export const DIST_ZOOMED = 1.16;

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// --- vectors and matrices ---------------------------------------------------------------------------------------

export function latLngToVec3(latDeg: number, lngDeg: number): Vec3 {
  const lat = latDeg * DEG;
  const lng = lngDeg * DEG;
  const c = Math.cos(lat);
  return [c * Math.sin(lng), Math.sin(lat), c * Math.cos(lng)];
}

/** Inverse of latLngToVec3, in degrees. lng is in (-180, 180]. */
export function vec3ToLatLng(v: Vec3): { lat: number; lng: number } {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return { lat: Math.asin(clamp(v[1] / len, -1, 1)) / DEG, lng: Math.atan2(v[0], v[2]) / DEG };
}

export function rotX(a: number): Mat3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [1, 0, 0, 0, c, s, 0, -s, c];
}

export function rotY(a: number): Mat3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, 0, -s, 0, 1, 0, s, 0, c];
}

export function rotZ(a: number): Mat3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, s, 0, -s, c, 0, 0, 0, 1];
}

/** a * b (apply b first). */
export function mulMat3(a: Mat3, b: Mat3): Mat3 {
  const out: number[] = [];
  for (let col = 0; col < 3; col++) {
    for (let row = 0; row < 3; row++) {
      out.push(a[row]! * b[col * 3]! + a[3 + row]! * b[col * 3 + 1]! + a[6 + row]! * b[col * 3 + 2]!);
    }
  }
  return out as unknown as Mat3;
}

export function transposeMat3(m: Mat3): Mat3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

export function mulMat3Vec3(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
    m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
    m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
  ];
}

/** World -> view rotation that puts (centerLat, centerLng) in the middle of the disc, then rolls the picture. */
export function viewMatrix(centerLng: number, centerLat: number, roll: number = -AXIAL_TILT): Mat3 {
  return mulMat3(rotZ(roll), mulMat3(rotX(centerLat), rotY(-centerLng)));
}

export function clampLat(lat: number, max: number = MAX_CENTER_LAT): number {
  return clamp(lat, -max, max);
}

// --- projection -------------------------------------------------------------------------------------------------

/**
 * Half extents of the view plane at distance 1, in tangent units: the shorter side of the container spans
 * ±TAN_HALF_FOV, the longer one more. The fragment shader builds its rays from the same numbers.
 */
export function viewSpan(width: number, height: number, tanHalf: number = TAN_HALF_FOV): [number, number] {
  const aspect = width > 0 && height > 0 ? width / height : 1;
  return aspect >= 1 ? [tanHalf * aspect, tanHalf] : [tanHalf, tanHalf / aspect];
}

/** Pixel radius of the planet's silhouette seen from camera distance `dist`. */
export function planetRadiusPx(width: number, height: number, dist: number, tanHalf: number = TAN_HALF_FOV): number {
  const tanAngular = 1 / Math.sqrt(Math.max(dist * dist - 1, 1e-6));
  return (tanAngular / tanHalf) * (Math.min(width, height) / 2);
}

/**
 * How much a view-space point on the unit sphere faces the camera at (0, 0, dist): the cosine of the angle between
 * its normal and the direction to the camera. >0 means the point is on the visible side (it is a bit less than a
 * hemisphere, since the camera is not at infinity), 0 is exactly the silhouette.
 */
export function facing(p: Vec3, dist: number): number {
  const toCam = Math.sqrt(dist * dist - 2 * dist * p[2] + 1);
  return (dist * p[2] - 1) / toCam;
}

/** 0 on the far side, 1 clearly in front, smooth in between (pins fade near the limb). */
export function visibility(f: number): number {
  return smoothstep(0.02, 0.24, f);
}

export interface Projected {
  /** Normalised device coordinates, x right, y up, both in [-1, 1] when inside the view. */
  x: number;
  y: number;
  /** View-space depth (1 = nearest the camera). */
  z: number;
  facing: number;
  visibility: number;
}

/** Projects a world-space unit vector to the screen with the same camera as the shader. */
export function project(world: Vec3, rot: Mat3, dist: number, span: readonly [number, number]): Projected {
  const p = mulMat3Vec3(rot, world);
  const depth = Math.max(dist - p[2], 1e-6);
  const f = facing(p, dist);
  return { x: p[0] / depth / span[0], y: p[1] / depth / span[1], z: p[2], facing: f, visibility: visibility(f) };
}

export function ndcToPx(x: number, y: number, width: number, height: number): [number, number] {
  return [(x * 0.5 + 0.5) * width, (0.5 - y * 0.5) * height];
}

// --- angles, easing, motion -------------------------------------------------------------------------------------

/** Wraps an angle to (-PI, PI]. */
export function normalizeAngle(a: number): number {
  const twoPi = Math.PI * 2;
  let r = a % twoPi;
  if (r > Math.PI) r -= twoPi;
  else if (r <= -Math.PI) r += twoPi;
  return r;
}

/** Signed shortest rotation from `from` to `to`, in (-PI, PI]. */
export function shortestDelta(from: number, to: number): number {
  return normalizeAngle(to - from);
}

export function easeInOutCubic(t: number): number {
  const x = clamp(t, 0, 1);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/** Progress in [0, 1] of a tween that started `elapsedMs` ago and lasts `durationMs` (instant when duration <= 0). */
export function tweenProgress(elapsedMs: number, durationMs: number): number {
  return durationMs <= 0 ? 1 : clamp(elapsedMs / durationMs, 0, 1);
}

/** Eased value of `from + delta` at progress t. */
export function tweenValue(from: number, delta: number, t: number): number {
  return from + delta * easeInOutCubic(t);
}

/**
 * One step of exponential inertia: velocity decays as exp(-rate * t). Returns the distance travelled during `dt`
 * seconds and the new velocity (snapped to 0 below `stopBelow`).
 */
export function inertiaStep(
  velocity: number,
  dt: number,
  rate: number = 3,
  stopBelow: number = 0.01,
): { delta: number; velocity: number } {
  if (velocity === 0 || dt <= 0) return { delta: 0, velocity };
  const decay = Math.exp(-rate * dt);
  const delta = (velocity * (1 - decay)) / rate;
  const next = velocity * decay;
  return { delta, velocity: Math.abs(next) < stopBelow ? 0 : next };
}

/** Auto-rotation: one turn per `periodSeconds`. The planet turns eastward, so the centre longitude decreases. */
export function autoRotateStep(centerLng: number, dt: number, periodSeconds: number = 90): number {
  return normalizeAngle(centerLng - (Math.PI * 2 * dt) / periodSeconds);
}

/**
 * Converts a pointer drag (CSS pixels, y down) into changes of the centre longitude and latitude. The drag vector is
 * un-rolled first so that dragging along the tilted equator spins the planet about its own axis.
 */
export function dragToAngles(dx: number, dy: number, roll: number, radiusPx: number): { dLng: number; dLat: number } {
  const r = Math.max(radiusPx, 1);
  const ux = dx;
  const uy = -dy; // y up
  const c = Math.cos(-roll);
  const s = Math.sin(-roll);
  const rx = ux * c - uy * s;
  const ry = ux * s + uy * c;
  return { dLng: -rx / r, dLat: -ry / r };
}
