// Reads flight offers out of a Google Flights search page. The page inlines its results as JSON inside
//   AF_initDataCallback({key: 'ds:1', hash: '..', data:[...], sideChannel: {}});
// The layout (positions in nested arrays) is Google's and changes without notice, so every position TripCode reads is
// named once in IDX below, every value is checked before it is kept, and a surprise is a FlightsShapeError that says
// where, never a half-right price. Nothing here evaluates the page: the data is cut out as text and JSON.parse'd.
//
// Layout credit: reverse-engineered by the open-source `fli` project (MIT, punitarani/fli).
import type { NormalizedQuery } from './flights-url.ts';

export class FlightsShapeError extends Error {
  readonly path: string;
  constructor(path: string, detail: string) {
    super(`Google Flights 頁面的格式和預期不同（${path}：${detail}）`);
    this.name = 'FlightsShapeError';
    this.path = path;
  }
}

/** Positions inside one result row. */
const IDX = {
  /** data[ROWS] each hold a list of rows. */
  rowBlocks: [2, 3],
  flight: 0,
  price: 1,
  f: { code: 0, names: 1, segments: 2, from: 3, date: 4, depart: 5, to: 6, arrDate: 7, arrive: 8, duration: 9, layovers: 13 },
  seg: { flight: 22 },
} as const;

/** The largest page we are willing to look at (a real one is about 2.4 MB). */
export const MAX_PAGE_CHARS = 6_000_000;

export interface FlightOffer {
  /** Whole currency units, in the currency of the query. A round-trip query prices the whole round trip. */
  price: number;
  /** Display names, e.g. ["Etihad"]. */
  airlines: string[];
  /** "EY899", one per flight. */
  flightNos: string[];
  from: string;
  to: string;
  departDate: string;
  /** HH:MM, local time at the airport. */
  depart: string;
  arrive: string;
  /** 0 = same day, 1 = next day. */
  arriveDayOffset: number;
  durationMin: number;
  stops: number;
  layovers: { airport: string; minutes: number }[];
}

export interface ParsedPage {
  offers: FlightOffer[];
  /** Rows Google listed without a price (sold out, or "see price on site"). */
  unpriced: number;
  /** Rows for another airport or date than we asked for. */
  other: number;
}

/** The `data:` array of the `ds:1` block, or null when the page has none (blocked, consent page, new layout). */
export function extractDs1(html: string): unknown | null {
  if (html.length > MAX_PAGE_CHARS) throw new FlightsShapeError('page', '頁面比預期大很多');
  const key = html.indexOf("key: 'ds:1'");
  if (key === -1) return null;
  const start = html.indexOf('data:', key);
  const end = start === -1 ? -1 : html.indexOf(', sideChannel', start);
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(html.slice(start + 5, end));
  } catch {
    throw new FlightsShapeError('ds:1', 'JSON 解析失敗');
  }
}

// ---------- checked reads ----------

function list(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new FlightsShapeError(path, '應該是陣列');
  return value;
}

function text(value: unknown, path: string, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new FlightsShapeError(path, `不是預期的文字（${JSON.stringify(value)?.slice(0, 30)}）`);
  return value;
}

function int(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new FlightsShapeError(path, `不是 ${min}–${max} 的整數（${JSON.stringify(value)?.slice(0, 30)}）`);
  }
  return value;
}

