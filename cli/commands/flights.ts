// `tripcode flights …`: flight prices read from Google Flights' public search page (src/prices/). Off unless
// TRIPCODE_FLIGHTS=1: it is an unofficial read of a Google page, which Google's terms do not allow, so it stays a
// personal, low-frequency tool the user switches on knowingly. Every price is a dated snapshot labelled
// "Google 顯示價，訂票前以官方為準"; nothing here books or pays, and nothing changes trip.ts.
import { access } from 'node:fs/promises';
import path from 'node:path';
import { CliError, checkFileName, checkTripId, printJson } from '../context.ts';
import type { CliContext } from '../context.ts';
import { createFlightsClient, dateRange, firstPass, neighbours } from '../../src/prices/flights-client.ts';
import type { DatePrice, FlightsClient, FlightsClientOptions } from '../../src/prices/flights-client.ts';
import { FlightsFetchError } from '../../src/prices/flights-fetch.ts';
import { FlightsShapeError } from '../../src/prices/flights-parse.ts';
import type { FlightOffer } from '../../src/prices/flights-parse.ts';
import { readState, saveSnapshots, SNAPSHOT_LABEL, snapshotFile, snapshotFrom } from '../../src/prices/flights-store.ts';
import type { FlightSnapshot } from '../../src/prices/flights-store.ts';
import { CABINS, FlightsInputError, normalizeQuery } from '../../src/prices/flights-url.ts';
import type { Cabin, FlightQuery } from '../../src/prices/flights-url.ts';
import type { Item, Trip } from '../../src/core/types.ts';

/** What the command may be given beyond a normal CLI context (tests inject these). */
export interface FlightsContext extends CliContext {
  flights?: Pick<FlightsClientOptions, 'fetch' | 'sleep'>;
}

export const FLIGHTS_USAGE = `用法：tripcode flights <子指令>（預設輸出 JSON；加 --pretty 輸出易讀格式）

  quote <FROM> <TO> <YYYY-MM-DD> [--return YYYY-MM-DD] [--stops 0|1|2] [--cabin economy|premium|business|first]
        [--adults N] [--children N] [--currency TWD] [--fresh] [--max 8]   查一天的航班，最便宜的排前面
        （加 --return 是來回：價格是整趟來回的總價）
  dates <FROM> <TO> --from YYYY-MM-DD --to YYYY-MM-DD [--step 3] [同上的 --stops/--cabin/--adults/--children/--currency]
        哪天出發最便宜（單程）；最多 14 天，8 天以上先每 --step 天抽樣、再補最便宜那天的前後一天；只列真正查過的日期
  trip <tripId> [--file variant-b.ts] [--all] [--save] [--currency TWD]
        查這趟行程裡的航班（要有 from / to 機場代碼和出發時間）；已訂的預設跳過（--all 才查）；--save 把報價寫到 trips/<id>/prices/flights.json
  status                                                      是否啟用、暫停到什麼時候

預設關閉。這是讀 Google Flights 公開頁面的非官方做法，違反 Google 的使用條款，只適合個人、低頻使用，Google 改版就會失效。
要啟用：在專案根目錄的 .env（沒有就建立一個）加一行 TRIPCODE_FLIGHTS=1。價格是 Google 顯示的價格，訂票前以官方為準；TripCode 不付款。
`;

const NOTICE = '（機票價格來自 Google Flights 公開頁面的非官方讀取，僅供參考，訂票前以官方為準）\n';

interface Args {
  pos: string[];
  flags: Record<string, string | true>;
}

const VALUE = new Set(['return', 'stops', 'cabin', 'adults', 'children', 'currency', 'max', 'from', 'to', 'step', 'file']);
const BOOL = new Set(['pretty', 'fresh', 'save', 'all', 'help']);

