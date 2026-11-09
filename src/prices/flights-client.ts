// Ties the pieces together: validate the query, answer from the 24 h cache when it can, otherwise (if the circuit
// breaker allows it, and no sooner than 2 s after the last request) fetch the page, parse it, remember the answer.
import { FlightsFetchError, fetchPage } from './flights-fetch.ts';
import type { FetchFn } from './flights-fetch.ts';
import { extractDs1, FlightsShapeError, parseFlights } from './flights-parse.ts';
import type { FlightOffer } from './flights-parse.ts';
import { BREAKER_FAILURES, HARD_PAUSE_MS, readCache, readState, SOFT_PAUSE_MS, writeCache, writeState } from './flights-store.ts';
import { deepLink, normalizeQuery, searchUrl } from './flights-url.ts';
import type { FlightQuery, NormalizedQuery } from './flights-url.ts';

/** At least this long between two requests to Google, across runs. */
export const MIN_GAP_MS = 2000;
/** Dates one `dates` search may price. */
export const MAX_DATES = 14;

export interface FlightsClientOptions {
  /** Repo root: the cache and breaker live under node_modules/.tripcode/flights/. */
  root: string;
  fetch?: FetchFn;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface QuoteResult {
  query: NormalizedQuery;
  queriedAt: string;
  fromCache: boolean;
  /** Cheapest first. */
  offers: FlightOffer[];
  unpriced: number;
  /** A Google Flights link for the same search, to open and book from. */
  link: string;
}

export interface DatePrice {
  date: string;
  /** The cheapest offer that day, or null when there was none or the lookup failed. */
  cheapest: FlightOffer | null;
  error?: string;
}

const HARD = new Set(['blocked', 'unsupported-client', 'consent-required']);

export function createFlightsClient(options: FlightsClientOptions) {
  const { root } = options;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  function fail(error: FlightsFetchError | FlightsShapeError): never {
    const state = readState(root);
    const hard = error instanceof FlightsFetchError && HARD.has(error.code);
    const failures = state.failures + 1;
    const opens = hard ? HARD_PAUSE_MS : failures >= BREAKER_FAILURES ? SOFT_PAUSE_MS : null;
    writeState(root, { ...state, failures, openUntil: opens ? now() + opens : state.openUntil });
    throw error;
  }

  async function fetchOnce(url: string): Promise<string | null> {
    const state = readState(root);
    if (state.openUntil !== null && now() < state.openUntil) {
      const until = new Date(state.openUntil).toISOString().slice(0, 16).replace('T', ' ');
      throw new FlightsFetchError('breaker-open', `查價暫停到 ${until}（UTC）：前面連續失敗，避免被 Google 封鎖`);
    }
    if (state.lastRequestAt !== null) {
      const wait = state.lastRequestAt + MIN_GAP_MS - now();
      if (wait > 0) await sleep(wait);
    }
    writeState(root, { ...readState(root), lastRequestAt: now() });
    const html = await fetchPage(url, options.fetch);
    return extractDs1(html) === null ? null : html;
  }

  async function quote(query: FlightQuery, opts: { fresh?: boolean } = {}): Promise<QuoteResult> {
    const nq = normalizeQuery(query, new Date(now()));
    const url = searchUrl(nq);
    const link = deepLink(nq);
    if (!opts.fresh) {
      const cached = readCache(root, url, now());
      if (cached) return { query: nq, queriedAt: cached.queriedAt, fromCache: true, offers: cached.offers, unpriced: cached.unpriced, link };
    }
    try {
      // Roughly one page in sixty arrives without its data block and works seconds later: one retry, no more.
      let html = await fetchOnce(url);
      if (html === null) {
        await sleep(MIN_GAP_MS);
        html = await fetchOnce(url);
      }
      if (html === null) throw new FlightsFetchError('no-data', 'Google 回的頁面裡沒有航班資料（可能被擋、同意頁，或頁面改版）');
      const data = extractDs1(html);
      const parsed = parseFlights(data, nq);
      const queriedAt = new Date(now()).toISOString();
      writeCache(root, url, { queriedAt, offers: parsed.offers, unpriced: parsed.unpriced });
      writeState(root, { ...readState(root), failures: 0 });
      return { query: nq, queriedAt, fromCache: false, offers: parsed.offers, unpriced: parsed.unpriced, link };
    } catch (err) {
      if (err instanceof FlightsFetchError && err.code === 'breaker-open') throw err;
      if (err instanceof FlightsFetchError || err instanceof FlightsShapeError) fail(err);
      throw err;
    }
  }

  /** Cheapest offer for each date in the plan, one request per date. A failure on one date stops the sweep. */
  async function pricesFor(base: Omit<FlightQuery, 'date' | 'returnDate'>, dates: string[]): Promise<DatePrice[]> {
    const out: DatePrice[] = [];
    for (const date of dates) {
      try {
        const result = await quote({ ...base, date });
        out.push({ date, cheapest: result.offers[0] ?? null });
      } catch (err) {
        out.push({ date, cheapest: null, error: err instanceof Error ? err.message : String(err) });
        if (err instanceof FlightsFetchError) break; // a block or a pause: do not keep asking
      }
    }
    return out;
  }

  return { quote, pricesFor };
}

export type FlightsClient = ReturnType<typeof createFlightsClient>;

// ---------- finding the cheapest day with few requests ----------

const DAY_MS = 24 * 60 * 60 * 1000;
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** Every date from..to, inclusive. Throws on a range longer than MAX_DATES. */
export function dateRange(from: string, to: string): string[] {
  const span = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
  if (!(span >= 0)) throw new Error('結束日期不能早於開始日期');
  if (span + 1 > MAX_DATES) throw new Error(`一次最多比較 ${MAX_DATES} 天（你給了 ${span + 1} 天）`);
  return Array.from({ length: span + 1 }, (_, i) => addDays(from, i));
}

/**
 * Dates to price first: every day for a short range, otherwise every `step`-th day. A day in between is only priced
 * when it sits next to the cheapest sampled one (see neighbours), which is what keeps a fortnight at 7 requests.
 */
export function firstPass(range: string[], step = 3): string[] {
  if (range.length <= 7 || step <= 1) return range;
  return range.filter((_, i) => i % step === 0);
}

/** The days next to the cheapest one that were not priced yet. */
export function neighbours(range: string[], priced: DatePrice[]): string[] {
  const have = new Set(priced.map((p) => p.date));
  const best = priced.filter((p) => p.cheapest).sort((a, b) => a.cheapest!.price - b.cheapest!.price)[0];
  if (!best) return [];
  const i = range.indexOf(best.date);
  return [range[i - 1], range[i + 1]].filter((d): d is string => d !== undefined && !have.has(d));
}
