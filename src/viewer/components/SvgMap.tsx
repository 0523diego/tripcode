// Interactive map: Web Mercator fitted to the pins' bounds over (optional) dimmed tiles. Wheel zoom + drag pan on
// desktop; on touch/narrow screens one finger scrolls the page and two fingers move the map.
import { useEffect, useMemo, useRef, useState } from 'react';
import { onVar, type MapPin, type MapRoute } from '../model.ts';
import type { MapInset } from './MapPanel.tsx';
import { TILES, clusterByDistance, minimalPan, tileUrl, toWorld, visibleTiles } from '../tiles.ts';

interface Props {
  pins: MapPin[];
  routes: MapRoute[];
  selectedKey: string | null;
  onSelect: (pin: MapPin) => void;
  inset?: MapInset;
}

interface View {
  k: number;
  tx: number;
  ty: number;
}
const HOME: View = { k: 1, tx: 0, ty: 0 };
const PAD = 56;
/** Pins closer than this on screen share a cluster pin (a single day only merges pins that would actually overlap, so its numbered stops stay readable). */
const CLUSTER_ALL_PX = 56;
const CLUSTER_DAY_PX = 26;
/** Pins closer than this are fanned out instead (only matters once clustering is off at street level). */
const SPREAD_PX = 24;
/** Above this scale (world px per unit, about zoom 16) clustering is off and the fan-out takes over. */
const STREET_SCALE = 256 * 2 ** 16;
const MAX_LABELS = 12;
const LOCKED_QUERY = '(max-width: 900px), (pointer: coarse)';

/** True on phones/tablets/narrow windows: the page must stay scrollable, so the map ignores one-finger and wheel input. */
function useGestureLock(): boolean {
  const [locked, setLocked] = useState(() => typeof window !== 'undefined' && window.matchMedia(LOCKED_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(LOCKED_QUERY);
    const read = () => setLocked(mq.matches);
    read();
    mq.addEventListener('change', read);
    return () => mq.removeEventListener('change', read);
  }, []);
  return locked;
}

