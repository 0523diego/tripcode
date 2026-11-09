// Trip health check. Pure: all I/O (live opening hours) is injected via opts.hoursFor.

import type { Day, Issue, Item, OpeningHours, Trip } from './types.ts';
import { isDayColor } from './day-colors.ts';
import { fromMinutes, isIsoDate, tryToMinutes, weekday } from './time.ts';
import { estimateMinutes, haversineKm } from './optimize.ts';
import { windowsFor } from './hours.ts';
import { photoProblem } from './photos.ts';

export interface CheckOptions {
  /** Supplies live opening hours; falls back to `item.hours?.value` when it returns undefined. */
  hoursFor?: (item: Item, day: Day) => OpeningHours | undefined;
}

const WEEKDAY_NAMES = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
/** Minutes a traveler needs after landing before the first activity is realistic. */
const ARRIVAL_BUFFER = 60;
/** Two located stops further apart than this (straight-line transit estimate, minutes) need a transit item between them. */
const NO_TRANSIT_MINUTES = 20;
/** Beyond this straight-line distance (km) no minutes are quoted: the city-speed estimate would be an invented number. */
const ESTIMATE_MAX_KM = 30;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function validFetchedAt(v: unknown): boolean {
  return typeof v === 'string' && v.trim() !== '' && /^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v));
}

/** Every Sourced<T> field an item can carry, with a Traditional Chinese label. */
function sourcedFields(item: Item): [string, unknown][] {
  const out: [string, unknown][] = [];
  const rec = item as unknown as Record<string, unknown>;
  if ('hours' in rec && rec.hours !== undefined) out.push(['營業時間', rec.hours]);
  const booking = rec.booking;
  if (isRecord(booking)) {
    const labels: [string, string][] = [
      ['officialSite', '官方網站'],
      ['bookingUrl', '購票連結'],
      ['timedSlots', '時段票資訊'],
      ['opensAt', '開賣時間'],
      ['opensRule', '開賣規則'],
      ['deadline', '訂票截止時間'],
      ['cancellation', '取消條件'],
    ];
    for (const [key, label] of labels) if (booking[key] !== undefined) out.push([label, booking[key]]);
    if (Array.isArray(booking.sellers)) {
      for (const s of booking.sellers) if (isRecord(s)) out.push([`購買連結（${String(s.name ?? '')}）`, s.link]);
    }
  }
  switch (item.kind) {
    case 'meal':
      if (item.checks?.exists !== undefined) out.push(['餐廳存在', item.checks.exists]);
      if (item.checks?.openAtSlot !== undefined) out.push(['用餐時間有營業', item.checks.openAtSlot]);
      for (const r of item.checks?.recommendedBy ?? []) out.push(['推薦來源', r]);
      break;
    case 'poi':
      if (item.ticket !== undefined) out.push(['門票', item.ticket]);
      break;
    case 'hotel':
      if (item.price !== undefined) out.push(['住宿價格', item.price]);
      break;
    case 'transit':
      if (item.duration !== undefined) out.push(['交通時間', item.duration]);
      if (item.fare !== undefined) out.push(['車資', item.fare]);
      break;
    case 'flight':
      if (item.price !== undefined) out.push(['機票價格', item.price]);
      break;
    default:
      break;
  }
  return out;
}

/** Stops that sit somewhere: not transit, not flights (the `arrival` rule covers those), with coordinates. */
function isLocatedStop(item: Item): item is Item & { loc: NonNullable<Item['loc']> } {
  return item.kind !== 'transit' && item.kind !== 'flight' && item.loc !== undefined;
}

/** Legs that go from one named place to another and are bought as a ticket: they need both ends on the map. */
const TICKET_MODES = new Set(['train', 'bus', 'boat', 'cable-car']);

/**
 * `leg-endpoints`: a ticket leg (a train, bus, boat, cable car or flight) must show where it starts and where it ends.
 * The leg's own `loc` is where it leaves from (the station or airport, not the city); where it arrives is the next
 * located item of the day, so the arrival station or airport is its own item. Without them the map shows one end of the
 * ticket or none, and the printed day does not say where to get off. A leg between two located stops (a metro ride
 * from `routes`) is fine without its own `loc`. An overnight flight's arrival belongs to the next day.
 */
