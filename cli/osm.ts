// Keyless place search/details via OpenStreetMap Nominatim. Network, clock and sleep are injected
// so tests never touch the network. Follows https://operations.osmfoundation.org/policies/nominatim/ :
// descriptive User-Agent, at most 1 request per second, no bulk or scheduled use.
// Data (c) OpenStreetMap contributors, ODbL: https://www.openstreetmap.org/copyright
import fs from 'node:fs';
import path from 'node:path';
import type { LatLng, OpeningHours, Sourced } from '../src/core/types.ts';
import type { FetchLike, PlaceDetails, PlaceSearchResult, PlaceSummary } from './google.ts';

export const OSM_SOURCE = 'openstreetmap-nominatim';
const NOMINATIM = 'https://nominatim.openstreetmap.org';
const MIN_INTERVAL_MS = 1000;
/** Half-size (degrees) of the --near viewbox bias. */
const VIEWBOX_DEG = 0.1;

export class OsmApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'OsmApiError';
    this.status = status;
  }
}

export interface OsmClientOptions {
  fetch: FetchLike;
  now?: () => Date;
  userAgent: string;
  /** Throttle shared across calls; defaults to a process-wide one. */
  throttle?: Throttle;
}

/** Spaces requests at least `intervalMs` apart. `clock` returns epoch ms; `sleep` waits ms. */
export class Throttle {
  private last: number | undefined;
  private clock: () => number;
  private sleep: (ms: number) => Promise<void>;
  private intervalMs: number;
  constructor(opts: { clock?: () => number; sleep?: (ms: number) => Promise<void>; intervalMs?: number } = {}) {
    this.clock = opts.clock ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.intervalMs = opts.intervalMs ?? MIN_INTERVAL_MS;
  }
  async wait(): Promise<void> {
    if (this.last !== undefined) {
      const remaining = this.last + this.intervalMs - this.clock();
      if (remaining > 0) await this.sleep(remaining);
    }
    this.last = this.clock();
  }
}

const defaultThrottle = new Throttle();

export function userAgentFor(root: string): string {
  let version = '0.0.0';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version?: string };
    if (pkg.version) version = pkg.version;
  } catch {
    // keep fallback
  }
  return `TripCode/${version} (open-source travel planner; local CLI)`;
}

export function isOsmId(id: string): boolean {
  return /^osm:(node|way|relation)\/\d+$/.test(id);
}

export function buildSearchUrl(query: string, extra: { near?: LatLng; lang?: string } = {}): string {
  const p = new URLSearchParams({ format: 'jsonv2', q: query, limit: '5', addressdetails: '0' });
  if (extra.lang) p.set('accept-language', extra.lang);
  if (extra.near) {
    const { lat, lng } = extra.near;
    // viewbox = left,top,right,bottom (lon,lat); a bias only, not bounded.
    p.set('viewbox', [lng - VIEWBOX_DEG, lat + VIEWBOX_DEG, lng + VIEWBOX_DEG, lat - VIEWBOX_DEG].join(','));
  }
  return `${NOMINATIM}/search?${p.toString()}`;
}

export function buildLookupUrl(placeId: string, lang?: string): string {
  const m = /^osm:(node|way|relation)\/(\d+)$/.exec(placeId);
  if (!m) throw new OsmApiError(`不是有效的 OSM id：${placeId}（格式 osm:node/123）`, 0);
  const p = new URLSearchParams({ osm_ids: `${m[1]![0]!.toUpperCase()}${m[2]}`, format: 'jsonv2', extratags: '1' });
  if (lang) p.set('accept-language', lang);
  return `${NOMINATIM}/lookup?${p.toString()}`;
}

interface NominatimPlace {
  osm_type?: string;
  osm_id?: number;
  lat?: string;
  lon?: string;
  name?: string;
  display_name?: string;
  extratags?: Record<string, string> | null;
}

function summarize(p: NominatimPlace, fetchedAt: string): PlaceSummary | undefined {
  if (!p.osm_type || p.osm_id === undefined) return undefined;
  const lat = Number(p.lat);
  const lng = Number(p.lon);
  const display = p.display_name ?? '';
  const out: PlaceSummary = {
    placeId: `osm:${p.osm_type}/${p.osm_id}`,
    name: p.name || display.split(',')[0]?.trim() || '',
    source: OSM_SOURCE,
    fetchedAt,
  };
  if (display) out.address = display;
  if (p.lat !== undefined && p.lon !== undefined && Number.isFinite(lat) && Number.isFinite(lng)) {
    out.loc = { lat, lng, fetchedAt };
  }
  return out;
}

