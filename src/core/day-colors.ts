// The color of each day. Days that sleep in the same hotel share one color by default, so a glance at the day strip or the
// map shows "these days are all from the same base"; a day can carry its own `color` (1–8) to override that. The numbers
// are slots of the viewer's --day-1 … --day-8 palette (and of the KML export), never raw colors, so they follow the theme.
import { stayByNight } from './lodging.ts';
import type { Day, Trip } from './types.ts';

export const PALETTE_SIZE = 8;

export function isDayColor(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= PALETTE_SIZE;
}

function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) return date;
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/**
 * The hotel a day belongs to: where you sleep that night, or last night's hotel on the day you leave. Undefined when the
 * trip has no hotel for it. Days between a hotel's check-in and check-out all give the same id.
 */
export function dayStayIds(trip: Pick<Trip, 'days'>): (string | undefined)[] {
  const nights = stayByNight(trip);
  return trip.days.map((day) => (nights.get(day.date) ?? nights.get(addDays(day.date, -1)))?.item.id);
}

/**
 * Palette slot (1–8) for every day, in day order. Automatic colors are handed out in the order the trip reaches each
 * hotel, so neighbouring hotels differ; a day with no hotel gets a color of its own (a trip with no hotels at all looks
 * as it always did). A day's own `color` wins, and does not shift anyone else's automatic color.
 */
export function dayColorSlots(trip: Pick<Trip, 'days'>): number[] {
  const stays = dayStayIds(trip);
  const slotOf = new Map<string, number>();
  return trip.days.map((day: Day, i) => {
    const key = stays[i] ? `stay:${stays[i]}` : `day:${i}`;
    let slot = slotOf.get(key);
    if (slot === undefined) {
      slot = slotOf.size % PALETTE_SIZE;
      slotOf.set(key, slot);
    }
    return isDayColor(day.color) ? day.color : slot + 1;
  });
}

/** CSS custom property for a slot, e.g. 3 → "--day-3". */
export const dayColorVar = (slot: number): string => `--day-${slot}`;

/** The dates that share this day's hotel, in order (just the day itself when it has no hotel): what 「同一住宿一起換」 changes. */
export function sameStayDates(trip: Pick<Trip, 'days'>, date: string): string[] {
  const stays = dayStayIds(trip);
  const i = trip.days.findIndex((d) => d.date === date);
  const id = i >= 0 ? stays[i] : undefined;
  if (i < 0) return [];
  if (!id) return [date];
  return trip.days.filter((_, j) => stays[j] === id).map((d) => d.date);
}
