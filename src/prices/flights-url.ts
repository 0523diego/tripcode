// Google Flights search URLs, built without any dependency. The search page is addressed by a `tfs` query parameter:
// a small protobuf (trip type, one segment per direction, passengers, cabin) in URL-safe base64. The field layout was
// reverse-engineered by the open-source `fli` project (MIT, punitarani/fli, src/search/proto.ts); only what TripCode
// needs is kept here: airports, dates, one-way or round trip, stop limit, cabin and passenger counts.
//
// Every input is validated before it gets near a URL, so nothing a trip file or an AI message contains can change
// where the request goes: airport codes are three capital letters, dates are real calendar dates, the rest are
// small integers from fixed lists.

export class FlightsInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlightsInputError';
  }
}

export const CABINS = { economy: 1, premium: 2, business: 3, first: 4 } as const;
export type Cabin = keyof typeof CABINS;

/** How far ahead Google sells seats; a date beyond this only returns an empty page. */
export const MAX_DAYS_AHEAD = 330;

export interface FlightQuery {
  from: string;
  to: string;
  /** Departure date, YYYY-MM-DD. */
  date: string;
  /** Return date for a round trip. */
  returnDate?: string | undefined;
  /** Most stops allowed: 0 = nonstop only. Absent = any. */
  stops?: 0 | 1 | 2 | undefined;
  cabin?: Cabin | undefined;
  adults?: number | undefined;
  children?: number | undefined;
  /** ISO 4217, e.g. TWD. */
  currency?: string | undefined;
}

export interface NormalizedQuery {
  from: string;
  to: string;
  date: string;
  returnDate: string | null;
  stops: 0 | 1 | 2 | null;
  cabin: Cabin;
  adults: number;
  children: number;
  currency: string;
}

const IATA_RE = /^[A-Z]{3}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function utcDay(date: string, label: string): number {
  const m = DATE_RE.exec(date);
  if (!m) throw new FlightsInputError(`${label}要是 YYYY-MM-DD 格式：${JSON.stringify(date).slice(0, 40)}`);
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const back = new Date(ms).toISOString().slice(0, 10);
  if (back !== date) throw new FlightsInputError(`${label}不是真的日期：${date}`);
  return Math.floor(ms / DAY_MS);
}

function airport(value: string, label: string): string {
  const code = String(value ?? '').trim().toUpperCase();
  if (!IATA_RE.test(code)) throw new FlightsInputError(`${label}要是三個英文字母的機場代碼（例如 TPE、BCN）`);
  return code;
}

function count(value: number | undefined, fallback: number, min: number, max: number, label: string): number {
  const n = value ?? fallback;
  if (!Number.isInteger(n) || n < min || n > max) throw new FlightsInputError(`${label}要是 ${min} 到 ${max} 的整數`);
  return n;
}

/** Validates a query and fills the defaults. `now` is injectable for tests. */
export function normalizeQuery(query: FlightQuery, now: Date = new Date()): NormalizedQuery {
  const from = airport(query.from, '出發機場');
  const to = airport(query.to, '抵達機場');
  if (from === to) throw new FlightsInputError('出發和抵達不能是同一個機場');
  const today = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / DAY_MS);
  const day = utcDay(query.date, '出發日期');
  if (day < today) throw new FlightsInputError(`出發日期已經過了：${query.date}`);
  if (day > today + MAX_DAYS_AHEAD) throw new FlightsInputError(`出發日期太遠（Google 只賣約 ${MAX_DAYS_AHEAD} 天內的機票）：${query.date}`);
  let returnDate: string | null = null;
  if (query.returnDate !== undefined) {
    const back = utcDay(query.returnDate, '回程日期');
    if (back < day) throw new FlightsInputError('回程日期不能早於出發日期');
    if (back > today + MAX_DAYS_AHEAD) throw new FlightsInputError(`回程日期太遠：${query.returnDate}`);
    returnDate = query.returnDate;
  }
  if (query.stops !== undefined && ![0, 1, 2].includes(query.stops)) throw new FlightsInputError('轉機次數只能是 0、1 或 2');
  const cabin = query.cabin ?? 'economy';
  if (!(cabin in CABINS)) throw new FlightsInputError('艙等只能是 economy、premium、business 或 first');
  const adults = count(query.adults, 1, 1, 9, '大人人數');
  const children = count(query.children, 0, 0, 8, '兒童人數');
  if (adults + children > 9) throw new FlightsInputError('一次最多查 9 位乘客');
  const currency = String(query.currency ?? 'TWD').trim().toUpperCase();
  if (!CURRENCY_RE.test(currency)) throw new FlightsInputError('幣別要是三個英文字母（例如 TWD、EUR）');
  return { from, to, date: query.date, returnDate, stops: query.stops ?? null, cabin, adults, children, currency };
}

// ---------- the tfs protobuf ----------

const utf8 = new TextEncoder();

function varint(value: number): number[] {
  const out: number[] = [];
  let v = value;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return out;
}

const tag = (field: number, wire: number) => varint(field * 8 + wire);
const varintField = (field: number, value: number): number[] => [...tag(field, 0), ...varint(value)];
function lengthDelim(field: number, payload: ArrayLike<number>): number[] {
  return [...tag(field, 2), ...varint(payload.length), ...Array.from(payload)];
}

function segment(from: string, to: string, date: string, stops: number | null): number[] {
  const body = [
    ...lengthDelim(2, utf8.encode(date)),
    ...(stops !== null ? varintField(5, stops) : []),
    ...lengthDelim(13, [...varintField(1, 1), ...lengthDelim(2, utf8.encode(from))]),
    ...lengthDelim(14, [...varintField(1, 1), ...lengthDelim(2, utf8.encode(to))]),
  ];
  return lengthDelim(3, body);
}

function toUrlSafeBase64(bytes: number[]): string {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The `tfs` value for a validated query. */
export function buildTfs(q: NormalizedQuery): string {
  const segments = [...segment(q.from, q.to, q.date, q.stops)];
  if (q.returnDate) segments.push(...segment(q.to, q.from, q.returnDate, q.stops));
  const passengers = [...Array.from({ length: q.adults }, () => 1), ...Array.from({ length: q.children }, () => 2)];
  const bytes = [
    ...varintField(1, 28),
    ...varintField(2, 2),
    ...segments,
    ...passengers.flatMap((kind) => varintField(8, kind)),
    ...varintField(9, CABINS[q.cabin]),
    ...varintField(14, 1),
    ...varintField(19, q.returnDate ? 1 : 2),
  ];
  return toUrlSafeBase64(bytes);
}

const PAGE = 'https://www.google.com/travel/flights';

/** The page the fetcher reads (English, so airline names are stable). */
export function searchUrl(q: NormalizedQuery): string {
  return `${PAGE}?tfs=${buildTfs(q)}&hl=en&curr=${q.currency}`;
}

/** The same search as a link a person can open and book from. */
export function deepLink(q: NormalizedQuery): string {
  return `${PAGE}?tfs=${buildTfs(q)}&hl=zh-TW&curr=${q.currency}`;
}
