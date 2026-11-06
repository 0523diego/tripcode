// Google Places API (New) and Routes API clients. Network access is injected (`fetch`) so
// tests never touch the network. Every request sends an explicit X-Goog-FieldMask (minimal fields).
import type { LatLng, OpeningHours, Sourced } from '../src/core/types.ts';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface GoogleClientOptions {
  apiKey: string;
  fetch: FetchLike;
  now?: () => Date;
}

export class GoogleApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'GoogleApiError';
    this.status = status;
  }
}

const PLACES_BASE = 'https://places.googleapis.com/v1';
const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const ROUTE_MATRIX_URL = 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix';

export const SEARCH_FIELD_MASK =
  'places.id,places.displayName,places.formattedAddress,places.location,places.rating';
export const DETAILS_FIELD_MASK =
  'id,displayName,formattedAddress,location,rating,businessStatus,regularOpeningHours.periods';
export const ROUTES_FIELD_MASK = [
  'routes.duration',
  'routes.distanceMeters',
  'routes.legs.steps.travelMode',
  'routes.legs.steps.staticDuration',
  'routes.legs.steps.distanceMeters',
  'routes.legs.steps.transitDetails.transitLine.name',
  'routes.legs.steps.transitDetails.transitLine.nameShort',
  'routes.legs.steps.transitDetails.transitLine.vehicle.type',
].join(',');

export const ROUTE_MATRIX_FIELD_MASK = 'originIndex,destinationIndex,duration,condition';

export const GOOGLE_PLACES_SOURCE = 'google-places';
export const GOOGLE_ROUTES_SOURCE = 'google-routes';

// ---- result types ---------------------------------------------------------------------------

export interface PlaceSummary {
  placeId: string;
  name: string;
  address?: string;
  loc?: LatLng;
  rating?: number;
  source: string;
  fetchedAt: string;
}

export interface PlaceSearchResult {
  source: string;
  fetchedAt: string;
  results: PlaceSummary[];
}

export interface PlaceDetails extends PlaceSummary {
  businessStatus?: string;
  /** Present when Google returned regularOpeningHours; ready to paste into an item's `hours`. */
  hours?: Sourced<OpeningHours>;
}

export type RouteMode = 'transit' | 'walk' | 'drive';

export interface RouteStep {
  mode: string;
  minutes: number;
  distanceMeters?: number;
  line?: string;
  vehicle?: string;
}

export interface RouteResult {
  minutes: number;
  distanceMeters: number;
  steps: RouteStep[];
  /** Ready to paste into a transit item's `duration`. */
  duration: Sourced<number>;
  source: string;
  fetchedAt: string;
}

// ---- helpers --------------------------------------------------------------------------------

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

interface GooglePoint {
  day?: number;
  hour?: number;
  minute?: number;
}

/**
 * Maps Google's regularOpeningHours.periods onto OpeningHours (`day` 0 = Sunday, "HH:MM").
 * - A period that closes on a later day (overnight) is split at midnight: `open–24:00` on the
 *   first day and `00:00–close` on the next.
 * - A single period with an open point and no close point means open 24/7: seven 00:00–24:00 periods.
 */
export function mapOpeningHours(periods: { open?: GooglePoint; close?: GooglePoint }[] | undefined): OpeningHours | undefined {
  if (!periods || periods.length === 0) return undefined;
  const out: OpeningHours['periods'] = [];
  const hm = (p: GooglePoint) => `${pad2(p.hour ?? 0)}:${pad2(p.minute ?? 0)}`;
  for (const p of periods) {
    const open = p.open;
    if (!open || open.day === undefined) continue;
    if (!p.close) {
      for (let d = 0; d < 7; d++) out.push({ day: d, open: '00:00', close: '24:00' });
      continue;
    }
    const close = p.close;
    const closeDay = close.day ?? open.day;
    const openAt = hm(open);
    const closeAt = hm(close);
    if (closeDay === open.day && closeAt > openAt) {
      out.push({ day: open.day, open: openAt, close: closeAt });
    } else {
      out.push({ day: open.day, open: openAt, close: '24:00' });
      if (closeAt !== '00:00') out.push({ day: closeDay, open: '00:00', close: closeAt });
    }
  }
  return out.length ? { periods: out } : undefined;
}

/** "1234s" → minutes (rounded up so we never under-promise travel time). */
export function parseDurationMinutes(d: string | undefined): number {
  if (!d) return 0;
  const m = /^(\d+(?:\.\d+)?)s$/.exec(d);
  if (!m) return 0;
  return Math.ceil(Number(m[1]) / 60);
}

export function parseLatLng(s: string): LatLng | undefined {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(s);
  if (!m) return undefined;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return undefined;
  return { lat, lng };
}