function parse(argv: string[]): Args {
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) {
      pos.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
    if (BOOL.has(name)) flags[name] = true;
    else if (VALUE.has(name)) {
      const v = eq === -1 ? argv[++i] : a.slice(eq + 1);
      if (v === undefined || v === '') throw new CliError(`--${name} 需要一個值`);
      flags[name] = v;
    } else throw new CliError(`未知的選項：--${name}`);
  }
  return { pos, flags };
}

const str = (a: Args, name: string): string | undefined => (typeof a.flags[name] === 'string' ? (a.flags[name] as string) : undefined);

function num(a: Args, name: string): number | undefined {
  const v = str(a, name);
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v)) throw new CliError(`--${name} 要是整數：${v}`);
  return Number(v);
}

function cabinOf(a: Args): Cabin | undefined {
  const v = str(a, 'cabin');
  if (v === undefined) return undefined;
  if (!(v in CABINS)) throw new CliError(`--cabin 只能是 economy、premium、business 或 first：${v}`);
  return v as Cabin;
}

function stopsOf(a: Args): 0 | 1 | 2 | undefined {
  const v = num(a, 'stops');
  if (v === undefined) return undefined;
  if (v !== 0 && v !== 1 && v !== 2) throw new CliError('--stops 只能是 0、1 或 2');
  return v;
}

/** Shared search options as a query base. */
function baseQuery(a: Args): Omit<FlightQuery, 'from' | 'to' | 'date'> {
  return { stops: stopsOf(a), cabin: cabinOf(a), adults: num(a, 'adults'), children: num(a, 'children'), currency: str(a, 'currency') };
}

function enabled(ctx: CliContext): boolean {
  return ctx.env.TRIPCODE_FLIGHTS?.trim() === '1';
}

function requireEnabled(ctx: CliContext): void {
  if (!enabled(ctx)) {
    throw new CliError('機票查價預設關閉。它讀 Google Flights 的公開頁面，這是非官方做法、違反 Google 的使用條款，只適合個人低頻使用，而且 Google 改版就會失效。\n要啟用：在專案根目錄的 .env（沒有就建立一個）加一行 TRIPCODE_FLIGHTS=1，再重新執行；常駐服務要再 `npm run tripcode -- service restart`。');
  }
}

function explain(err: unknown): never {
  if (err instanceof FlightsInputError) throw new CliError(err.message);
  if (err instanceof FlightsFetchError) throw new CliError(err.message);
  if (err instanceof FlightsShapeError) throw new CliError(`${err.message}。這通常是 Google 改了頁面；請回報，並先用 Google Flights 網頁查價。`);
  throw err;
}

// ---------- output ----------

const money = (currency: string, price: number) => `${currency} ${price.toLocaleString('en-US')}`;
const hm = (min: number) => `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}`;

function offerLine(o: FlightOffer, currency: string): string {
  const layover = o.layovers.length > 0 ? `，轉 ${o.stops} 次（${o.layovers.map((l) => `${l.airport} ${hm(l.minutes)}`).join('、')}）` : o.stops === 0 ? '，直飛' : `，轉 ${o.stops} 次`;
  const next = o.arriveDayOffset > 0 ? ` +${o.arriveDayOffset}` : '';
  return `  ${money(currency, o.price).padEnd(14)}${o.airlines.join(' / ')}  ${o.flightNos.join('+')}  ${o.depart} → ${o.arrive}${next}  ${hm(o.durationMin)}${layover}`;
}

// ---------- commands ----------