function useSize(ref: React.RefObject<HTMLDivElement | null>) {
  const [size, setSize] = useState({ w: 640, h: 420 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setSize({ w: Math.max(200, el.clientWidth), h: Math.max(160, el.clientHeight) });
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

interface Placed {
  pin: MapPin;
  /** true projected position */
  x: number;
  y: number;
  /** drawn position (after fanning out) */
  px: number;
  py: number;
  spread: boolean;
}

/** Several pins drawn as one numbered pin; clicking it zooms to the group. */
interface Cluster {
  id: string;
  pins: MapPin[];
  x: number;
  y: number;
  /** Shared day color, or null when the group spans days (drawn neutral). */
  color: string | null;
}

const place = (pts: { pin: MapPin; x: number; y: number }[]): Placed[] =>
  pts.map((p) => ({ ...p, px: p.x, py: p.y, spread: false }));

/** Fan a group of overlapping pins out onto a small circle around their centroid (leader lines show where they are). */
function fanGroup(g: Placed[]): Placed[] {
  if (g.length < 2) return g;
  const cx = g.reduce((s, p) => s + p.x, 0) / g.length;
  const cy = g.reduce((s, p) => s + p.y, 0) / g.length;
  const r = 20 + g.length * 4;
  g.forEach((p, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / g.length;
    p.px = cx + r * Math.cos(a);
    p.py = cy + r * Math.sin(a);
    p.spread = true;
  });
  return g;
}

interface Layout {
  singles: Placed[];
  clusters: Cluster[];
  /** "lat,lng" of a clustered pin → its cluster, so routes can collapse onto cluster centers. */
  clusterOf: Map<string, Cluster>;
}

const ll = (p: { lat: number; lng: number }) => `${p.lat},${p.lng}`;

/**
 * `minGroup`: groups smaller than this are fanned out rather than clustered. A single day keeps its few overlapping
 * stops individually numbered (fanned); the whole-trip view clusters from two pins up.
 */
function buildLayout(pts: { pin: MapPin; x: number; y: number }[], scale: number, radius: number, minGroup: number, selectedKey: string | null): Layout {
  const byKey = (a: Placed, b: Placed) => Number(a.pin.key === selectedKey) - Number(b.pin.key === selectedKey);
  if (scale >= STREET_SCALE) {
    const fanned = clusterByDistance(place(pts), SPREAD_PX).flatMap(fanGroup);
    return { singles: fanned.sort(byKey), clusters: [], clusterOf: new Map() };
  }
  const singles: Placed[] = [];
  const clusters: Cluster[] = [];
  const clusterOf = new Map<string, Cluster>();
  for (const g of clusterByDistance(pts, radius)) {
    if (g.length < minGroup) {
      singles.push(...fanGroup(place(g)));
      continue;
    }
    const colors = new Set(g.map((m) => m.pin.color));
    const c: Cluster = {
      id: `cluster:${g[0]!.pin.key}`,
      pins: g.map((m) => m.pin),
      x: g.reduce((s, m) => s + m.x, 0) / g.length,
      y: g.reduce((s, m) => s + m.y, 0) / g.length,
      color: colors.size === 1 ? g[0]!.pin.color : null,
    };
    clusters.push(c);
    for (const m of g) clusterOf.set(ll(m.pin), c);
    // The selected stop stays visible on top of its cluster, so selecting never hides where you are.
    const sel = g.find((m) => m.pin.key === selectedKey);
    if (sel) singles.push(...place([sel]));
  }
  return { singles: singles.sort(byKey), clusters, clusterOf };
}

function niceKm(maxKm: number): number {
  const pow = 10 ** Math.floor(Math.log10(maxKm));
  for (const m of [5, 2, 1]) if (m * pow <= maxKm) return m * pow;
  return pow;
}

interface LabelPlan {
  side: 'right' | 'left';
  /** Possibly shortened with an ellipsis so it never runs past the usable edge. */
  text: string;
}

/** Rough rendered width of a label at 12px (CJK glyphs are about twice as wide as Latin ones). */
function estimateWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += /[\u0000-ɏ]/.test(ch) ? 7.4 : 12.4;
  return w;
}

let measureCtx: CanvasRenderingContext2D | null | undefined;
/** Real text width (canvas) when available, plus the 4px halo stroke; falls back to the estimate. */
function labelWidth(text: string): number {
  if (measureCtx === undefined) {
    try {
      measureCtx = document.createElement('canvas').getContext('2d');
      if (measureCtx) measureCtx.font = `500 12px ${getComputedStyle(document.body).fontFamily}`;
    } catch {
      measureCtx = null;
    }
  }
  return (measureCtx ? measureCtx.measureText(text).width : estimateWidth(text)) + 4;
}

function fitText(text: string, room: number): string {
  if (labelWidth(text) <= room) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (labelWidth(`${text.slice(0, mid)}…`) <= room) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? `${text.slice(0, lo)}…` : '';
}

interface Box {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/**
 * Greedy label placement. Only the selected pin, the hovered pin and (in a single-day view, `all`) the pins in view
 * get a label, at most MAX_LABELS in total. A label goes right of its pin, flips left when the right side would run
 * past the usable edge, and is shortened as a last resort; non-forced labels that overlap anything are skipped.
 */
function layoutLabels(
  singles: Placed[],
  clusters: Cluster[],
  area: { l: number; r: number; h: number },
  selectedKey: string | null,
  hover: string | null,
  all: boolean,
): Map<string, LabelPlan> {
  const out = new Map<string, LabelPlan>();
  const boxes: Box[] = [
    ...singles.map((p) => ({ x0: p.px - 13, x1: p.px + 13, y0: p.py - 13, y1: p.py + 13 })),
    ...clusters.map((c) => ({ x0: c.x - 18, x1: c.x + 18, y0: c.y - 18, y1: c.y + 18 })),
  ];
  const hit = (b: Box) => boxes.some((o) => b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0);
  const rank = (p: Placed) => (p.pin.key === selectedKey ? 0 : p.pin.key === hover ? 1 : p.pin.sel.type === 'candidate' ? 3 : 2);
  const order = [...singles].sort((a, b) => rank(a) - rank(b));
  for (const p of order) {
    if (out.size >= MAX_LABELS) break;
    const forced = p.pin.key === selectedKey || p.pin.key === hover;
    if (!forced) {
      const visible = p.px >= area.l + 8 && p.px <= area.r - 8 && p.py >= 8 && p.py <= area.h - 8;
      if (!all || !visible) continue;
    }
    const off = (p.pin.key === selectedKey ? 13 : 11) + 6;
    const full = labelWidth(p.pin.title);
    const roomR = area.r - 6 - (p.px + off);
    const roomL = p.px - off - (area.l + 6);
    const box = (side: 'right' | 'left', w: number): Box =>
      side === 'right'
        ? { x0: p.px + off, x1: p.px + off + w, y0: p.py - 9, y1: p.py + 9 }
        : { x0: p.px - off - w, x1: p.px - off, y0: p.py - 9, y1: p.py + 9 };
    let side: 'right' | 'left' | null = null;
    let text = p.pin.title;
    if (full <= roomR && (forced || !hit(box('right', full)))) side = 'right';
    else if (full <= roomL && (forced || !hit(box('left', full)))) side = 'left';
    else if (forced) {
      // Neither side fits whole: take the roomier one and shorten the text rather than let it be cut off.
      side = roomR >= roomL ? 'right' : 'left';
      text = fitText(p.pin.title, Math.max(roomR, roomL));
      if (!text) side = null;
    }
    if (side) {
      boxes.push(box(side, labelWidth(text)));
      out.set(p.pin.key, { side, text });
    }
  }
  return out;
}

function PinGlyph({ p, selected, label }: { p: Placed; selected: boolean; label: LabelPlan | null }) {
  const { pin } = p;
  const candidate = pin.sel.type === 'candidate';
  const r = selected ? 13 : 11;
  const color = `var(${pin.color})`;
  const fill =
    pin.style === 'unconfirmed' ? 'var(--surface)' : pin.style === 'rejected' ? 'var(--surface-2)' : color;
  const textFill = pin.style === 'unconfirmed' || pin.style === 'rejected' ? color : `var(${onVar(pin.color)})`;
  const stroke = pin.style === 'unconfirmed' ? color : pin.style === 'rejected' ? color : 'var(--pin-edge)';
  return (
    <g
      className={`pin pin-${pin.style}${selected ? ' selected' : ''}`}
      transform={`translate(${p.px} ${p.py})`}
      opacity={pin.style === 'rejected' ? 0.45 : 1}
    >
      {selected && (
        <circle r={r + 5} fill="none" stroke="var(--accent)" strokeWidth={2} />
      )}
      {candidate ? (
        <rect
          x={-r}
          y={-r}
          width={r * 2}
          height={r * 2}
          rx={7}
          fill={fill}
          stroke={stroke}
          strokeWidth={pin.style === 'unconfirmed' ? 1.75 : 2}
          strokeDasharray={pin.style === 'unconfirmed' ? '4 3' : undefined}
        />
      ) : (
        <circle r={r} fill={fill} stroke={stroke} strokeWidth={2} />
      )}
      <text
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={pin.label.length > 1 ? 10 : 12}
        fontWeight={700}
        fill={textFill}
        className="pin-text"
      >
        {pin.label}
      </text>
      {label && (
        <text
          x={label.side === 'right' ? r + 6 : -(r + 6)}
          y={1}
          textAnchor={label.side === 'right' ? 'start' : 'end'}
          dominantBaseline="central"
          className="pin-label"
          fontSize={12}
        >
          {label.text}
        </text>
      )}
    </g>
  );
}

function ClusterGlyph({ c }: { c: Cluster }) {
  const day = c.color !== null && c.color !== '--muted';
  const fill = day ? `var(${c.color})` : 'var(--muted)';
  const ink = day ? `var(${onVar(c.color!)})` : '#000000';
  const n = c.pins.length;
  return (
    <g className="pin pin-cluster" transform={`translate(${c.x} ${c.y})`}>
      <circle r={22} fill={fill} opacity={0.22} />
      <circle r={16} fill={fill} stroke="var(--pin-edge)" strokeWidth={2} />
      <text textAnchor="middle" dominantBaseline="central" fontSize={n > 99 ? 10 : 13} fontWeight={700} fill={ink} className="pin-text">
        {n}
      </text>
    </g>
  );
}

/** Routes carry no real path geometry, only the stops in order, so every route is a straight-line estimate. */
const ROUTE_DASH = '7 6';

export function SvgMap({ pins, routes, selectedKey, onSelect, inset }: Props) {
  const insetL = inset?.left ?? 0;
  const insetR = inset?.right ?? 0;
  const wrap = useRef<HTMLDivElement | null>(null);
  const { w, h } = useSize(wrap);
  const [view, setView] = useState<View>(HOME);
  const [hover, setHover] = useState<string | null>(null);
  const [hint, setHint] = useState(false);
  const locked = useGestureLock();
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  // The default view fits the day's scheduled stops. Candidates are shown but do not widen the fit:
  // a candidate in another city would otherwise keep the whole trip in frame.
  const fitPins = useMemo(() => {
    const scheduled = pins.filter((p) => p.sel.type !== 'candidate');
    return scheduled.length > 0 ? scheduled : pins;
  }, [pins]);
  const fitKey = useMemo(() => fitPins.map((p) => p.key).join('|') + routes.length, [fitPins, routes]);
  useEffect(() => setView(HOME), [fitKey]);

  // One day (or one color) of stops vs. the whole trip: only the former earns per-pin labels.
  const singleDay = useMemo(() => new Set(fitPins.map((p) => p.color)).size <= 1, [fitPins]);

  // Web Mercator, so pins line up with the basemap tiles. `s` = screen px per world unit at view.k = 1.
  const proj = useMemo(() => {
    const all = [...fitPins, ...routes.flatMap((r) => r.points)];
    if (all.length === 0) return null;
    const pts = all.map((p) => toWorld(p.lat, p.lng));
    const minX = Math.min(...pts.map((p) => p.x));
    const maxX = Math.max(...pts.map((p) => p.x));
    const minY = Math.min(...pts.map((p) => p.y));
    const maxY = Math.max(...pts.map((p) => p.y));
    const midX = (minX + maxX) / 2;
    const midY = (minY + maxY) / 2;
    const spanX = Math.max(maxX - minX, 1e-6);
    const spanY = Math.max(maxY - minY, 1e-6);
    // Fit into the area not covered by the floating panels (App drops insets on narrow screens).
    const insets = w - insetL - insetR > 240;
    const area = { l: insets ? insetL : 0, r: insets ? w - insetR : w, h };
    const cx = (area.l + area.r) / 2;
    const s = Math.min((area.r - area.l - 2 * PAD) / spanX, (h - 2 * PAD) / spanY, 256 * 2 ** 16);
    const ox = cx - midX * s;
    const oy = h / 2 - midY * s;
    const project = (lat: number, lng: number) => {
      const p = toWorld(lat, lng);
      return { x: p.x * s + ox, y: p.y * s + oy };
    };
    const midLat = (Math.min(...all.map((p) => p.lat)) + Math.max(...all.map((p) => p.lat))) / 2;
    // Deep enough to reach street level (where clustering turns off) from any trip-wide fit.
    const kMax = Math.max(400, (STREET_SCALE * 4) / s);
    return { project, s, ox, oy, midLat, cx, area, kMax };
  }, [fitPins, routes, w, h, insetL, insetR]);
  const projRef = useRef(proj);
  projRef.current = proj;

  /** View that frames the given base-projected points inside the usable area, never zooming past `maxK`. */
  const frame = (bases: { x: number; y: number }[], maxK: number): View | null => {
    if (!proj || bases.length === 0) return null;
    const xs = bases.map((b) => b.x);
    const ys = bases.map((b) => b.y);
    const spanX = Math.max(...xs) - Math.min(...xs);
    const spanY = Math.max(...ys) - Math.min(...ys);
    const midX = (Math.max(...xs) + Math.min(...xs)) / 2;
    const midY = (Math.max(...ys) + Math.min(...ys)) / 2;
    const aw = Math.max(80, proj.area.r - proj.area.l - 2 * PAD);
    const ah = Math.max(80, h - 2 * PAD);
    const k = Math.max(0.25, Math.min(maxK, proj.kMax, spanX > 1e-9 ? aw / spanX : Infinity, spanY > 1e-9 ? ah / spanY : Infinity));
    return { k, tx: proj.cx - midX * k, ty: h / 2 - midY * k };
  };

  // Selecting a stop (from the list, the facts bar or the map) keeps the day in frame: if the stop is already in
  // view it is only highlighted (nudged just enough to clear the panels); if not, frame previous → stop → next.
  // Exception: a stop that is currently swallowed by a cluster pin (the whole-trip view) would show nothing
  // happening, so it zooms to street level around that stop.
  // Runs after the fit effect above, so a selection that arrives together with a day change wins.
  useEffect(() => {
    if (!selectedKey || !proj) return;
    const i = pins.findIndex((p) => p.key === selectedKey);
    const pin = pins[i];
    if (!pin) return;
    const base = proj.project(pin.lat, pin.lng);
    const buried = layout.clusters.some((c) => c.pins.some((q) => q.key === selectedKey));
    setView((v) => {
      if (buried) return frame([base], (STREET_SCALE * 1.02) / proj.s) ?? v;
      const sx = base.x * v.k + v.tx;
      const sy = base.y * v.k + v.ty;
      const { l, r } = proj.area;
      if (sx >= l && sx <= r && sy >= 0 && sy <= h) {
        const d = minimalPan(sx, sy, { l, r, t: 0, b: h }, 56);
        return d.dx || d.dy ? { ...v, tx: v.tx + d.dx, ty: v.ty + d.dy } : v;
      }
      const sameDay = (q: MapPin | undefined): q is MapPin => !!q && pin.sel.type === 'item' && q.sel.type === 'item' && q.color === pin.color;
      const around = [pins[i - 1], pin, pins[i + 1]].filter((q): q is MapPin => q === pin || sameDay(q));
      const f = frame(around.map((q) => proj.project(q.lat, q.lng)), Math.min(v.k, (256 * 2 ** 15) / proj.s));
      return f ?? v;
    });
    // Only a change of selection should move the view; panning afterwards must stay free.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey]);

  const screen = (x: number, y: number) => ({ x: x * view.k + view.tx, y: y * view.k + view.ty });

  const layout = useMemo<Layout>(() => {
    if (!proj) return { singles: [], clusters: [], clusterOf: new Map() };
    const pts = pins.map((pin) => {
      const b = proj.project(pin.lat, pin.lng);
      return { pin, x: b.x * view.k + view.tx, y: b.y * view.k + view.ty };
    });
    // Only the selection changes paint order. Re-ordering on hover moves DOM nodes between
    // pointerdown and pointerup, which makes the browser drop the click (always on touch).
    return buildLayout(pts, proj.s * view.k, singleDay ? CLUSTER_DAY_PX : CLUSTER_ALL_PX, singleDay ? 4 : 2, selectedKey);
  }, [proj, pins, view, selectedKey, singleDay]);

  const labels = useMemo(
    () => layoutLabels(layout.singles, layout.clusters, proj?.area ?? { l: 0, r: w, h }, selectedKey, hover, singleDay),
    [layout, proj, w, h, selectedKey, hover, singleDay],
  );

  const zoomClusterIn = (c: Cluster) => {
    if (!proj) return;
    const f = frame(c.pins.map((q) => proj.project(q.lat, q.lng)), (STREET_SCALE * 1.02) / proj.s);
    if (f) setView(f);
  };

  const clampK = (k: number) => Math.min(projRef.current?.kMax ?? 400, Math.max(0.25, k));
  const zoomAt = (cx: number, cy: number, factor: number) =>
    setView((v) => {
      const k = clampK(v.k * factor);
      const f = k / v.k;
      return { k, tx: cx - (cx - v.tx) * f, ty: cy - (cy - v.ty) * f };
    });

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      // Narrow/touch layouts scroll the page; only a pinch gesture (ctrl+wheel) may zoom the map there.
      if (lockedRef.current && !e.ctrlKey) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
    };
    el.addEventListener('wheel', onWheel, { passive: false });

    // Touch: one finger belongs to the page (it scrolls), two fingers pinch/pan the map.
    let prev: { cx: number; cy: number; d: number } | null = null;
    let hintTimer: ReturnType<typeof setTimeout> | undefined;
    const read = (e: TouchEvent) => {
      const a = e.touches[0]!;
      const b = e.touches[1]!;
      const r = el.getBoundingClientRect();
      return { cx: (a.clientX + b.clientX) / 2 - r.left, cy: (a.clientY + b.clientY) / 2 - r.top, d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) };
    };
    const onTouchStart = (e: TouchEvent) => {
      prev = e.touches.length >= 2 ? read(e) : null;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (!lockedRef.current) return;
      if (e.touches.length < 2) {
        setHint(true);
        clearTimeout(hintTimer);
        hintTimer = setTimeout(() => setHint(false), 1400);
        return;
      }
      if (e.cancelable) e.preventDefault();
      const cur = read(e);
      const was = prev ?? cur;
      prev = cur;
      const factor = cur.d / Math.max(was.d, 1);
      setView((v) => {
        const k = clampK(v.k * factor);
        const f = k / v.k;
        return { k, tx: cur.cx - (was.cx - v.tx) * f, ty: cur.cy - (was.cy - v.ty) * f };
      });
    };
    const onTouchEnd = (e: TouchEvent) => {
      prev = e.touches.length >= 2 ? read(e) : null;
    };
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    el.addEventListener('touchcancel', onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
      clearTimeout(hintTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scale = useMemo(() => {
    if (!proj) return null;
    const pxPerWorld = proj.s * view.k;
    const pxPerKm = pxPerWorld / (40075.016686 * Math.cos((proj.midLat * Math.PI) / 180));
    const km = niceKm(120 / pxPerKm);
    return { km, px: km * pxPerKm };
  }, [proj, view.k]);

  const tiles = useMemo(() => {
    if (!TILES || !proj) return [];
    return visibleTiles(proj.s * view.k, proj.ox * view.k + view.tx, proj.oy * view.k + view.ty, w, h, TILES.maxZoom);
  }, [proj, view, w, h]);
  const retina = typeof window !== 'undefined' && window.devicePixelRatio > 1;

  const gridStep = 80 * view.k;
  const gx = ((view.tx % gridStep) + gridStep) % gridStep;
  const gy = ((view.ty % gridStep) + gridStep) % gridStep;

  // Offer a way back once the map has been moved away from the fitted view.
  const moved = Math.abs(view.k - 1) > 0.03 || Math.abs(view.tx) > 12 || Math.abs(view.ty) > 12;

  // Route polylines run through cluster centers (stops inside one cluster collapse to a point), so the overview
  // reads as city → city instead of a tangle inside each city.
  const routeLine = (r: MapRoute): string | null => {
    if (!proj) return null;
    const pts: { x: number; y: number }[] = [];
    let last: string | null = null;
    for (const pt of r.points) {
      const c = layout.clusterOf.get(ll(pt));
      if (c) {
        if (c.id === last) continue;
        last = c.id;
        pts.push({ x: c.x, y: c.y });
      } else {
        last = null;
        const b = proj.project(pt.lat, pt.lng);
        pts.push(screen(b.x, b.y));
      }
    }
    return pts.length >= 2 ? pts.map((q) => `${q.x},${q.y}`).join(' ') : null;
  };

  return (
    <div
      className={`svgmap${locked ? ' locked' : ''}`}
      ref={wrap}
      onPointerDown={(e) => {
        if ((e.target as Element).closest('.pin, .map-ctrl, .map-recenter')) return;
        // On touch/narrow screens a finger scrolls the page; the two-finger gesture is handled above.
        if (lockedRef.current && e.pointerType !== 'mouse') return;
        drag.current = { x: e.clientX, y: e.clientY, moved: false };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.x;
        const dy = e.clientY - d.y;
        d.x = e.clientX;
        d.y = e.clientY;
        d.moved = true;
        setView((v) => ({ ...v, tx: v.tx + dx, ty: v.ty + dy }));
      }}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
    >
      <svg width={w} height={h} role="group" aria-label="離線路線地圖">
        <defs>
          <pattern id="mapgrid" width={gridStep} height={gridStep} patternUnits="userSpaceOnUse" x={gx} y={gy}>
            <path d={`M ${gridStep} 0 L 0 0 0 ${gridStep}`} fill="none" stroke="var(--map-grid)" strokeWidth={1} />
          </pattern>
        </defs>
        <rect width={w} height={h} fill="var(--map-bg)" />
        {TILES ? (
          <g className="tiles" style={TILES.filter ? { filter: TILES.filter } : undefined} aria-hidden="true">
            {tiles.map((t) => (
              <image
                key={t.key}
                href={tileUrl(TILES!, t.z, t.x, t.y, retina)}
                x={t.sx}
                y={t.sy}
                width={t.size + 0.5}
                height={t.size + 0.5}
                preserveAspectRatio="none"
              />
            ))}
          </g>
        ) : (
          <rect width={w} height={h} fill="url(#mapgrid)" />
        )}
        {proj &&
          routes.map((r) => {
            const points = routeLine(r);
            return (
              points && (
                <polyline
                  key={r.key}
                  className="route-est"
                  fill="none"
                  stroke={`var(${r.color})`}
                  strokeWidth={2.5}
                  strokeDasharray={ROUTE_DASH}
                  strokeLinejoin="round"
                  strokeLinecap="butt"
                  opacity={0.9}
                  points={points}
                />
              )
            );
          })}
        {layout.singles
          .filter((p) => p.spread)
          .map((p) => (
            <g key={`lead-${p.pin.key}`}>
              <line x1={p.x} y1={p.y} x2={p.px} y2={p.py} stroke="var(--faint)" strokeWidth={1} />
              <circle cx={p.x} cy={p.y} r={2.5} fill="var(--muted)" />
            </g>
          ))}
        {layout.clusters.map((c) => (
          <g
            key={c.id}
            role="button"
            tabIndex={0}
            aria-label={`${c.pins.length} 個地點，點擊放大`}
            className="pin-hit"
            onClick={() => zoomClusterIn(c)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                zoomClusterIn(c);
              }
            }}
          >
            <ClusterGlyph c={c} />
          </g>
        ))}
        {layout.singles.map((p) => (
          <g
            key={p.pin.key}
            role="button"
            tabIndex={0}
            aria-label={`${p.pin.title}`}
            className="pin-hit"
            onPointerEnter={() => setHover(p.pin.key)}
            onPointerLeave={() => setHover(null)}
            onFocus={() => setHover(p.pin.key)}
            onBlur={() => setHover(null)}
            onClick={() => onSelect(p.pin)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault(); // Space must not scroll the page
                onSelect(p.pin);
              }
            }}
          >
            <PinGlyph p={p} selected={p.pin.key === selectedKey} label={labels.get(p.pin.key) ?? null} />
          </g>
        ))}
        {scale && (
          <g transform={`translate(${(proj && proj.area.l ? proj.area.l : 0) + 20} ${h - 22})`} className="scale">
            <line x2={scale.px} stroke="var(--faint)" strokeWidth={1.5} />
            <line y1={-3} y2={3} stroke="var(--faint)" strokeWidth={1.5} />
            <line x1={scale.px} x2={scale.px} y1={-3} y2={3} stroke="var(--faint)" strokeWidth={1.5} />
            <text x={scale.px + 8} dominantBaseline="central" fontSize={11} fill="var(--faint)">
              {scale.km >= 1 ? `${scale.km} km` : `${Math.round(scale.km * 1000)} m`}
              {routes.length > 0 && w >= 560 ? ' · 虛線＝直線估算' : ''}
            </text>
          </g>
        )}
      </svg>
      {pins.length === 0 && <div className="map-empty">沒有可繪製的座標</div>}
      {hint && <div className="map-hint">用兩指移動或縮放地圖</div>}
      {moved && proj && (
        <button
          type="button"
          className="map-recenter"
          style={{ left: proj.cx }}
          onClick={() => setView(HOME)}
        >
          ⌂ {singleDay ? '回到這一天' : '回到全部'}
        </button>
      )}
      <div className="map-ctrl" role="group" aria-label="地圖縮放">
        <button type="button" aria-label="放大" onClick={() => zoomAt(w / 2, h / 2, 1.5)}>＋</button>
        <button type="button" aria-label="縮小" onClick={() => zoomAt(w / 2, h / 2, 1 / 1.5)}>－</button>
        <button type="button" aria-label="重設視圖" onClick={() => setView(HOME)}>⌂</button>
      </div>
      {TILES ? (
        <a className="map-attrib" href={TILES.attributionUrl} target="_blank" rel="noreferrer noopener">
          {TILES.attribution}
        </a>
      ) : (
        <div className="map-badge">離線地圖 · 直線示意</div>
      )}
    </div>
  );
}
