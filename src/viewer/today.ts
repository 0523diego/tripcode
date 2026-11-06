// "Today" helpers for the viewer. Pure functions: callers pass the clock in, so they are testable.
// Dates are compared as YYYY-MM-DD strings in the trip's own time zone (the user is on location).
import type { Day, Item, Trip } from '../core/types.ts';

/** YYYY-MM-DD of `now` in time zone `tz` (falls back to UTC for an unknown zone). */
export function dateInTz(tz: string, now: Date): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** "HH:MM" of `now` in time zone `tz`. */
export function timeInTz(tz: string, now: Date): string {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
    return `${get('hour')}:${get('minute')}`;
  } catch {
    return now.toISOString().slice(11, 16);
  }
}

/** Index of the day that is today, or null when today is outside trip.start–trip.end (or has no day). */
export function todayDayIdx(trip: Pick<Trip, 'start' | 'end' | 'days'>, today: string): number | null {
  if (today < trip.start || today > trip.end) return null;
  const i = trip.days.findIndex((d) => d.date === today);
  return i >= 0 ? i : null;
}

/**
 * `?today=YYYY-MM-DD` pins the clock's date — for previewing "during the trip" screenshots without
 * waiting for the trip. Ignored unless it is a well-formed date.
 */
export function todayOverride(search: string): string | null {
  const v = new URLSearchParams(search).get('today');
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

/** The clock the viewer uses: real time, with an optional pinned date (time of day stays real). */
export function viewerNow(tz: string, search: string, now: Date = new Date()): { date: string; time: string } {
  return { date: todayOverride(search) ?? dateInTz(tz, now), time: timeInTz(tz, now) };
}

/**
 * The next thing to do on `day`. On today (`time` given) the first timed item that has not started;
 * on any other day the first timed item. Hotel check-in rows count: they are real stops.
 */
export function nextItem(day: Day, time: string | null): Item | null {
  const timed = day.items.filter((i) => !!i.start);
  if (timed.length === 0) return day.items[0] ?? null;
  if (time === null) return timed[0] ?? null;
  return timed.find((i) => (i.start as string) >= time) ?? null;
}
