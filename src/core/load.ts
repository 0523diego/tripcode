// How much a day asks of the traveller, from what the trip file already knows: where the stops are (`loc`) and the
// fixed times of flights and trains. No map service is needed: distances are straight lines between located stops
// (`haversineKm`, the same estimate `check` and `optimize` use), turned into walking distance with one labelled detour
// factor. Nothing that is unknown is invented: a stay time nobody wrote down is not guessed, a stop without
// coordinates adds no distance, and a leg of more than 30 km is left to the `missing-transit` check. Real routes
// (Google Routes, with a key) replace the estimates automatically: a transit item with a sourced `duration` is used
// as it is.

import type { Day, Item, LatLng, Trip } from './types.ts';
import { estimateMinutes, haversineKm } from './optimize.ts';
import { lodgingByDay } from './lodging.ts';
import type { DayLodging } from './lodging.ts';
import { tryToMinutes } from './time.ts';

export const LOAD = {
  /** Walking distance is longer than the straight line between two points: streets do not run straight. A rule of thumb, shown wherever it is used. */
  detour: 1.3,
  walkKmh: 4.5,
  /** The part of the day a traveller is out and about. */
  windowFrom: '08:30',
  windowTo: '21:30',
  /** After landing: immigration, bags, getting out (same idea as the `arrival` check). */
  flightBufferMin: 60,
  /** A leg longer than this (straight line, about 40 minutes on foot) is not counted as a walk: someone takes transport, and the `missing-transit` check says there is none planned. */
  maxWalkLegKm: 3,
  /** Beyond this even an estimate is not offered. */
  maxEstimateLegKm: 30,
} as const;

export interface DayLoad {
  date: string;
  /** Stops that take time: sights and meals (hotels are only used as ends of a walk). */
  stops: number;
  /** Straight-line total of the walking legs, and the estimated walk (straight × detour). */
  straightKm: number;
  walkKm: number;
  walkMin: number;
  /** Minutes in transit items (known or estimated) and in fixed travel blocks (flights with buffer, trains with times). */
  transitMin: number;
  blockedMin: number;
  /** What is left of the day after travel and walking, and what that gives each stop. */
  windowMin: number;
  freeMin: number;
  perStopMin?: number;
  /** What this estimate could not see, so the page can say so. */
  unknown: string[];
}

const isStopItem = (it: Item) => it.kind === 'poi' || it.kind === 'meal' || it.kind === 'free';

function minutesOf(hhmm: string | undefined): number | undefined {
  return hhmm === undefined ? undefined : tryToMinutes(hhmm);
}

export function dayLoad(day: Day, lodging?: DayLodging): DayLoad {
  const unknown: string[] = [];
  let straightKm = 0;
  let transitMin = 0;
  let blockedMin = 0;
  let stops = 0;
  let last: { loc: LatLng } | undefined;
  let sawTransit = false;
  let pendingTransitKnown = false;
  let longLegs = 0;

  const reach = (loc: LatLng) => {
    if (last) {
      if (sawTransit) {
        if (!pendingTransitKnown) transitMin += estimateMinutes(last.loc, loc, 'transit');
      } else {
        const km = haversineKm(last.loc, loc);
        if (km <= LOAD.maxWalkLegKm) straightKm += km;
        else if (km <= LOAD.maxEstimateLegKm) {
          // Too far to walk and no transport planned: count the estimated ride, and say it is a guess.
          transitMin += estimateMinutes(last.loc, loc, 'transit');
          longLegs++;
        }
      }
    }
    last = { loc };
    sawTransit = false;
    pendingTransitKnown = false;
  };

  if (lodging?.start?.item.loc) last = { loc: lodging.start.item.loc };
  let noLoc = 0;
  for (const it of day.items) {
    if (it.kind === 'flight') {
      const s = minutesOf(it.start);
      const e = minutesOf(it.end);
      if (s !== undefined && e !== undefined && e > s) blockedMin += e - s + LOAD.flightBufferMin;
      else unknown.push(`航班「${it.title}」沒有起訖時間`);
      last = undefined;
      sawTransit = false;
      continue;
    }
    if (it.kind === 'transit') {
      if (it.mode === 'walk') continue;
      sawTransit = true;
      const s = minutesOf(it.start);
      const e = minutesOf(it.end);
      if (s !== undefined && e !== undefined && e > s) {
        blockedMin += e - s;
        pendingTransitKnown = true;
      } else if (it.duration !== undefined && Number.isFinite(it.duration.value)) {
        transitMin += it.duration.value;
        pendingTransitKnown = true;
      }
      continue;
    }
    if (it.kind === 'hotel') {
      if (it.loc) reach(it.loc);
      continue;
    }
    if (isStopItem(it)) {
      if (it.kind !== 'free') stops++;
      if (it.loc) reach(it.loc);
      else noLoc++;
    }
  }
  if (lodging?.end?.item.loc && last) reach(lodging.end.item.loc);
  if (longLegs > 0) unknown.push(`${longLegs} 段超過 ${LOAD.maxWalkLegKm} 公里的移動沒有安排交通，用直線估算`);
  if (noLoc > 0) unknown.push(`${noLoc} 個地點沒有座標，距離沒算進去`);

  const walkKm = straightKm * LOAD.detour;
  const walkMin = Math.round((walkKm / LOAD.walkKmh) * 60);
  const windowMin = (minutesOf(LOAD.windowTo) ?? 0) - (minutesOf(LOAD.windowFrom) ?? 0);
  const freeMin = windowMin - blockedMin - transitMin - walkMin;
  return {
    date: day.date,
    stops,
    straightKm: Math.round(straightKm * 10) / 10,
    walkKm: Math.round(walkKm * 10) / 10,
    walkMin,
    transitMin: Math.round(transitMin),
    blockedMin,
    windowMin,
    freeMin: Math.round(freeMin),
    ...(stops > 0 ? { perStopMin: Math.round(freeMin / stops) } : {}),
    unknown,
  };
}

export function dayLoads(trip: Pick<Trip, 'days'>): DayLoad[] {
  const lodging = lodgingByDay(trip);
  return trip.days.map((d, i) => dayLoad(d, lodging[i]));
}

/** 「約 7–8 公里」 or 「10,000 步」 in profile.md, as km; undefined when it says nothing usable. */
export function walkLimitFromProfile(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const km = /(\d+(?:\.\d+)?)\s*[–\-~～]\s*(\d+(?:\.\d+)?)\s*公里/.exec(text);
  if (km) return Math.max(Number(km[1]), Number(km[2]));
  const one = /(\d+(?:\.\d+)?)\s*公里/.exec(text);
  if (one) return Number(one[1]);
  const steps = /(\d[\d,]*)\s*步/.exec(text);
  if (steps) return Math.round(Number(steps[1]!.replace(/,/g, '')) * 0.0007 * 10) / 10;
  return undefined;
}
