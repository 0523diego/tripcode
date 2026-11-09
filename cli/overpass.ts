// Food places around a point from the public Overpass API (OpenStreetMap data, ODbL: https://www.openstreetmap.org/copyright).
// Network and clock are injected so tests never touch it. Polite use, per https://wiki.openstreetmap.org/wiki/Overpass_API :
// a descriptive User-Agent, one request per question (asked for by the user, never in a loop), a short timeout, a capped answer.
import { CliError } from './context.ts';
import type { FetchLike } from './google.ts';
import type { OsmElement } from '../src/core/food-find.ts';
import { Throttle } from './osm.ts';

// The public servers are shared and sometimes busy or down (502, 429, 504): each is tried once, in this order, before giving up.
export const OVERPASS_URLS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'] as const;
const MAX_CHARS = 8_000_000;
// Shared by every search in the process (a click on 「重新找」 is a request to a public server): at least 3 s apart.
const sharedThrottle = new Throttle({ intervalMs: 3000 });

export function overpassQuery(lat: number, lng: number, radiusM: number): string {
  if (![lat, lng, radiusM].every(Number.isFinite) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || radiusM < 100 || radiusM > 2000) throw new CliError('找店的位置或半徑不合理');
  return `[out:json][timeout:25];nwr(around:${Math.round(radiusM)},${lat.toFixed(5)},${lng.toFixed(5)})[amenity~"^(restaurant|fast_food|food_court|cafe|ice_cream)$"][name];out tags center 800;`;
}

export async function fetchFoodElements(opts: { fetch: FetchLike; userAgent: string; lat: number; lng: number; radiusM: number; throttle?: Throttle; endpoints?: readonly string[] }): Promise<OsmElement[]> {
  const body = `data=${encodeURIComponent(overpassQuery(opts.lat, opts.lng, opts.radiusM))}`;
  const throttle = opts.throttle ?? sharedThrottle;
  let busy = false;
  let unreachable = false;
  for (const url of opts.endpoints ?? OVERPASS_URLS) {
    await throttle.wait();
    let res: Response;
    try {
      res = await opts.fetch(url, {
        method: 'POST',
        headers: { 'user-agent': opts.userAgent, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body,
        signal: AbortSignal.timeout(40_000),
      });
    } catch {
      unreachable = true;
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      busy = true;
      continue;
    }
    if (!res.ok) throw new CliError(`Overpass 回了 HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_CHARS) throw new CliError('Overpass 回的內容比預期大很多，已中止');
    let data: { elements?: unknown };
    try {
      data = JSON.parse(text) as { elements?: unknown };
    } catch {
      busy = true; // an HTML "server too busy" page with a 200
      continue;
    }
    if (!Array.isArray(data.elements)) throw new CliError('Overpass 的回應格式不對');
    return data.elements as OsmElement[];
  }
  if (busy) throw new CliError('OpenStreetMap 的 Overpass 服務現在太忙（429／5xx）：請過一分鐘再試，或先用 Google 地圖連結找');
  throw new CliError(unreachable ? '連不上 OpenStreetMap 的 Overpass 服務，請檢查網路' : 'Overpass 沒有回應');
}