async function quoteCommand(ctx: FlightsContext, a: Args, client: FlightsClient): Promise<number> {
  const [, from, to, date] = a.pos;
  if (!from || !to || !date) throw new CliError('用法：flights quote <FROM> <TO> <YYYY-MM-DD>，例如：flights quote TPE BCN 2027-03-10');
  const max = num(a, 'max') ?? 8;
  const result = await client.quote({ from, to, date, returnDate: str(a, 'return'), ...baseQuery(a) }, { fresh: a.flags.fresh === true }).catch(explain);
  const q = result.query;
  const shown = result.offers.slice(0, max);
  if (!a.flags.pretty) {
    printJson(ctx, {
      query: q,
      queriedAt: result.queriedAt,
      fromCache: result.fromCache,
      label: SNAPSHOT_LABEL,
      priceMeans: q.returnDate ? '整趟來回的總價' : '單程',
      link: result.link,
      unpriced: result.unpriced,
      offers: shown,
    });
    return 0;
  }
  const trip = q.returnDate ? `來回 ${q.date} ~ ${q.returnDate}（價格是整趟來回）` : `單程 ${q.date}`;
  const lines = [`${q.from} → ${q.to}  ${trip}  ${q.adults} 位大人${q.children ? `、${q.children} 位兒童` : ''}  ${q.cabin}  ${q.currency}`, `查詢於 ${result.queriedAt}${result.fromCache ? '（24 小時內的快取）' : ''}`, ''];
  lines.push(...(shown.length > 0 ? shown.map((o) => offerLine(o, q.currency)) : ['  沒有查到航班（這天可能沒有班機，或 Google 沒有列價）']));
  if (result.unpriced > 0) lines.push(`  （另有 ${result.unpriced} 筆 Google 沒有列價）`);
  lines.push('', `Google Flights：${result.link}`, SNAPSHOT_LABEL);
  ctx.stdout(`${lines.join('\n')}\n`);
  return 0;
}

async function datesCommand(ctx: FlightsContext, a: Args, client: FlightsClient): Promise<number> {
  const [, from, to] = a.pos;
  const first = str(a, 'from');
  const last = str(a, 'to');
  if (!from || !to || !first || !last) throw new CliError('用法：flights dates <FROM> <TO> --from YYYY-MM-DD --to YYYY-MM-DD');
  let range: string[];
  try {
    range = dateRange(first, last);
  } catch (e) {
    throw new CliError(e instanceof Error ? e.message : String(e));
  }
  const base = { from, to, ...baseQuery(a) };
  try {
    normalizeQuery({ ...base, date: range[0]! }, ctx.now()); // bad airports or options are one clear error, not one per date
  } catch (e) {
    explain(e);
  }
  const priced: DatePrice[] = await client.pricesFor(base, firstPass(range, num(a, 'step') ?? 3));
  const stopped = priced.find((p) => p.error);
  if (!stopped) priced.push(...(await client.pricesFor(base, neighbours(range, priced))));
  priced.sort((x, y) => x.date.localeCompare(y.date));
  const best = priced.filter((p) => p.cheapest).sort((x, y) => x.cheapest!.price - y.cheapest!.price)[0];
  const currency = (base.currency ?? 'TWD').toUpperCase();
  const rows = priced.map((p) => ({
    date: p.date,
    price: p.cheapest?.price ?? null,
    ...(p.cheapest ? { airlines: p.cheapest.airlines, flightNos: p.cheapest.flightNos, stops: p.cheapest.stops, depart: p.cheapest.depart, arrive: p.cheapest.arrive, durationMin: p.cheapest.durationMin } : {}),
    ...(p.error ? { error: p.error } : {}),
  }));
  if (!a.flags.pretty) {
    printJson(ctx, { route: { from: from.toUpperCase(), to: to.toUpperCase() }, currency, label: SNAPSHOT_LABEL, note: '只列真正查過的日期，沒有推算其他日期；每天列的是當天最便宜的一個航班（單程）', cheapest: best ? { date: best.date, price: best.cheapest!.price } : null, checkedDates: priced.length, results: rows });
    return stopped ? 1 : 0;
  }
  const lines = [`${from.toUpperCase()} → ${to.toUpperCase()}  單程  ${first} ~ ${last}  ${currency}（查了 ${priced.length} 天，沒查的日期不推算）`, ''];
  for (const p of priced) {
    lines.push(p.cheapest ? `  ${p.date}  ${money(currency, p.cheapest.price).padEnd(14)}${p.cheapest.airlines.join(' / ')}  ${p.cheapest.flightNos.join('+')}  ${p.cheapest.depart} → ${p.cheapest.arrive}` : `  ${p.date}  ${p.error ? `失敗：${p.error}` : '沒有查到航班'}`);
  }
  if (best) lines.push('', `最便宜：${best.date}  ${money(currency, best.cheapest!.price)}`);
  lines.push(SNAPSHOT_LABEL);
  ctx.stdout(`${lines.join('\n')}\n`);
  return stopped ? 1 : 0;
}