async function get(opts: OsmClientOptions, url: string): Promise<unknown> {
  await (opts.throttle ?? defaultThrottle).wait();
  let res: Response;
  try {
    res = await opts.fetch(url, { method: 'GET', headers: { 'User-Agent': opts.userAgent, Accept: 'application/json' } });
  } catch (e) {
    throw new OsmApiError(`無法連線到 OpenStreetMap Nominatim：${e instanceof Error ? e.message : String(e)}`, 0);
  }
  const text = await res.text();
  if (!res.ok) throw new OsmApiError(`Nominatim 回應 ${res.status}：${text.slice(0, 200)}`, res.status);
  try {
    return text ? JSON.parse(text) : [];
  } catch {
    throw new OsmApiError('Nominatim 回傳了無法解析的內容', res.status);
  }
}

export async function searchPlacesOsm(
  opts: OsmClientOptions,
  query: string,
  extra: { near?: LatLng; lang?: string } = {},
): Promise<PlaceSearchResult> {
  const data = await get(opts, buildSearchUrl(query, extra));
  const fetchedAt = (opts.now?.() ?? new Date()).toISOString();
  const results = (Array.isArray(data) ? (data as NominatimPlace[]) : [])
    .map((p) => summarize(p, fetchedAt))
    .filter((p): p is PlaceSummary => !!p);
  return { source: OSM_SOURCE, fetchedAt, results };
}

export interface OsmPlaceDetails extends Omit<PlaceDetails, 'hours'> {
  /** Parsed opening hours, or null when the OSM string is absent or not a simple form. */
  hours: Sourced<OpeningHours> | null;
  /** The raw OSM `opening_hours` tag, when present. */
  hoursRaw?: string;
}

export async function placeDetailsOsm(opts: OsmClientOptions, placeId: string, extra: { lang?: string } = {}): Promise<OsmPlaceDetails> {
  const data = await get(opts, buildLookupUrl(placeId, extra.lang));
  const first = Array.isArray(data) ? (data[0] as NominatimPlace | undefined) : undefined;
  if (!first) throw new OsmApiError(`OpenStreetMap 找不到 ${placeId}`, 404);
  const fetchedAt = (opts.now?.() ?? new Date()).toISOString();
  const base = summarize(first, fetchedAt);
  if (!base) throw new OsmApiError(`OpenStreetMap 回傳的 ${placeId} 缺少 id`, 502);
  const raw = first.extratags?.opening_hours;
  const parsed = raw ? parseOsmOpeningHours(raw) : undefined;
  const out: OsmPlaceDetails = {
    ...base,
    hours: parsed ? { value: parsed, source: OSM_SOURCE, fetchedAt, confidence: 'reference' } : null,
  };
  if (raw) out.hoursRaw = raw;
  return out;
}

// ---- opening_hours (OSM syntax), simple forms only --------------------------------------------

const DAY_CODES = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

function parseDays(s: string): number[] | undefined {
  const days = new Set<number>();
  for (const part of s.split(',')) {
    const m = /^(Mo|Tu|We|Th|Fr|Sa|Su)(?:-(Mo|Tu|We|Th|Fr|Sa|Su))?$/.exec(part.trim());
    if (!m) return undefined;
    const a = DAY_CODES.indexOf(m[1]!);
    if (!m[2]) {
      days.add(a);
      continue;
    }
    const b = DAY_CODES.indexOf(m[2]);
    // Ranges run Monday-first in OSM and may wrap (Sa-Mo).
    for (let d = a; ; d = (d + 1) % 7) {
      days.add(d);
      if (d === b) break;
    }
  }
  return [...days];
}

function hhmm(s: string): string | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return undefined;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59 || h > 24 || (h === 24 && min !== 0)) return undefined;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

/**
 * Parses only simple opening_hours: "24/7" or ";"-separated rules of
 * `<days> <HH:MM-HH:MM>[,<HH:MM-HH:MM>...]` (e.g. "Mo-Fr 09:00-17:00; Sa 10:00-14:00").
 * Anything else (public holidays, months, "off", comments, sunrise...) returns undefined.
 */
export function parseOsmOpeningHours(raw: string): OpeningHours | undefined {
  const s = raw.trim();
  if (s === '24/7') return { periods: Array.from({ length: 7 }, (_, d) => ({ day: d, open: '00:00', close: '24:00' })) };
  const periods: OpeningHours['periods'] = [];
  for (const rule of s.split(';')) {
    const m = /^\s*([A-Za-z,-]+)\s+(\d{1,2}:\d{2}-\d{1,2}:\d{2}(?:\s*,\s*\d{1,2}:\d{2}-\d{1,2}:\d{2})*)\s*$/.exec(rule);
    if (!m) return undefined;
    const days = parseDays(m[1]!);
    if (!days) return undefined;
    for (const range of m[2]!.split(',')) {
      const [o, c] = range.trim().split('-');
      const open = hhmm(o!);
      const close = hhmm(c!);
      if (!open || !close || open === close) return undefined;
      for (const day of days) {
        if (close > open) periods.push({ day, open, close });
        else {
          periods.push({ day, open, close: '24:00' });
          if (close !== '00:00') periods.push({ day: (day + 1) % 7, open: '00:00', close });
        }
      }
    }
  }
  return periods.length ? { periods } : undefined;
}