function legEndpoints(day: Day): Issue[] {
  const out: Issue[] = [];
  day.items.forEach((item, i) => {
    const isLeg = item.kind === 'flight' || (item.kind === 'transit' && TICKET_MODES.has(item.mode));
    if (!isLeg) return;
    const startOk = item.loc !== undefined || day.items.slice(0, i).some((o) => o.loc !== undefined);
    const overnight = item.kind === 'flight' && item.start !== undefined && item.end !== undefined && item.end < item.start;
    const endOk = overnight || day.items.slice(i + 1).some((o) => o.loc !== undefined);
    if (!startOk) {
      out.push({ level: 'warn', code: 'leg-endpoints', date: day.date, itemId: item.id, message: `「${item.title}」沒有標出發點：把出發的車站／機場座標填在這個項目的 loc` });
    }
    if (!endOk) {
      out.push({ level: 'warn', code: 'leg-endpoints', date: day.date, itemId: item.id, message: `「${item.title}」沒有標抵達點：在它後面加一個抵達車站／機場的項目（kind 'poi'，要有 loc）` });
    }
  });
  return out;
}

/**
 * `missing-transit`: consecutive located stops of a day with no transit item between them whose straight-line
 * estimate is longer than 20 minutes. The estimate is a reference value (see optimize.ts), never a real timetable.
 * Over 30 km only the distance is stated (no minutes). Pairs with a `locked` item at either end or between are skipped,
 * and a locked item without `loc` (a booked tour) covers every later stop of that day.
 */
function missingTransit(day: Day): Issue[] {
  const out: Issue[] = [];
  let prev: (Item & { loc: NonNullable<Item['loc']> }) | undefined;
  let sawTransit = false;
  // A locked item at either end or in between means the traveller has already booked how to get there.
  let pairLocked = false;
  // A locked item with no location (e.g. a booked day tour) is the transport itself for everything after it that day.
  let booked = false;
  for (const item of day.items) {
    if (item.locked === true) {
      pairLocked = true;
      if (item.loc === undefined && item.kind !== 'transit' && item.kind !== 'hotel' && item.kind !== 'flight') booked = true;
    }
    if (item.kind === 'transit') {
      sawTransit = true;
      continue;
    }
    if (!isLocatedStop(item)) continue;
    if (prev && !sawTransit && !pairLocked && !booked) {
      const km = haversineKm(prev.loc, item.loc);
      if (km > ESTIMATE_MAX_KM) {
        out.push({
          level: 'warn',
          code: 'missing-transit',
          date: day.date,
          itemId: item.id,
          message: `「${prev.title}」到「${item.title}」兩點之間沒有安排交通（直線相距約 ${Math.round(km)} 公里）`,
        });
      } else {
        const minutes = estimateMinutes(prev.loc, item.loc, 'transit');
        if (minutes > NO_TRANSIT_MINUTES) {
          out.push({
            level: 'warn',
            code: 'missing-transit',
            date: day.date,
            itemId: item.id,
            message: `「${prev.title}」到「${item.title}」兩點之間沒有安排交通（直線估算約 ${minutes} 分鐘，僅供參考）`,
          });
        }
      }
    }
    prev = item;
    sawTransit = false;
    pairLocked = item.locked === true;
  }
  return out;
}

/**
 * `day-overload`: known stay time plus estimated travel between located stops is longer than the span from the
 * first to the last timed item. Stays are only counted when known (a start–end window or `minutes` on a poi), and
 * days with fewer than two timed items are skipped, so the rule errs on the side of silence.
 */
function dayOverload(day: Day): Issue[] {
  const startOf = (item: Item): number | undefined => (item.start === undefined ? undefined : tryToMinutes(item.start));
  // Only what lies between the first and the last timed item is weighed against their span.
  const firstIdx = day.items.findIndex((it) => startOf(it) !== undefined);
  let lastIdx = -1;
  day.items.forEach((it, i) => {
    if (startOf(it) !== undefined) lastIdx = i;
  });
  if (firstIdx < 0) return [];
  const items = day.items.slice(firstIdx, lastIdx + 1);
  let first: number | undefined;
  let last: number | undefined;
  let timed = 0;
  let stay = 0;
  for (const item of items) {
    const s = startOf(item);
    if (s === undefined) continue;
    const e = item.end === undefined ? undefined : tryToMinutes(item.end);
    const window = e !== undefined && e >= s ? e - s : undefined;
    const known = window ?? (item.kind === 'poi' && item.minutes !== undefined && item.minutes >= 0 ? item.minutes : 0);
    timed++;
    first = first === undefined ? s : Math.min(first, s);
    last = Math.max(last ?? 0, s + known);
  }
  // Timed windows are merged first so overlapping items (already an `overlap` error) are not counted twice.
  const windows: [number, number][] = [];
  for (const item of items) {
    if (item.kind !== 'poi' && item.kind !== 'meal') continue;
    const s = item.start === undefined ? undefined : tryToMinutes(item.start);
    const e = item.end === undefined ? undefined : tryToMinutes(item.end);
    if (s !== undefined && e !== undefined && e >= s) windows.push([s, e]);
    else if (item.kind === 'poi' && item.minutes !== undefined && item.minutes >= 0) stay += item.minutes;
  }
  windows.sort((a, b) => a[0] - b[0]);
  let mergedEnd = -Infinity;
  for (const [s, e] of windows) {
    stay += Math.max(0, e - Math.max(s, mergedEnd));
    mergedEnd = Math.max(mergedEnd, e);
  }
  if (timed < 2 || first === undefined || last === undefined) return [];

  // A leg with a transit item counts only that item's known duration (a train's real time is not a straight-line
  // guess); a leg without any transit item uses the straight-line estimate.
  let travel = 0;
  let prev: Item | undefined;
  let sawTransit = false;
  let known = 0;
  for (const item of items) {
    if (item.kind === 'transit') {
      sawTransit = true;
      const d = item.duration?.value;
      if (typeof d === 'number' && Number.isFinite(d) && d >= 0) known += d;
      continue;
    }
    if (!isLocatedStop(item)) continue;
    if (prev?.loc && item.loc) travel += sawTransit ? known : estimateMinutes(prev.loc, item.loc, 'transit');
    prev = item;
    sawTransit = false;
    known = 0;
  }

  const span = last - first;
  if (stay + travel <= span) return [];
  return [
    {
      level: 'warn',
      code: 'day-overload',
      date: day.date,
      message: `這天可能排不完：停留約 ${stay} 分鐘 + 估算移動約 ${travel} 分鐘，超過 ${fromMinutes(first)}–${fromMinutes(last)} 的 ${span} 分鐘（移動為直線估算，僅供參考）`,
    },
  ];
}

