// Google Maps directions links for a day. Pure string building.

import type { Day, Item } from './types.ts';

export type TravelMode = 'transit' | 'walking' | 'driving';

/** Google allows at most 8 waypoints per directions URL (origin + 8 + destination = 10 stops). */
const MAX_WAYPOINTS = 8;
const MAX_STOPS = MAX_WAYPOINTS + 2;

interface Stop {
  /** Value for the origin/destination/waypoints parameter (already URL-encoded). */
  label: string;
  placeId?: string;
  /** Used to collapse consecutive duplicates. */
  key: string;
}

/**
 * The item's place id if it is a Google place id. Ids from other providers carry a prefix
 * (e.g. "osm:way/123") and must never be sent to Google as place_id; callers fall back to coordinates.
 */
export function googlePlaceId(id: string | undefined): string | undefined {
  return id !== undefined && id !== '' && !/^[a-z]+:/i.test(id) ? id : undefined;
}

function coord(item: Item): string | undefined {
  return item.loc ? `${item.loc.lat},${item.loc.lng}` : undefined;
}

function toStop(item: Item): Stop | undefined {
  const ll = coord(item);
  const placeId = googlePlaceId(item.placeId);
  const hasLocation = placeId !== undefined || ll !== undefined;
  if (!hasLocation) {
    // Without any location only places you can look up by name are usable; transit/free/meal/flight are skipped.
    if ((item.kind === 'poi' || item.kind === 'hotel') && item.title.trim() !== '') {
      return { label: encodeURIComponent(item.title), key: `t:${item.title}` };
    }
    return undefined;
  }
  // With a place id, Google wants a readable name in the plain param; otherwise lat,lng is the most precise label.
  const label = placeId !== undefined && item.title.trim() !== '' ? encodeURIComponent(item.title) : (ll ?? encodeURIComponent(item.title));
  const stop: Stop = { label, key: placeId !== undefined ? `p:${placeId}` : `c:${ll}` };
  if (placeId !== undefined) stop.placeId = placeId;
  return stop;
}

function buildUrl(stops: Stop[], travelmode: TravelMode): string {
  const first = stops[0] as Stop;
  const last = stops[stops.length - 1] as Stop;
  const mid = stops.slice(1, -1);
  const parts = ['api=1', `origin=${first.label}`];
  if (first.placeId !== undefined) parts.push(`origin_place_id=${encodeURIComponent(first.placeId)}`);
  parts.push(`destination=${last.label}`);
  if (last.placeId !== undefined) parts.push(`destination_place_id=${encodeURIComponent(last.placeId)}`);
  if (mid.length > 0) {
    parts.push(`waypoints=${mid.map((s) => s.label).join('|')}`);
    // waypoint_place_ids must line up one-to-one with waypoints, so only send it when every waypoint has one.
    if (mid.every((s) => s.placeId !== undefined)) {
      parts.push(`waypoint_place_ids=${mid.map((s) => encodeURIComponent(s.placeId as string)).join('|')}`);
    }
  }
  parts.push(`travelmode=${travelmode}`);
  return `https://www.google.com/maps/dir/?${parts.join('&')}`;
}

/**
 * Google Maps directions URLs for one day, in item order. Days with more than 10 stops are split into
 * consecutive links; each link starts where the previous one ended. Fewer than 2 stops → [].
 * `start` / `end` are the hotels the day begins and ends at (see lodgingByDay); they bracket the item list.
 */
export function dayMapsLinks(day: Day, opts: { travelmode?: TravelMode; start?: Item; end?: Item } = {}): string[] {
  const travelmode = opts.travelmode ?? 'transit';
  const stops: Stop[] = [];
  const items = [...(opts.start ? [opts.start] : []), ...day.items, ...(opts.end ? [opts.end] : [])];
  for (const item of items) {
    const stop = toStop(item);
    if (!stop) continue;
    if (stops[stops.length - 1]?.key === stop.key) continue; // staying put is not a leg
    stops.push(stop);
  }
  const links: string[] = [];
  let i = 0;
  while (i < stops.length - 1) {
    const chunk = stops.slice(i, i + MAX_STOPS);
    links.push(buildUrl(chunk, travelmode));
    i += chunk.length - 1;
  }
  return links;
}
