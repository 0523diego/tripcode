// Opening-hours helpers shared by the health check, the meal-gap finder and the booking list.

import type { OpeningHours } from './types.ts';
import { tryToMinutes } from './time.ts';

export interface Window {
  open: number;
  close: number;
}

/** Open windows (minutes) on a given weekday, including spill-over from a period that ran past midnight the day before. */
export function windowsFor(hours: OpeningHours, wd: number): Window[] {
  const out: Window[] = [];
  for (const p of hours.periods ?? []) {
    const open = tryToMinutes(p.open);
    let close = tryToMinutes(p.close);
    if (open === undefined || close === undefined) continue;
    // close <= open means the period runs past midnight (00:00–00:00 means open all day).
    if (close <= open) close += 1440;
    if (p.day === wd) out.push({ open, close });
    if (close > 1440 && (p.day + 1) % 7 === wd) out.push({ open: 0, close: close - 1440 });
  }
  return out;
}

