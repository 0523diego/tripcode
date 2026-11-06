// Pure helpers for the variant compare view (方案並排比較). No DOM, no I/O.
import type { Day, Item, Trip } from '../core/types.ts';
import { tryToMinutes } from '../core/time.ts';

export interface DayStats {
  title: string;
  pois: number;
  /** Sum of (end - start) over items that have both a valid start and end. */
  timedMinutes: number;
  transitLegs: number;
  hotel: string | undefined;
  /** Titles of every item, used to list differences. */
  items: Item[];
  /** Signature of the day's items; equal signatures = identical plan. */
  signature: string;
}

export interface TripMetrics {
  days: number;
  pois: number;
  hotelChanges: number;
  transitLegs: number;
  candidates: number;
}

/**
 * Hotel for each night: a hotel item with `nights: n` on day i covers days i..i+n-1.
 * A day with no covering stay is undefined. The first stay that claims a day wins.
 */
export function hotelByDay(trip: Trip): (string | undefined)[] {
  const out: (string | undefined)[] = trip.days.map(() => undefined);
  trip.days.forEach((day, i) => {
    for (const it of day.items) {
      if (it.kind !== 'hotel') continue;
      const nights = Number.isFinite(it.nights) && it.nights > 0 ? Math.floor(it.nights) : 1;
      for (let k = i; k < Math.min(i + nights, out.length); k++) {
        if (out[k] === undefined) out[k] = it.title;
      }
    }
  });
  return out;
}

export function timedMinutes(items: Item[]): number {
  let total = 0;
  for (const it of items) {
    const s = it.start ? tryToMinutes(it.start) : undefined;
    const e = it.end ? tryToMinutes(it.end) : undefined;
    if (s !== undefined && e !== undefined && e > s) total += e - s;
  }
  return total;
}

function itemSignature(it: Item): string {
  return [it.id, it.kind, it.title, it.start ?? '', it.end ?? '', it.loc ? `${it.loc.lat},${it.loc.lng}` : ''].join('|');
}

export function dayStats(day: Day, hotel: string | undefined): DayStats {
  return {
    title: day.title ?? '',
    pois: day.items.filter((i) => i.kind === 'poi').length,
    timedMinutes: timedMinutes(day.items),
    transitLegs: day.items.filter((i) => i.kind === 'transit').length,
    hotel,
    items: day.items,
    signature: day.items.map(itemSignature).join('\n'),
  };
}

export function tripDayStats(trip: Trip): DayStats[] {
  const hotels = hotelByDay(trip);
  return trip.days.map((d, i) => dayStats(d, hotels[i]));
}

/** Number of distinct consecutive hotel stays minus one (never below 0). */
export function hotelChanges(trip: Trip): number {
  let stays = 0;
  let last: string | undefined;
  for (const h of hotelByDay(trip)) {
    if (h === undefined) continue;
    if (h !== last) stays++;
    last = h;
  }
  return Math.max(0, stays - 1);
}

export function tripMetrics(trip: Trip): TripMetrics {
  let pois = 0;
  let transitLegs = 0;
  for (const d of trip.days) {
    for (const it of d.items) {
      if (it.kind === 'poi') pois++;
      else if (it.kind === 'transit') transitLegs++;
    }
  }
  return {
    days: trip.days.length,
    pois,
    hotelChanges: hotelChanges(trip),
    transitLegs,
    candidates: trip.candidates.length,
  };
}

export interface DayDiff {
  /** True when the days' items, title or hotel differ (or one side has no such day). */
  differs: boolean;
  /** Item titles present only on that side (matched by id). */
  onlyA: string[];
  onlyB: string[];
  title: boolean;
  pois: boolean;
  timedMinutes: boolean;
  transitLegs: boolean;
  hotel: boolean;
}

export function diffDay(a: DayStats | undefined, b: DayStats | undefined): DayDiff {
  if (!a || !b) {
    return {
      differs: true,
      onlyA: a ? a.items.map((i) => i.title) : [],
      onlyB: b ? b.items.map((i) => i.title) : [],
      title: true,
      pois: true,
      timedMinutes: true,
      transitLegs: true,
      hotel: true,
    };
  }
  const idsA = new Set(a.items.map((i) => i.id));
  const idsB = new Set(b.items.map((i) => i.id));
  return {
    differs: a.signature !== b.signature || a.title !== b.title || a.hotel !== b.hotel,
    onlyA: a.items.filter((i) => !idsB.has(i.id)).map((i) => i.title),
    onlyB: b.items.filter((i) => !idsA.has(i.id)).map((i) => i.title),
    title: a.title !== b.title,
    pois: a.pois !== b.pois,
    timedMinutes: a.timedMinutes !== b.timedMinutes,
    transitLegs: a.transitLegs !== b.transitLegs,
    hotel: a.hotel !== b.hotel,
  };
}

export function formatMinutes(min: number): string {
  if (min <= 0) return '0 分';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h} 小時${m > 0 ? ` ${m} 分` : ''}` : `${m} 分`;
}
