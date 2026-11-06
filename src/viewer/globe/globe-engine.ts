// The imperative half of the globe: owns the WebGL2 context, the camera state, pointer interaction, tweens and the
// per-frame pin projection. Globe.tsx only creates it, forwards props and renders the (static) markup. Nothing here
// triggers a React render; pins are moved by writing to their elements' styles from the rAF loop.

import {
  AXIAL_TILT,
  DIST_REST,
  DIST_ZOOMED,
  TAN_HALF_FOV,
  autoRotateStep,
  clampLat,
  dragToAngles,
  inertiaStep,
  latLngToVec3,
  ndcToPx,
  normalizeAngle,
  planetRadiusPx,
  project,
  shortestDelta,
  tweenProgress,
  tweenValue,
  viewMatrix,
  viewSpan,
  DEG,
  type Vec3,
} from './globe-math.ts';
import { FRAG, VERT } from './shaders.ts';

export interface EnginePin {
  id: string;
  lat: number;
  lng: number;
  el: HTMLElement;
}

export interface EngineOptions {
  canvas: HTMLCanvasElement;
  root: HTMLElement;
  dayUrl: string;
  nightUrl: string;
  /** Called every frame; must be cheap (it returns the current pins with their elements). */
  getPins: () => readonly EnginePin[];
  onZoomDone: () => void;
  /** WebGL2 missing, shader failure or textures failed to load: show the still fallback. */
  onUnsupported: () => void;
}

export interface Engine {
  setFocus(focus: { lat: number; lng: number } | null): void;
  setZoom(zoomIn: boolean): void;
  /** Ask for (at least) one more frame, e.g. after the pins changed. */
  invalidate(): void;
  dispose(): void;
}

const MOVE_MS = 1200;
const REST_LAT = 16 * DEG;
const RESUME_AFTER_MS = 3500;
const MAX_PIXELS = 3_600_000;
/** Direction towards the sun in view space: upper left, in front. */
const SUN: Vec3 = (() => {
  const v: Vec3 = [-0.66, 0.40, 0.64];
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
})();

const imageCache = new Map<string, Promise<HTMLImageElement>>();

function loadImage(url: string): Promise<HTMLImageElement> {
  let p = imageCache.get(url);
  if (!p) {
    p = new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => resolve(img);
      img.onerror = () => {
        imageCache.delete(url);
        reject(new Error(`globe: could not load ${url}`));
      };
      img.src = url;
    });
    imageCache.set(url, p);
  }
  return p;
}

interface GlState {
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
  textures: WebGLTexture[];
  uniforms: Record<string, WebGLUniformLocation | null>;
  texturesReady: boolean;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error('globe: createShader failed');
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`globe: shader compile failed: ${log}`);
  }
  return sh;
}

function buildProgram(gl: WebGL2RenderingContext): GlState {
  const vs = compile(gl, gl.VERTEX_SHADER, VERT);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
  const program = gl.createProgram();
  if (!program) throw new Error('globe: createProgram failed');
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`globe: program link failed: ${log}`);
  }
  const vao = gl.createVertexArray();
  if (!vao) throw new Error('globe: createVertexArray failed');
  const names = ['uRot', 'uSpan', 'uCamDist', 'uSun', 'uDay', 'uNight', 'uRes', 'uDpr', 'uReveal'];
  const uniforms: Record<string, WebGLUniformLocation | null> = {};
  for (const n of names) uniforms[n] = gl.getUniformLocation(program, n);
  return { gl, program, vao, textures: [], uniforms, texturesReady: false };
}

function uploadTexture(gl: WebGL2RenderingContext, img: HTMLImageElement, unit: number): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error('globe: createTexture failed');
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  // SRGB8_ALPHA8 so the hardware linearises before filtering (and generateMipmap is allowed on it).
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const ext =
    gl.getExtension('EXT_texture_filter_anisotropic') ??
    gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic') ??
    gl.getExtension('MOZ_EXT_texture_filter_anisotropic');
  if (ext) {
    const max = gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number;
    gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, max));
  }
  return tex;
}

interface Tween {
  start: number;
  duration: number;
  fromLng: number;
  dLng: number;
  fromLat: number;
  dLat: number;
}

interface ZoomTween {
  start: number;
  duration: number;
  from: number;
  delta: number;
  notify: boolean;
}

