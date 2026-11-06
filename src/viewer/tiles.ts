// Keyless basemap tiles for the offline/interactive map, plus Web Mercator helpers.
// Configure with VITE_MAP_TILES in .env: "osm" (default, darkened in the browser), "carto-dark" (needs a
// CARTO key in the URL these days), "none", or a URL template
// containing {z} {x} {y} (and optionally {s} and {r}). Every preset carries its required attribution.

export interface TileSource {
  url: string;
  subdomains: string[];
  attribution: string;
  attributionUrl: string;
  maxZoom: number;
  /** CSS filter applied to tiles (used to darken light tile sets). */
  filter?: string;
}

const PRESETS: Record<string, TileSource> = {
  'carto-dark': {
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    subdomains: ['a', 'b', 'c', 'd'],
    attribution: '© OpenStreetMap 貢獻者 © CARTO',
    attributionUrl: 'https://www.openstreetmap.org/copyright',
    maxZoom: 19,
  },
  osm: {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    subdomains: [],
    attribution: '© OpenStreetMap 貢獻者',
    attributionUrl: 'https://www.openstreetmap.org/copyright',
    maxZoom: 19,
    filter: 'invert(1) hue-rotate(180deg) brightness(0.85) contrast(0.9) saturate(0.3)',
  },
};

/** Resolves the configured tile source; null means "no tiles" (pure offline grid). */
export function resolveTiles(setting: string | undefined): TileSource | null {
  const v = (setting ?? '').trim();
  if (v === 'none') return null;
  if (v === '') return PRESETS.osm!;
  const preset = PRESETS[v];
  if (preset) return preset;
  if (/^https:\/\/.*\{z\}.*\{x\}.*\{y\}/.test(v)) {
    return { url: v, subdomains: ['a', 'b', 'c'], attribution: '地圖圖磚：自訂來源', attributionUrl: v.split('/').slice(0, 3).join('/'), maxZoom: 19 };
  }
  return PRESETS.osm!;
}

export const TILES: TileSource | null = resolveTiles(import.meta.env?.VITE_MAP_TILES as string | undefined);

export function tileUrl(src: TileSource, z: number, x: number, y: number, retina: boolean): string {
  const s = src.subdomains.length > 0 ? src.subdomains[(x + y) % src.subdomains.length]! : '';
  return src.url
    .replace('{s}', s)
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y))
    .replace('{r}', retina ? '@2x' : '');
}

const MAX_LAT = 85.05112878;

/** Longitude/latitude → Web Mercator world coordinates in [0, 1). */
export function toWorld(lat: number, lng: number): { x: number; y: number } {
  const la = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
  const s = Math.sin((la * Math.PI) / 180);
  return {
    x: (lng + 180) / 360,
    y: 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI),
  };
}

export interface TileRef {
  key: string;
  z: number;
  x: number;
  y: number;
  /** Screen position and size in px. */
  sx: number;
  sy: number;
  size: number;
}

/**
 * Tiles covering a w×h viewport where world point (wx, wy) is drawn at (wx * scale + ox, wy * scale + oy),
 * `scale` being screen px per world unit. Returns [] when it would need an unreasonable number of tiles.
 */
export function visibleTiles(scale: number, ox: number, oy: number, w: number, h: number, maxZoom: number): TileRef[] {
  const z = Math.max(0, Math.min(maxZoom, Math.round(Math.log2(scale / 256))));
  const n = 2 ** z;
  const size = scale / n;
  const x0 = Math.floor(-ox / size);
  const x1 = Math.floor((w - ox) / size);
  const y0 = Math.max(0, Math.floor(-oy / size));
  const y1 = Math.min(n - 1, Math.floor((h - oy) / size));
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > 120) return [];
  const out: TileRef[] = [];
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const wx = ((tx % n) + n) % n;
      out.push({ key: `${z}/${tx}/${ty}`, z, x: wx, y: ty, sx: ox + tx * size, sy: oy + ty * size, size });
    }
  }
  return out;
}

// ---------- screen-space helpers for the interactive map ----------

/**
 * Leader-based grouping: a point joins the first group whose leader (its first member) is closer than
 * `radius`, otherwise it starts a new group. Leaders are therefore always more than `radius` apart, and
 * the result does not chain into long snakes the way single-linkage clustering does.
 */
export function clusterByDistance<T extends { x: number; y: number }>(pts: T[], radius: number): T[][] {
  const groups: T[][] = [];
  for (const p of pts) {
    const g = groups.find((grp) => Math.hypot(grp[0]!.x - p.x, grp[0]!.y - p.y) < radius);
    if (g) g.push(p);
    else groups.push([p]);
  }
  return groups;
}

/** Smallest shift (dx, dy) that brings (x, y) inside `box` shrunk by `margin`; zero when already inside. */
export function minimalPan(
  x: number,
  y: number,
  box: { l: number; r: number; t: number; b: number },
  margin: number,
): { dx: number; dy: number } {
  const l = box.l + margin;
  const r = Math.max(l, box.r - margin);
  const t = box.t + margin;
  const b = Math.max(t, box.b - margin);
  return { dx: x < l ? l - x : x > r ? r - x : 0, dy: y < t ? t - y : y > b ? b - y : 0 };
}