type FlightItem = Extract<Item, { kind: 'flight' }>;

interface TripFlight {
  item: FlightItem;
  date: string | null;
  skip: 'no-airports' | 'departure-date-unknown' | 'already-booked' | 'past' | null;
}

export function tripFlights(trip: Trip, opts: { all: boolean; today: string }): TripFlight[] {
  const out: TripFlight[] = [];
  for (const day of trip.days) {
    for (const item of day.items) {
      if (item.kind !== 'flight') continue;
      let skip: TripFlight['skip'] = null;
      const date = item.start ? day.date : null;
      if (!/^[A-Z]{3}$/.test(item.from ?? '') || !/^[A-Z]{3}$/.test(item.to ?? '')) skip = 'no-airports';
      else if (!date) skip = 'departure-date-unknown';
      else if (!opts.all && (item.booking?.status === 'booked' || item.booking?.bookedAt)) skip = 'already-booked';
      else if (date < opts.today) skip = 'past';
      out.push({ item, date, skip });
    }
  }
  return out;
}

function flightCode(flightNo: string): string | null {
  const m = /\b([A-Z0-9]{2})\s?(\d{1,4}[A-Z]?)\b/.exec(flightNo.toUpperCase());
  return m ? `${m[1]}${m[2]}` : null;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

const MAX_TRIP_QUERIES = 10;

async function tripCommand(ctx: FlightsContext, a: Args, client: FlightsClient): Promise<number> {
  const tripId = checkTripId(a.pos[1]);
  const file = checkFileName(str(a, 'file'));
  const p = path.join(ctx.root, 'trips', tripId, file);
  if (!(await exists(p))) throw new CliError(`找不到行程檔：trips/${tripId}/${file}`);
  let trip: Trip;
  try {
    trip = await ctx.loadTrip(p);
  } catch (e) {
    throw new CliError(`無法載入 trips/${tripId}/${file}：${e instanceof Error ? e.message : String(e)}`);
  }
  const today = ctx.now().toISOString().slice(0, 10);
  const flights = tripFlights(trip, { all: a.flags.all === true, today });
  const currency = str(a, 'currency');
  const results: Record<string, unknown>[] = [];
  const snapshots: FlightSnapshot[] = [];
  let queried = 0;
  let stopped: string | null = null;
  for (const f of flights) {
    const base = { itemId: f.item.id, title: f.item.title, route: `${f.item.from ?? '?'}→${f.item.to ?? '?'}`, date: f.date };
    if (f.skip) {
      results.push({ ...base, status: 'skipped', reason: f.skip });
      continue;
    }
    if (stopped || queried >= MAX_TRIP_QUERIES) {
      results.push({ ...base, status: 'skipped', reason: stopped ? 'stopped' : 'limit' });
      continue;
    }
    queried++;
    try {
      const r = await client.quote({ from: f.item.from!, to: f.item.to!, date: f.date!, adults: trip.party.adults, children: trip.party.childrenAges.length, currency });
      const code = flightCode(f.item.flightNo);
      const same = code ? r.offers.find((o) => o.flightNos.includes(code)) : undefined;
      const chosen = same ?? r.offers[0];
      if (!chosen) {
        results.push({ ...base, status: 'no-offers', link: r.link });
        continue;
      }
      const snapshot = snapshotFrom(chosen, r.query, { queriedAt: r.queriedAt, link: r.link, match: same ? 'same-flight' : 'cheapest', itemId: f.item.id });
      snapshots.push(snapshot);
      results.push({ ...base, status: 'quoted', fromCache: r.fromCache, snapshot, otherOffers: r.offers.filter((o) => o !== chosen).slice(0, 2) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ ...base, status: 'error', error: message });
      if (err instanceof FlightsFetchError) stopped = message;
    }
  }
  if (a.flags.save && snapshots.length > 0) saveSnapshots(ctx.root, tripId, snapshots);
  if (!a.flags.pretty) {
    printJson(ctx, { tripId, saved: a.flags.save === true && snapshots.length > 0 ? snapshotFile(ctx.root, tripId).slice(ctx.root.length + 1) : null, label: SNAPSHOT_LABEL, flights: results });
    return stopped ? 1 : 0;
  }
  const lines = [`${trip.title}（${tripId}）的航班報價`, ''];
  for (const r of results) {
    const head = `  ${String(r.route).padEnd(10)} ${r.date ?? '日期不明'}  ${r.title}`;
    if (r.status === 'quoted') {
      const s = r.snapshot as FlightSnapshot;
      lines.push(`${head}`, `    ${money(s.currency, s.price)}  ${s.airlines.join(' / ')} ${s.flightNos.join('+')}  ${s.depart} → ${s.arrive}${s.arriveDayOffset ? ` +${s.arriveDayOffset}` : ''}  ${s.match === 'same-flight' ? '（就是這班）' : '（最便宜的一班，不是你的航班號）'}`);
    } else lines.push(`${head}`, `    ${r.status === 'skipped' ? `略過：${r.reason}` : r.status === 'error' ? `失敗：${r.error}` : '沒有查到航班'}`);
  }
  if (a.flags.save && snapshots.length > 0) lines.push('', `已寫入 ${snapshotFile(ctx.root, tripId).slice(ctx.root.length + 1)}`);
  lines.push('', SNAPSHOT_LABEL);
  ctx.stdout(`${lines.join('\n')}\n`);
  return stopped ? 1 : 0;
}

function statusCommand(ctx: FlightsContext, a: Args): number {
  const state = readState(ctx.root);
  const now = ctx.now().getTime();
  const paused = state.openUntil !== null && state.openUntil > now;
  const info = { enabled: enabled(ctx), paused, pausedUntil: paused ? new Date(state.openUntil!).toISOString() : null, recentFailures: state.failures, lastRequestAt: state.lastRequestAt ? new Date(state.lastRequestAt).toISOString() : null };
  if (!a.flags.pretty) printJson(ctx, info);
  else ctx.stdout(`機票查價：${info.enabled ? '已啟用' : '關閉（.env 加 TRIPCODE_FLIGHTS=1 啟用）'}\n${paused ? `暫停到 ${info.pausedUntil}\n` : ''}最近連續失敗：${info.recentFailures} 次\n`);
  return 0;
}

export async function flightsCommand(ctx: FlightsContext, argv: string[]): Promise<number> {
  const a = parse(argv);
  const cmd = a.pos[0];
  if (!cmd || a.flags.help) {
    ctx.stdout(FLIGHTS_USAGE);
    return cmd || a.flags.help ? 0 : 1;
  }
  if (cmd === 'status') return statusCommand(ctx, a);
  if (cmd !== 'quote' && cmd !== 'dates' && cmd !== 'trip') throw new CliError(`未知的子指令：flights ${cmd}\n\n${FLIGHTS_USAGE}`);
  requireEnabled(ctx);
  ctx.stderr(NOTICE);
  const client = createFlightsClient({ root: ctx.root, now: () => ctx.now().getTime(), ...ctx.flights });
  if (cmd === 'quote') return quoteCommand(ctx, a, client);
  if (cmd === 'dates') return datesCommand(ctx, a, client);
  return tripCommand(ctx, a, client);
}
