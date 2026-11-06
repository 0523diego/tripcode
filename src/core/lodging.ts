// Where you sleep each night, derived from the trip's hotel items. A hotel item sits on its check-in day with
// `nights`; every other day of the stay has no hotel item of its own, yet each day starts and ends there.

import type { Day, Item, Trip } from './types.ts';

export type HotelItem = Extract<Item, { kind: 'hotel' }>;

export interface Stay {
  item: HotelItem;
  /** Index of the day the hotel item is listed on (its check-in day). */
  dayIdx: number;
}

export interface DayLodging {
  /** Where the day begins: the hotel you slept in last night. Absent on the first day or after a night with no hotel. */
  start?: Stay;
  /** Where the day ends: the hotel you sleep in tonight. Absent on the day you leave. */
  end?: Stay;
}

/** A stop this close to the hotel counts as already being at the hotel (no extra leg to draw). */
const AT_HOTEL_METERS = 80;

function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) return date;
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function meters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

/** Which hotel you sleep in on the night that begins on each date (YYYY-MM-DD). The earlier hotel item wins an overlap. */
export function stayByNight(trip: Pick<Trip, 'days'>): Map<string, Stay> {
  const out = new Map<string, Stay>();
  trip.days.forEach((day, dayIdx) => {
    for (const item of day.items) {
      if (item.kind !== 'hotel') continue;
      for (let n = 0; n < Math.max(1, item.nights); n++) {
        const date = addDays(day.date, n);
        if (!out.has(date)) out.set(date, { item, dayIdx });
      }
    }
  });
  return out;
}

function atHotel(item: Item | undefined, stay: Stay): boolean {
  if (!item) return false;
  if (item.id === stay.item.id) return true;
  return !!item.loc && !!stay.item.loc && meters(item.loc, stay.item.loc) <= AT_HOTEL_METERS;
}

/** The first and last stops that are real places (not transit hops), used to avoid adding a hotel the day already shows. */
function ends(day: Day): { first?: Item; last?: Item } {
  const stops = day.items.filter((it) => it.kind !== 'transit');
  return { first: stops[0], last: stops[stops.length - 1] };
}

/**
 * The lodging each day starts and ends at, in day order. A day that already opens (or closes) at its hotel,
 * for example with a hand-written "從飯店出發" stop, gets no duplicate on that side.
 */
export function lodgingByDay(trip: Pick<Trip, 'days'>): DayLodging[] {
  const nights = stayByNight(trip);
  return trip.days.map((day) => {
    const out: DayLodging = {};
    const start = nights.get(addDays(day.date, -1));
    const end = nights.get(day.date);
    const { first, last } = ends(day);
    if (start && !atHotel(first, start)) out.start = start;
    if (end && !atHotel(last, end)) out.end = end;
    return out;
  });
}