/** [y, m, d] as YYYY-MM-DD. */
function dateOf(value: unknown, path: string): string {
  const [y, m, d] = list(value, path);
  const year = int(y, `${path}[0]`, 2000, 2100);
  const month = int(m, `${path}[1]`, 1, 12);
  const day = int(d, `${path}[2]`, 1, 31);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** [h, m] where a zero is left out: [23] is 23:00, [null, 30] is 00:30. */
function timeOf(value: unknown, path: string): string {
  const [h, m] = list(value, path);
  const hour = h == null ? 0 : int(h, `${path}[0]`, 0, 23);
  const minute = m == null ? 0 : int(m, `${path}[1]`, 0, 59);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** Names come from Google's page: keep letters, digits and a few marks, and a short length, so one can never carry markup or instructions. */
function cleanName(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new FlightsShapeError(path, '應該是文字');
  const cleaned = value.replace(/[^\p{L}\p{N} .,&'’()\-]/gu, '').trim().slice(0, 40);
  if (!cleaned) throw new FlightsShapeError(path, '名稱是空的');
  return cleaned;
}

function dayNumber(date: string): number {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
}

function parseRow(row: unknown, path: string): { offer: FlightOffer } | { unpriced: true } {
  const parts = list(row, path);
  const f = list(parts[IDX.flight], `${path}[0]`);
  // The price sits at row[1][0][1]; a row without one (sold out) is skipped, not guessed.
  const priceBox = Array.isArray(parts[IDX.price]) ? (parts[IDX.price] as unknown[])[0] : undefined;
  const rawPrice = Array.isArray(priceBox) ? priceBox[1] : undefined;
  if (rawPrice == null) return { unpriced: true };
  const price = int(rawPrice, `${path}[1][0][1]`, 1, 100_000_000);

  const names = list(f[IDX.f.names], `${path}[0][1]`).map((n, i) => cleanName(n, `${path}[0][1][${i}]`));
  const segments = list(f[IDX.f.segments], `${path}[0][2]`);
  if (segments.length === 0 || segments.length > 6) throw new FlightsShapeError(`${path}[0][2]`, '航段數不合理');
  const flightNos = segments.map((seg, i) => {
    const info = list(list(seg, `${path}[0][2][${i}]`)[IDX.seg.flight], `${path}[0][2][${i}][22]`);
    return text(info[0], `${path}[0][2][${i}][22][0]`, /^[A-Z0-9]{2}$/) + text(info[1], `${path}[0][2][${i}][22][1]`, /^\d{1,4}[A-Z]?$/);
  });

  const departDate = dateOf(f[IDX.f.date], `${path}[0][4]`);
  const arriveDate = dateOf(f[IDX.f.arrDate], `${path}[0][7]`);
  const layovers = (Array.isArray(f[IDX.f.layovers]) ? (f[IDX.f.layovers] as unknown[]) : []).map((l, i) => {
    const entry = list(l, `${path}[0][13][${i}]`);
    return { minutes: int(entry[0], `${path}[0][13][${i}][0]`, 0, 3000), airport: text(entry[1], `${path}[0][13][${i}][1]`, /^[A-Z]{3}$/) };
  });

  return {
    offer: {
      price,
      airlines: names,
      flightNos,
      from: text(f[IDX.f.from], `${path}[0][3]`, /^[A-Z]{3}$/),
      to: text(f[IDX.f.to], `${path}[0][6]`, /^[A-Z]{3}$/),
      departDate,
      depart: timeOf(f[IDX.f.depart], `${path}[0][5]`),
      arrive: timeOf(f[IDX.f.arrive], `${path}[0][8]`),
      arriveDayOffset: int(dayNumber(arriveDate) - dayNumber(departDate), `${path}[0][7]`, 0, 3),
      durationMin: int(f[IDX.f.duration], `${path}[0][9]`, 1, 5000),
      stops: segments.length - 1,
      layovers,
    },
  };
}

/** Parses the `data:` array of ds:1 into offers for this query. */
export function parseFlights(data: unknown, query: NormalizedQuery): ParsedPage {
  const top = list(data, 'ds:1');
  const offers: FlightOffer[] = [];
  let unpriced = 0;
  let other = 0;
  for (const block of IDX.rowBlocks) {
    const holder = top[block];
    if (holder == null) continue;
    const rows = list(holder, `ds:1[${block}]`)[0];
    if (rows == null) continue;
    list(rows, `ds:1[${block}][0]`).forEach((row, i) => {
      const parsed = parseRow(row, `ds:1[${block}][0][${i}]`);
      if ('unpriced' in parsed) {
        unpriced++;
        return;
      }
      const { offer } = parsed;
      // A page for another airport or date than we asked for must not be mistaken for the answer.
      if (offer.from !== query.from || offer.to !== query.to || offer.departDate !== query.date) {
        other++;
        return;
      }
      offers.push(offer);
    });
  }
  if (offers.length === 0 && other > 0) throw new FlightsShapeError('query', `頁面上的航班都不是 ${query.from}→${query.to} ${query.date}`);
  return { offers: offers.sort((a, b) => a.price - b.price), unpriced, other };
}
