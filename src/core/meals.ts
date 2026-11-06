// Meals that have no place yet. Pure: finds the lunch and dinner slots of each day that are empty or only a
// placeholder, picks the stops on either side to eat near, and builds the Google Maps links the user follows.
// Nothing here calls a network: ranking restaurants needs Google data and lives in a later milestone.

import type { Day, Item, LatLng, Trip } from './types.ts';
import { fromMinutes, tryToMinutes } from './time.ts';
import { lodgingByDay } from './lodging.ts';
import type { DayLodging } from './lodging.ts';

export interface MealWindow {
  slot: 'lunch' | 'dinner';
  from: string;
  to: string;
}

export interface AnchorRef {
  itemId: string;
  title: string;
  loc?: LatLng;
}

export interface MealGap {
  date: string;
  slot: 'lunch' | 'dinner';
  /** missing = no meal at all; undecided = a placeholder meal exists but no place was chosen. */
  kind: 'missing' | 'undecided';
  /** For `undecided`: the item to fill in, instead of adding another. */
  existingItemId?: string;
  window: { from: string; to: string };
  prev?: AnchorRef;
  next?: AnchorRef;
  hotel?: AnchorRef;
  defaultAnchor: 'prev' | 'next' | 'hotel';
  /** timed = placed by clock times; positional = guessed from the order of stops (no times on the day). */
  basis: 'timed' | 'positional';
  /** A locked, timed item that pushed the window earlier. */
  blockedBy?: string;
}

export const DEFAULT_WINDOWS: MealWindow[] = [
  { slot: 'lunch', from: '12:00', to: '14:30' },
  { slot: 'dinner', from: '19:00', to: '21:30' },
];

const m = (hhmm: string | undefined) => (hhmm === undefined ? undefined : tryToMinutes(hhmm));
const isStop = (it: Item) => it.kind === 'poi' || it.kind === 'free';
const ref = (it: Item): AnchorRef => ({ itemId: it.id, title: it.title, ...(it.loc ? { loc: it.loc } : {}) });
const decided = (it: Item) => it.kind === 'meal' && (!!it.loc || !!it.placeId || !!it.locked);

function slotOfMeal(it: Item, idx: number, day: Day): 'lunch' | 'dinner' {
  const t = m(it.start);
  if (t !== undefined) return t < 16 * 60 ? 'lunch' : 'dinner';
  if (/午餐|lunch|brunch|pranzo/i.test(it.title)) return 'lunch';
  if (/晚餐|dinner|cena/i.test(it.title)) return 'dinner';
  return idx < day.items.length / 2 ? 'lunch' : 'dinner';
}

