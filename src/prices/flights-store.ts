// What the flights feature keeps on disk.
//   node_modules/.tripcode/flights/cache/<sha1(url)>.json   parsed results for 24 h (so asking twice costs one request)
//   node_modules/.tripcode/flights/state.json                circuit breaker and the time of the last request
//   trips/<id>/prices/flights.json                           dated price snapshots, the budget's source for flights
// Only parsed, validated numbers and short names are stored, never page text.
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FlightOffer } from './flights-parse.ts';
import type { NormalizedQuery } from './flights-url.ts';

export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const dataDir = (root: string) => path.join(root, 'node_modules', '.tripcode', 'flights');

function atomicWriteJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// ---------- cache ----------

export interface CachedQuote {
  queriedAt: string;
  offers: FlightOffer[];
  unpriced: number;
}

const cacheFile = (root: string, url: string) => path.join(dataDir(root), 'cache', `${createHash('sha1').update(url).digest('hex')}.json`);

export function readCache(root: string, url: string, now: number): CachedQuote | null {
  const data = readJson(cacheFile(root, url)) as Partial<CachedQuote> | null;
  if (!data || typeof data.queriedAt !== 'string' || !Array.isArray(data.offers) || typeof data.unpriced !== 'number') return null;
  const age = now - Date.parse(data.queriedAt);
  return Number.isFinite(age) && age >= 0 && age < CACHE_TTL_MS ? (data as CachedQuote) : null;
}

export function writeCache(root: string, url: string, quote: CachedQuote): void {
  atomicWriteJson(cacheFile(root, url), quote);
}

// ---------- circuit breaker ----------

export interface FlightsState {
  failures: number;
  /** ms epoch; while now < openUntil no request is made. */
  openUntil: number | null;
  lastRequestAt: number | null;
}

export const BREAKER_FAILURES = 3;
export const SOFT_PAUSE_MS = 60 * 60 * 1000;
export const HARD_PAUSE_MS = 24 * 60 * 60 * 1000;

const stateFile = (root: string) => path.join(dataDir(root), 'state.json');

export function readState(root: string): FlightsState {
  const d = readJson(stateFile(root)) as Partial<FlightsState> | null;
  return {
    failures: typeof d?.failures === 'number' ? d.failures : 0,
    openUntil: typeof d?.openUntil === 'number' ? d.openUntil : null,
    lastRequestAt: typeof d?.lastRequestAt === 'number' ? d.lastRequestAt : null,
  };
}

export function writeState(root: string, state: FlightsState): void {
  atomicWriteJson(stateFile(root), state);
}

// ---------- snapshots ----------

export interface FlightSnapshot {
  source: 'google-flights';
  level: 'quote';
  queriedAt: string;
  itemId?: string;
  route: { from: string; to: string };
  dates: { depart: string; return?: string };
  tripType: 'one-way' | 'round-trip';
  cabin: string;
  passengers: { adults: number; children: number };
  currency: string;
  price: number;
  airlines: string[];
  flightNos: string[];
  stops: number;
  layovers: string[];
  durationMin: number;
  depart: string;
  arrive: string;
  arriveDayOffset: number;
  link: string;
  label: string;
  match: 'same-flight' | 'cheapest';
}

export const SNAPSHOT_LABEL = 'Google 顯示價，訂票前以官方為準';
const KEEP_PER_KEY = 5;

export function snapshotFrom(offer: FlightOffer, query: NormalizedQuery, extra: { queriedAt: string; link: string; match: FlightSnapshot['match']; itemId?: string | undefined }): FlightSnapshot {
  return {
    source: 'google-flights',
    level: 'quote',
    queriedAt: extra.queriedAt,
    ...(extra.itemId ? { itemId: extra.itemId } : {}),
    route: { from: query.from, to: query.to },
    dates: { depart: query.date, ...(query.returnDate ? { return: query.returnDate } : {}) },
    tripType: query.returnDate ? 'round-trip' : 'one-way',
    cabin: query.cabin,
    passengers: { adults: query.adults, children: query.children },
    currency: query.currency,
    price: offer.price,
    airlines: offer.airlines,
    flightNos: offer.flightNos,
    stops: offer.stops,
    layovers: offer.layovers.map((l) => l.airport),
    durationMin: offer.durationMin,
    depart: offer.depart,
    arrive: offer.arrive,
    arriveDayOffset: offer.arriveDayOffset,
    link: extra.link,
    label: SNAPSHOT_LABEL,
    match: extra.match,
  };
}

const keyOf = (s: FlightSnapshot) =>
  [s.itemId ?? '', s.route.from, s.route.to, s.dates.depart, s.dates.return ?? '', s.cabin, s.passengers.adults, s.passengers.children, s.currency].join('|');

export const snapshotFile = (root: string, tripId: string) => path.join(root, 'trips', tripId, 'prices', 'flights.json');

export function readSnapshots(root: string, tripId: string): FlightSnapshot[] {
  const d = readJson(snapshotFile(root, tripId)) as { snapshots?: unknown } | null;
  return Array.isArray(d?.snapshots) ? (d.snapshots as FlightSnapshot[]) : [];
}

/** Adds snapshots; for each search keeps the newest few so a price going up or down is visible. */
export function saveSnapshots(root: string, tripId: string, fresh: FlightSnapshot[]): FlightSnapshot[] {
  const all = [...readSnapshots(root, tripId), ...fresh];
  const byKey = new Map<string, FlightSnapshot[]>();
  for (const s of all) byKey.set(keyOf(s), [...(byKey.get(keyOf(s)) ?? []), s]);
  const kept = [...byKey.values()].flatMap((group) => group.sort((a, b) => a.queriedAt.localeCompare(b.queriedAt)).slice(-KEEP_PER_KEY));
  atomicWriteJson(snapshotFile(root, tripId), { version: 1, snapshots: kept });
  return kept;
}