async function request<T>(opts: GoogleClientOptions, url: string, init: { method: 'GET' | 'POST'; body?: unknown; fieldMask: string }): Promise<T> {
  const headers: Record<string, string> = {
    'X-Goog-Api-Key': opts.apiKey,
    'X-Goog-FieldMask': init.fieldMask,
  };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await opts.fetch(url, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch (e) {
    throw new GoogleApiError(`無法連線到 Google：${e instanceof Error ? e.message : String(e)}`, 0);
  }
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = undefined;
  }
  if (!res.ok) {
    const msg = (json as { error?: { message?: string } } | undefined)?.error?.message ?? text.slice(0, 200);
    throw new GoogleApiError(`Google API 回應 ${res.status}：${msg}`, res.status);
  }
  if (json === undefined) throw new GoogleApiError('Google API 回傳了無法解析的內容', res.status);
  return json as T;
}

interface GooglePlace {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  rating?: number;
  businessStatus?: string;
  regularOpeningHours?: { periods?: { open?: GooglePoint; close?: GooglePoint }[] };
}

function summarize(p: GooglePlace, fetchedAt: string): PlaceSummary | undefined {
  if (!p.id) return undefined;
  const out: PlaceSummary = {
    placeId: p.id,
    name: p.displayName?.text ?? '',
    source: GOOGLE_PLACES_SOURCE,
    fetchedAt,
  };
  if (p.formattedAddress) out.address = p.formattedAddress;
  if (p.location?.latitude !== undefined && p.location.longitude !== undefined) {
    out.loc = { lat: p.location.latitude, lng: p.location.longitude, fetchedAt };
  }
  if (p.rating !== undefined) out.rating = p.rating;
  return out;
}

// ---- API calls ------------------------------------------------------------------------------

export async function searchPlaces(
  opts: GoogleClientOptions,
  query: string,
  extra: { near?: LatLng; lang?: string } = {},
): Promise<PlaceSearchResult> {
  const body: Record<string, unknown> = { textQuery: query };
  if (extra.lang) body.languageCode = extra.lang;
  if (extra.near) {
    body.locationBias = {
      circle: { center: { latitude: extra.near.lat, longitude: extra.near.lng }, radius: 5000 },
    };
  }
  const data = await request<{ places?: GooglePlace[] }>(opts, `${PLACES_BASE}/places:searchText`, {
    method: 'POST',
    body,
    fieldMask: SEARCH_FIELD_MASK,
  });
  const fetchedAt = (opts.now?.() ?? new Date()).toISOString();
  const results = (data.places ?? []).map((p) => summarize(p, fetchedAt)).filter((p): p is PlaceSummary => !!p);
  return { source: GOOGLE_PLACES_SOURCE, fetchedAt, results };
}

export async function placeDetails(
  opts: GoogleClientOptions,
  placeId: string,
  extra: { lang?: string } = {},
): Promise<PlaceDetails> {
  const qs = extra.lang ? `?languageCode=${encodeURIComponent(extra.lang)}` : '';
  const data = await request<GooglePlace>(opts, `${PLACES_BASE}/places/${encodeURIComponent(placeId)}${qs}`, {
    method: 'GET',
    fieldMask: DETAILS_FIELD_MASK,
  });
  const fetchedAt = (opts.now?.() ?? new Date()).toISOString();
  const base = summarize({ ...data, id: data.id ?? placeId }, fetchedAt)!;
  const out: PlaceDetails = { ...base };
  if (data.businessStatus) out.businessStatus = data.businessStatus;
  const hours = mapOpeningHours(data.regularOpeningHours?.periods);
  if (hours) out.hours = { value: hours, source: GOOGLE_PLACES_SOURCE, fetchedAt, confidence: 'live' };
  return out;
}

/** `place_id:XXX` or `lat,lng`. */
export function parseWaypoint(s: string): { placeId: string } | { location: { latLng: { latitude: number; longitude: number } } } {
  const m = /^place_id:(.+)$/.exec(s);
  if (m) return { placeId: m[1]! };
  const ll = parseLatLng(s);
  if (ll) return { location: { latLng: { latitude: ll.lat, longitude: ll.lng } } };
  throw new GoogleApiError(`起點／終點格式錯誤：「${s}」，請用 place_id:XXX 或 lat,lng`, 0);
}

const TRAVEL_MODES: Record<RouteMode, string> = { transit: 'TRANSIT', walk: 'WALK', drive: 'DRIVE' };

interface GoogleRoutesResponse {
  routes?: {
    duration?: string;
    distanceMeters?: number;
    legs?: {
      steps?: {
        travelMode?: string;
        staticDuration?: string;
        distanceMeters?: number;
        transitDetails?: { transitLine?: { name?: string; nameShort?: string; vehicle?: { type?: string } } };
      }[];
    }[];
  }[];
}