export function checkTrip(trip: Trip, opts: CheckOptions = {}): Issue[] {
  const issues: Issue[] = [];
  const push = (i: Issue) => issues.push(i);

  // ---- date-range ---------------------------------------------------------
  let prevDate: string | undefined;
  for (const day of trip.days) {
    if (day.color !== undefined && !isDayColor(day.color)) {
      push({ level: 'warn', code: 'day-color', date: day.date, message: `${day.date} 的 color 要是 1 到 8 的整數（現在是 ${String(day.color)}），先用自動顏色` });
    }
    if (!isIsoDate(day.date)) {
      push({ level: 'error', code: 'date-range', date: day.date, message: `日期格式不正確：${day.date}（需為 YYYY-MM-DD）` });
      continue;
    }
    if (day.date < trip.start || day.date > trip.end) {
      push({
        level: 'error',
        code: 'date-range',
        date: day.date,
        message: `${day.date} 不在行程期間 ${trip.start} 至 ${trip.end} 內`,
      });
    }
    if (prevDate !== undefined && day.date <= prevDate) {
      push({
        level: 'error',
        code: 'date-range',
        date: day.date,
        message:
          day.date === prevDate
            ? `${day.date} 出現重複的日期`
            : `${day.date} 的順序錯誤，應晚於前一天 ${prevDate}`,
      });
    }
    prevDate = day.date;
  }

  // ---- per-day rules ------------------------------------------------------
  for (const day of trip.days) {
    const dateOk = isIsoDate(day.date);
    const wd = dateOk ? weekday(day.date) : undefined;
    let prevTimed: { item: Item; start: number; end: number | undefined } | undefined;

    for (const item of day.items) {
      const label = `${item.start ? item.start + ' ' : ''}${item.title}`;
      const start = item.start === undefined ? undefined : tryToMinutes(item.start);
      const end = item.end === undefined ? undefined : tryToMinutes(item.end);

      if (item.start !== undefined && start === undefined) {
        push({ level: 'error', code: 'invalid-time', date: day.date, itemId: item.id, message: `${item.title} 的開始時間格式不正確：${item.start}（需為 HH:MM）` });
      }
      if (item.end !== undefined && end === undefined) {
        push({ level: 'error', code: 'invalid-time', date: day.date, itemId: item.id, message: `${item.title} 的結束時間格式不正確：${item.end}（需為 HH:MM）` });
      }

      // Flights: end is in the arrival time zone and may fall on the next day, so end < start is legitimate.
      const overnightFlight = item.kind === 'flight' && start !== undefined && end !== undefined && end < start;

      // ---- time-order
      if (start !== undefined && end !== undefined && end < start && !overnightFlight) {
        push({
          level: 'error',
          code: 'time-order',
          date: day.date,
          itemId: item.id,
          message: `${item.title} 的結束時間 ${item.end} 早於開始時間 ${item.start}`,
        });
      }

      // ---- overlap (against the previous timed item of the day)
      if (start !== undefined && !overnightFlight) {
        if (prevTimed && prevTimed.end !== undefined && start < prevTimed.end) {
          push({
            level: 'error',
            code: 'overlap',
            date: day.date,
            itemId: item.id,
            message: `${label} 與前一項「${prevTimed.item.title}」時間重疊（${prevTimed.item.start}–${fromMinutes(prevTimed.end)}）`,
          });
        }
        prevTimed = { item, start, end: end !== undefined && end >= start ? end : undefined };
      }

      // ---- closed / outside-hours
      if (start !== undefined && wd !== undefined) {
        const hours = opts.hoursFor?.(item, day) ?? item.hours?.value;
        if (hours && isRecord(hours)) {
          const closedByDate = (hours.closedDates ?? []).includes(day.date);
          const hasPeriods = (hours.periods ?? []).length > 0;
          if (closedByDate) {
            push({ level: 'error', code: 'closed', date: day.date, itemId: item.id, message: `${label} 當天（${day.date}）公休` });
          } else if (hasPeriods) {
            const windows = windowsFor(hours, wd);
            if (windows.length === 0) {
              push({ level: 'error', code: 'closed', date: day.date, itemId: item.id, message: `${label} 在${WEEKDAY_NAMES[wd]}沒有營業` });
            } else {
              const to = end !== undefined && end >= start ? end : start;
              const inside = windows.some((w) => start >= w.open && to <= w.close);
              if (!inside) {
                const spans = windows.map((w) => `${fromMinutes(w.open)}–${fromMinutes(w.close)}`).join('、');
                push({
                  level: 'warn',
                  code: 'outside-hours',
                  date: day.date,
                  itemId: item.id,
                  message: `${label}${item.end ? '–' + item.end : ''} 不在營業時間內（${WEEKDAY_NAMES[wd]} ${spans}）`,
                });
              }
            }
          }
        }
      }

      // ---- transit-gap
      if (item.kind === 'transit' && start !== undefined && end !== undefined) {
        const need = item.duration?.value;
        if (typeof need === 'number' && Number.isFinite(need) && end - start < need) {
          push({
            level: 'warn',
            code: 'transit-gap',
            date: day.date,
            itemId: item.id,
            message: `${label} 的時間窗只有 ${end - start} 分鐘，但交通需要約 ${need} 分鐘`,
          });
        }
      }

      // ---- missing-source
      for (const [name, sourced] of sourcedFields(item)) {
        const bad =
          !isRecord(sourced) ||
          typeof sourced.source !== 'string' ||
          sourced.source.trim() === '' ||
          !validFetchedAt(sourced.fetchedAt);
        if (bad) {
          push({
            level: 'error',
            code: 'missing-source',
            date: day.date,
            itemId: item.id,
            message: `${item.title} 的${name}缺少來源，或取得時間（fetchedAt）無效`,
          });
        }
      }

      // ---- photo: the shape of item.photos (file name rule, one-line caption, https source with a label)
      const photos = (item as { photos?: unknown }).photos;
      if (photos !== undefined) {
        const problems = Array.isArray(photos) ? photos.map(photoProblem).filter((m): m is string => m !== undefined) : ['photos 必須是陣列'];
        for (const m of problems) push({ level: 'error', code: 'photo', date: day.date, itemId: item.id, message: `${item.title}：${m}` });
      }
    }

    // ---- arrival: day opens with flight(s) → first non-flight item needs a buffer after landing
    let landing: number | undefined;
    for (const item of day.items) {
      if (item.kind === 'flight') {
        const e = item.end === undefined ? undefined : tryToMinutes(item.end);
        if (e !== undefined) landing = landing === undefined ? e : Math.max(landing, e);
        continue;
      }
      if (landing !== undefined) {
        const s = item.start === undefined ? undefined : tryToMinutes(item.start);
        if (s !== undefined && s < landing + ARRIVAL_BUFFER) {
          push({
            level: 'warn',
            code: 'arrival',
            date: day.date,
            itemId: item.id,
            message: `${item.start} ${item.title}早於抵達後可行時間（${fromMinutes(landing)} 抵達）`,
          });
        }
      }
      break;
    }

    // ---- missing-transit / day-overload (straight-line estimates, warnings only)
    for (const issue of [...missingTransit(day), ...dayOverload(day), ...legEndpoints(day)]) push(issue);
  }

  // ---- duplicate-id (items and candidates share one namespace) -------------
  const seen = new Map<string, string>();
  const note = (id: string, where: string, date?: string) => {
    const first = seen.get(id);
    if (first === undefined) {
      seen.set(id, where);
    } else {
      const issue: Issue = { level: 'error', code: 'duplicate-id', itemId: id, message: `id「${id}」重複（${first} 與 ${where}）` };
      if (date !== undefined) issue.date = date;
      push(issue);
    }
  };
  for (const day of trip.days) for (const item of day.items) note(item.id, `${day.date} 的行程`, day.date);
  for (const c of trip.candidates) note(c.id, '候選地點');

  return issues;
}