export function createGlobeEngine(opts: EngineOptions): Engine {
  const { canvas, root } = opts;
  const gl = canvas.getContext('webgl2', {
    antialias: false,
    alpha: false,
    depth: false,
    stencil: false,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: false,
  });
  if (!gl) {
    opts.onUnsupported();
    return { setFocus() {}, setZoom() {}, invalidate() {}, dispose() {} };
  }

  const reducedQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  let reduced = reducedQuery.matches;

  // --- camera / interaction state ---
  let lng = 20 * DEG; // centre longitude
  let lat = REST_LAT; // centre latitude
  const roll = -AXIAL_TILT;
  let dist = DIST_REST;
  let vLng = 0;
  let vLat = 0;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let lastMoveT = 0;
  let lastInteraction = -Infinity;
  let auto = 0; // 0..1 smoothed auto-rotation factor
  let focus: { lat: number; lng: number } | null = null;
  let tween: Tween | null = null;
  let zoomTween: ZoomTween | null = null;
  let zoomWanted = false;
  let reveal = 0;

  // --- size ---
  let cssW = 1;
  let cssH = 1;
  let dpr = 1;

  // --- lifecycle ---
  let state: GlState | null = null;
  let disposed = false;
  let contextLost = false;
  let rafId = 0;
  let lastFrame = 0;
  let visible = true; // IntersectionObserver
  let pageVisible = document.visibilityState !== 'hidden';
  let dirty = true;
  let images: [HTMLImageElement, HTMLImageElement] | null = null;
  const lastPinWrite = new WeakMap<HTMLElement, string>();

  function fail(err: unknown) {
    console.warn(err);
    if (disposed) return;
    teardownGl();
    opts.onUnsupported();
  }

  function setupGl() {
    state = buildProgram(gl!);
    if (images) uploadAll();
  }

  function uploadAll() {
    if (!state || !images) return;
    const g = state.gl;
    state.textures = [uploadTexture(g, images[0], 0), uploadTexture(g, images[1], 1)];
    state.texturesReady = true;
    dirty = true;
    wake();
  }

  function teardownGl() {
    cancelAnimationFrame(rafId);
    rafId = 0;
    if (state && !contextLost) {
      const g = state.gl;
      for (const t of state.textures) g.deleteTexture(t);
      g.deleteVertexArray(state.vao);
      g.deleteProgram(state.program);
    }
    state = null;
  }

  try {
    setupGl();
  } catch (err) {
    fail(err);
    return { setFocus() {}, setZoom() {}, invalidate() {}, dispose() {} };
  }

  Promise.all([loadImage(opts.dayUrl), loadImage(opts.nightUrl)]).then(
    (imgs) => {
      if (disposed) return;
      images = [imgs[0], imgs[1]];
      if (!contextLost && state) {
        try {
          uploadAll();
        } catch (err) {
          fail(err);
        }
      }
      reveal = reduced ? 1 : 0;
    },
    (err) => fail(err),
  );

  // --- sizing ---
  function resize() {
    const rect = root.getBoundingClientRect();
    cssW = Math.max(rect.width, 1);
    cssH = Math.max(rect.height, 1);
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const px = cssW * cssH * dpr * dpr;
    if (px > MAX_PIXELS) dpr *= Math.sqrt(MAX_PIXELS / px);
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    dirty = true;
    wake();
  }
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(root);
  resize();

  // --- visibility ---
  const intersection = new IntersectionObserver((entries) => {
    for (const e of entries) visible = e.isIntersecting;
    if (visible) {
      lastFrame = 0;
      dirty = true;
      wake();
    }
  });
  intersection.observe(root);
  const onVisibility = () => {
    pageVisible = document.visibilityState !== 'hidden';
    if (pageVisible) {
      lastFrame = 0;
      dirty = true;
      wake();
    }
  };
  document.addEventListener('visibilitychange', onVisibility);

  const onReducedChange = () => {
    reduced = reducedQuery.matches;
    if (reduced) {
      vLng = vLat = 0;
      auto = 0;
      tween = null;
      zoomTween = null;
    }
    dirty = true;
    wake();
  };
  reducedQuery.addEventListener('change', onReducedChange);

  // --- context loss ---
  const onLost = (e: Event) => {
    e.preventDefault();
    contextLost = true;
    cancelAnimationFrame(rafId);
    rafId = 0;
  };
  const onRestored = () => {
    contextLost = false;
    try {
      state = null;
      setupGl();
    } catch (err) {
      fail(err);
      return;
    }
    dirty = true;
    wake();
  };
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);

  // --- pointer interaction ---
  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if ((e.target as Element | null)?.closest('.globe-pin')) return;
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    lastMoveT = e.timeStamp;
    vLng = vLat = 0;
    tween = null;
    auto = 0;
    lastInteraction = performance.now();
    try {
      root.setPointerCapture(e.pointerId);
    } catch {
      /* the pointer may already be gone */
    }
    root.classList.add('is-dragging');
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    const dt = Math.max((e.timeStamp - lastMoveT) / 1000, 1 / 240);
    lastMoveT = e.timeStamp;
    const { dLng, dLat } = dragToAngles(dx, dy, roll, planetRadiusPx(cssW, cssH, dist));
    lng = normalizeAngle(lng + dLng);
    const nextLat = clampLat(lat + dLat);
    const hitLimit = nextLat !== lat + dLat;
    lat = nextLat;
    // Light smoothing so a flick keeps its direction even with jittery samples.
    vLng = vLng * 0.4 + (dLng / dt) * 0.6;
    vLat = hitLimit ? 0 : vLat * 0.4 + (dLat / dt) * 0.6;
    lastInteraction = performance.now();
    dirty = true;
    wake();
  };
  const onPointerUp = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    root.classList.remove('is-dragging');
    try {
      root.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    // A finger that rested before lifting does not fling.
    if (e.timeStamp - lastMoveT > 90 || reduced) vLng = vLat = 0;
    lastInteraction = performance.now();
    wake();
  };
  root.addEventListener('pointerdown', onPointerDown);
  root.addEventListener('pointermove', onPointerMove);
  root.addEventListener('pointerup', onPointerUp);
  root.addEventListener('pointercancel', onPointerUp);

  // --- public controls ---
  function setFocus(next: { lat: number; lng: number } | null) {
    focus = next;
    if (!next) {
      tween = null;
      lastInteraction = performance.now() - RESUME_AFTER_MS + 600; // resume turning almost straight away
      wake();
      return;
    }
    auto = 0;
    vLng = vLat = 0;
    const toLng = normalizeAngle(next.lng * DEG);
    const toLat = clampLat(next.lat * DEG, 72 * DEG);
    if (reduced) {
      lng = toLng;
      lat = toLat;
      tween = null;
    } else {
      tween = {
        start: performance.now(),
        duration: MOVE_MS,
        fromLng: lng,
        dLng: shortestDelta(lng, toLng),
        fromLat: lat,
        dLat: toLat - lat,
      };
    }
    dirty = true;
    wake();
  }

  function setZoom(zoomIn: boolean) {
    if (zoomIn === zoomWanted) return;
    zoomWanted = zoomIn;
    const target = zoomIn ? DIST_ZOOMED : DIST_REST;
    if (reduced) {
      dist = target;
      zoomTween = null;
      dirty = true;
      wake();
      if (zoomIn) queueMicrotask(() => !disposed && opts.onZoomDone());
      return;
    }
    zoomTween = { start: performance.now(), duration: MOVE_MS, from: dist, delta: target - dist, notify: zoomIn };
    wake();
  }

  // --- frame ---
  function wake() {
    if (rafId || disposed || contextLost || !visible || !pageVisible) return;
    rafId = requestAnimationFrame(frame);
  }

  function step(now: number, dt: number): boolean {
    let moving = false;

    if (tween && !dragging) {
      const p = tweenProgress(now - tween.start, tween.duration);
      lng = normalizeAngle(tweenValue(tween.fromLng, tween.dLng, p));
      lat = tweenValue(tween.fromLat, tween.dLat, p);
      if (p >= 1) tween = null;
      moving = true;
    }

    if (zoomTween) {
      const p = tweenProgress(now - zoomTween.start, zoomTween.duration);
      dist = tweenValue(zoomTween.from, zoomTween.delta, p);
      moving = true;
      if (p >= 1) {
        const notify = zoomTween.notify;
        zoomTween = null;
        if (notify) queueMicrotask(() => !disposed && opts.onZoomDone());
      }
    }

    if (!dragging && !tween && (vLng !== 0 || vLat !== 0)) {
      const a = inertiaStep(vLng, dt);
      const b = inertiaStep(vLat, dt);
      lng = normalizeAngle(lng + a.delta);
      const nextLat = clampLat(lat + b.delta);
      if (nextLat !== lat + b.delta) vLat = 0;
      else vLat = b.velocity;
      lat = nextLat;
      vLng = a.velocity;
      moving = true;
    }

    if (!reduced && !focus && !dragging && !tween && !zoomWanted) {
      const idle = now - lastInteraction > RESUME_AFTER_MS;
      auto += ((idle ? 1 : 0) - auto) * (1 - Math.exp(-dt * 1.4));
      if (auto > 0.001) {
        lng = autoRotateStep(lng, dt * auto);
        lat += (REST_LAT - lat) * (1 - Math.exp(-dt * 0.5)) * auto;
        moving = true;
      }
      moving = true; // waiting to resume still needs ticks
    }

    if (reveal < 1 && state?.texturesReady) {
      reveal = reduced ? 1 : Math.min(1, reveal + dt / 1.1);
      moving = true;
    }
    return moving;
  }

  function frame(now: number) {
    rafId = 0;
    if (disposed || contextLost || !state || !visible || !pageVisible) return;
    const dt = lastFrame ? Math.min((now - lastFrame) / 1000, 0.05) : 1 / 60;
    lastFrame = now;
    const perfNow = performance.now();
    const moving = step(perfNow, dt);
    if (moving || dirty) {
      draw(state);
      placePins();
      dirty = false;
    }
    if (moving) wake();
    else lastFrame = 0;
  }

  function draw(s: GlState) {
    const g = s.gl;
    g.viewport(0, 0, canvas.width, canvas.height);
    g.useProgram(s.program);
    g.bindVertexArray(s.vao);
    const rot = viewMatrix(lng, lat, roll);
    const span = viewSpan(cssW, cssH, TAN_HALF_FOV);
    const u = s.uniforms;
    g.uniformMatrix3fv(u.uRot!, false, rot as unknown as number[]);
    g.uniform2f(u.uSpan!, span[0], span[1]);
    g.uniform1f(u.uCamDist!, dist);
    g.uniform3f(u.uSun!, SUN[0], SUN[1], SUN[2]);
    g.uniform2f(u.uRes!, canvas.width, canvas.height);
    g.uniform1f(u.uDpr!, dpr);
    g.uniform1f(u.uReveal!, reveal);
    if (s.texturesReady) {
      g.activeTexture(g.TEXTURE0);
      g.bindTexture(g.TEXTURE_2D, s.textures[0]!);
      g.activeTexture(g.TEXTURE1);
      g.bindTexture(g.TEXTURE_2D, s.textures[1]!);
      g.uniform1i(u.uDay!, 0);
      g.uniform1i(u.uNight!, 1);
    }
    g.drawArrays(g.TRIANGLES, 0, 3);
  }

  function placePins() {
    const pins = opts.getPins();
    if (pins.length === 0) return;
    const rot = viewMatrix(lng, lat, roll);
    const span = viewSpan(cssW, cssH, TAN_HALF_FOV);
    for (const pin of pins) {
      const pr = project(latLngToVec3(pin.lat, pin.lng), rot, dist, span);
      const [x, y] = ndcToPx(pr.x, pr.y, cssW, cssH);
      const vis = reveal * pr.visibility;
      const hidden = vis < 0.01;
      const flip = x > cssW - 190 ? '1' : '0';
      const sig = hidden
        ? 'h'
        : `${x.toFixed(1)}|${y.toFixed(1)}|${vis.toFixed(3)}|${Math.round(pr.z * 100)}|${flip}`;
      if (lastPinWrite.get(pin.el) === sig) continue;
      lastPinWrite.set(pin.el, sig);
      if (hidden) {
        pin.el.style.visibility = 'hidden';
        continue;
      }
      pin.el.style.visibility = 'visible';
      pin.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
      pin.el.style.setProperty('--v', vis.toFixed(3));
      pin.el.style.zIndex = String(Math.round(pr.z * 100) + 100);
      if (pin.el.dataset.flip !== flip) pin.el.dataset.flip = flip;
    }
  }

  wake();

  return {
    setFocus,
    setZoom,
    invalidate() {
      dirty = true;
      wake();
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(rafId);
      rafId = 0;
      resizeObserver.disconnect();
      intersection.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      reducedQuery.removeEventListener('change', onReducedChange);
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      root.removeEventListener('pointerdown', onPointerDown);
      root.removeEventListener('pointermove', onPointerMove);
      root.removeEventListener('pointerup', onPointerUp);
      root.removeEventListener('pointercancel', onPointerUp);
      root.classList.remove('is-dragging');
      // Resources are deleted explicitly. The context itself is not force-lost: React StrictMode (and a remount on
      // the same canvas) would get the same, dead context back from getContext().
      teardownGl();
    },
  };
}