export async function computeRoute(
  opts: GoogleClientOptions,
  from: string,
  to: string,
  extra: { mode?: RouteMode; depart?: string; lang?: string } = {},
): Promise<RouteResult> {
  const mode = extra.mode ?? 'transit';
  const body: Record<string, unknown> = {
    origin: parseWaypoint(from),
    destination: parseWaypoint(to),
    travelMode: TRAVEL_MODES[mode],
  };
  if (extra.lang) body.languageCode = extra.lang;
  if (extra.depart && mode !== 'walk') {
    const t = new Date(extra.depart);
    if (Number.isNaN(t.getTime())) throw new GoogleApiError(`--depart 不是有效的 ISO 時間：${extra.depart}`, 0);
    body.departureTime = t.toISOString();
  }
  const data = await request<GoogleRoutesResponse>(opts, ROUTES_URL, {
    method: 'POST',
    body,
    fieldMask: ROUTES_FIELD_MASK,
  });
  const route = data.routes?.[0];
  if (!route) throw new GoogleApiError('Google 找不到這兩點之間的路線', 404);
  const fetchedAt = (opts.now?.() ?? new Date()).toISOString();
  const minutes = parseDurationMinutes(route.duration);
  const steps: RouteStep[] = [];
  for (const leg of route.legs ?? []) {
    for (const s of leg.steps ?? []) {
      const step: RouteStep = {
        mode: (s.travelMode ?? 'UNKNOWN').toLowerCase(),
        minutes: parseDurationMinutes(s.staticDuration),
      };
      if (s.distanceMeters !== undefined) step.distanceMeters = s.distanceMeters;
      const line = s.transitDetails?.transitLine;
      if (line) {
        const name = line.nameShort ?? line.name;
        if (name) step.line = name;
        if (line.vehicle?.type) step.vehicle = line.vehicle.type;
      }
      steps.push(step);
    }
  }
  return {
    minutes,
    distanceMeters: route.distanceMeters ?? 0,
    steps,
    duration: { value: minutes, source: GOOGLE_ROUTES_SOURCE, fetchedAt, confidence: 'live' },
    source: GOOGLE_ROUTES_SOURCE,
    fetchedAt,
  };
}

// ---- route matrix ---------------------------------------------------------------------------

export interface MatrixPoint {
  placeId?: string;
  loc?: LatLng;
}

export interface RouteMatrixResult {
  /** Minutes between points; `matrix[i][j]` is i → j. null where Google found no route. */
  matrix: (number | null)[][];
  source: string;
  fetchedAt: string;
}

interface GoogleMatrixElement {
  originIndex?: number;
  destinationIndex?: number;
  duration?: string;
  condition?: string;
}

/** Transit matrices allow at most 100 elements; other modes 625. */
export const MATRIX_LIMITS: Record<RouteMode, number> = { transit: 100, walk: 625, drive: 625 };

function matrixWaypoint(p: MatrixPoint): { waypoint: ReturnType<typeof parseWaypoint> } {
  if (p.placeId) return { waypoint: { placeId: p.placeId } };
  if (p.loc) return { waypoint: { location: { latLng: { latitude: p.loc.lat, longitude: p.loc.lng } } } };
  throw new GoogleApiError('有地點同時缺少 placeId 與座標，無法查詢路線矩陣', 0);
}

/** Travel minutes between every ordered pair of points (Routes API computeRouteMatrix). */
export async function computeRouteMatrix(
  opts: GoogleClientOptions,
  points: MatrixPoint[],
  extra: { mode?: RouteMode } = {},
): Promise<RouteMatrixResult> {
  const mode = extra.mode ?? 'transit';
  const n = points.length;
  if (n * n > MATRIX_LIMITS[mode]) {
    throw new GoogleApiError(`這天有 ${n} 個地點，${mode} 模式一次最多查 ${MATRIX_LIMITS[mode]} 組路線（${n}×${n} 太多）；請改用 --offline 估算或拆成較少地點`, 0);
  }
  const wp = points.map(matrixWaypoint);
  const data = await request<GoogleMatrixElement[]>(opts, ROUTE_MATRIX_URL, {
    method: 'POST',
    body: { origins: wp, destinations: wp, travelMode: TRAVEL_MODES[mode] },
    fieldMask: ROUTE_MATRIX_FIELD_MASK,
  });
  const fetchedAt = (opts.now?.() ?? new Date()).toISOString();
  const matrix: (number | null)[][] = points.map((_, i) => points.map((__, j) => (i === j ? 0 : null)));
  for (const el of Array.isArray(data) ? data : []) {
    const i = el.originIndex;
    const j = el.destinationIndex;
    if (i === undefined || j === undefined || i === j || !matrix[i] || matrix[i]![j] === undefined) continue;
    if (el.condition !== undefined && el.condition !== 'ROUTE_EXISTS') continue;
    if (el.duration === undefined) continue;
    matrix[i]![j] = parseDurationMinutes(el.duration);
  }
  return { matrix, source: GOOGLE_ROUTES_SOURCE, fetchedAt };
}