export function findMealGaps(trip: Trip, opts: { windows?: MealWindow[]; lodging?: DayLodging[] } = {}): MealGap[] {
  const windows = opts.windows ?? DEFAULT_WINDOWS;
  const lodging = opts.lodging ?? lodgingByDay(trip);
  const out: MealGap[] = [];

  trip.days.forEach((day, dayIdx) => {
    const stops = day.items.filter(isStop);
    if (stops.length === 0 && !day.items.some((i) => i.kind === 'meal')) return; // an empty or travel-only day is not a meal problem
    const timed = stops.length > 0 && stops.every((s) => m(s.start) !== undefined);

    for (const w of windows) {
      let from = m(w.from)!;
      let to = m(w.to)!;
      let blockedBy: string | undefined;

      // A flight over the whole window: no meal to plan.
      if (day.items.some((i) => i.kind === 'flight' && m(i.start) !== undefined && m(i.end) !== undefined && m(i.start)! <= from && m(i.end)! >= to)) continue;
      // A locked, timed item that covers the whole window.
      if (day.items.some((i) => i.locked && i.kind !== 'meal' && m(i.start) !== undefined && m(i.end) !== undefined && m(i.start)! <= from && m(i.end)! >= to)) continue;
      // A locked evening event pulls dinner earlier.
      if (w.slot === 'dinner') {
        const evening = day.items.filter((i) => isStop(i) && i.locked && m(i.start) !== undefined && m(i.start)! >= 17 * 60 && m(i.start)! < to).sort((a, b) => m(a.start)! - m(b.start)!)[0];
        if (evening) {
          to = m(evening.start)! - 30;
          from = Math.min(from, to - 90);
          blockedBy = evening.title;
        }
      }

      // Is there already a meal for this slot?
      const meals = day.items.map((it, idx) => ({ it, idx })).filter(({ it }) => it.kind === 'meal');
      const mine = meals.filter(({ it, idx }) => slotOfMeal(it, idx, day) === w.slot);
      if (mine.some(({ it }) => decided(it))) continue;

      // The stops on either side.
      let prev: Item | undefined;
      let next: Item | undefined;
      if (timed) {
        const before = stops.filter((s) => (m(s.end) ?? m(s.start)!) <= from);
        const after = stops.filter((s) => m(s.start)! >= to);
        prev = before.sort((a, b) => (m(b.end) ?? m(b.start)!) - (m(a.end) ?? m(a.start)!))[0];
        next = after.sort((a, b) => m(a.start)! - m(b.start)!)[0];
      } else if (w.slot === 'lunch') {
        const k = Math.ceil(stops.length / 2);
        prev = stops[k - 1];
        next = stops[k];
      } else {
        prev = stops[stops.length - 1];
      }
      const stay = w.slot === 'dinner' ? lodging[dayIdx]?.end?.item : undefined;
      const hotel = stay ? ref(stay) : undefined;

      const placed = (a: Item | undefined) => !!a?.loc;
      let defaultAnchor: MealGap['defaultAnchor'] = w.slot === 'dinner' && blockedBy ? 'next' : 'prev';
      if (defaultAnchor === 'prev' && !placed(prev)) defaultAnchor = placed(next) ? 'next' : hotel?.loc ? 'hotel' : 'prev';
      if (defaultAnchor === 'next' && !placed(next)) defaultAnchor = placed(prev) ? 'prev' : hotel?.loc ? 'hotel' : 'next';

      const undecided = mine[0];
      out.push({
        date: day.date,
        slot: w.slot,
        kind: undecided ? 'undecided' : 'missing',
        ...(undecided ? { existingItemId: undecided.it.id } : {}),
        window: { from: fromMinutes(from), to: fromMinutes(to) },
        ...(prev ? { prev: ref(prev) } : {}),
        ...(next ? { next: ref(next) } : {}),
        ...(hotel ? { hotel } : {}),
        defaultAnchor,
        basis: timed ? 'timed' : 'positional',
        ...(blockedBy ? { blockedBy } : {}),
      });
    }
  });
  return out;
}

// ---------- Google Maps links ----------

/** A Maps search for restaurants around a named stop. Free text, so it needs no coordinates and no key. */
export function restaurantsNearUrl(anchorTitle: string, city?: string): string {
  const q = `restaurants near ${anchorTitle.replace(/[（(].*?[）)]/g, '').trim()}${city ? ` ${city}` : ''}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

export interface MapsPlace {
  name?: string;
  loc?: { lat: number; lng: number };
}

const num = (s: string | undefined) => (s !== undefined && Number.isFinite(Number(s)) ? Number(s) : undefined);

/**
 * Reads a name and coordinates out of a pasted Google Maps link (long form). Short links (maps.app.goo.gl)
 * cannot be opened from here, so they are refused with a hint instead of guessed at.
 */
export function parseMapsLink(raw: string): MapsPlace {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error('這不是網址');
  }
  const host = u.hostname.toLowerCase();
  if (host === 'maps.app.goo.gl' || host === 'goo.gl') throw new Error('這是 Google 地圖的短網址。請先在瀏覽器打開它，再複製網址列上的長網址貼過來');
  const isMaps = (/(^|\.)google\.[a-z.]+$/.test(host) && u.pathname.startsWith('/maps')) || host === 'maps.google.com';
  if (!isMaps || u.protocol !== 'https:') throw new Error('只接受 https 的 Google 地圖連結');
  const out: MapsPlace = {};
  const place = /\/maps\/place\/([^/@?]+)/.exec(u.pathname);
  if (place) {
    try {
      out.name = decodeURIComponent(place[1]!.replace(/\+/g, ' ')).trim() || undefined;
    } catch {
      /* leave the name out */
    }
  }
  // The place's own pin wins over the map viewport.
  const pin = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/.exec(u.pathname + u.search) ?? /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/.exec(decodeURIComponent(u.href));
  const view = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(u.pathname);
  const q = u.searchParams.get('query') ?? u.searchParams.get('q');
  const qCoord = q ? /^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/.exec(q) : null;
  const pick = pin ?? qCoord ?? view;
  if (pick) {
    const lat = num(pick[1]);
    const lng = num(pick[2]);
    if (lat !== undefined && lng !== undefined && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) out.loc = { lat, lng };
  }
  if (!out.name && q && !qCoord) out.name = q.trim();
  if (!out.name && !out.loc) throw new Error('這個連結裡找不到店名或座標。請在 Google 地圖打開那間店，再複製網址列上的連結');
  return out;
}
