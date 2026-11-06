// Place search for the viewer's dev-server endpoint. Reuses the CLI providers as they are: Google Places
// when GOOGLE_MAPS_API_KEY is set, otherwise OpenStreetMap Nominatim (same User-Agent, same 1 req/s throttle).
// Nothing else is ever called. Network, clock and throttle are injected so tests never touch the network.
import type { LatLng } from '../src/core/types.ts';
import { searchPlaces } from './google.ts';
import type { FetchLike } from './google.ts';
import { searchPlacesOsm, userAgentFor } from './osm.ts';
import type { Throttle } from './osm.ts';

export interface ViewerSearchDeps {
  /** Repo root (for the User-Agent version). */
  root: string;
  env: Record<string, string | undefined>;
  fetch: FetchLike;
  now?: () => Date;
  throttle?: Throttle;
}

export interface ViewerSearchResult {
  source: string;
  fetchedAt: string;
  results: { name: string; address?: string; loc?: LatLng; placeId?: string }[];
}

export async function searchForViewer(
  deps: ViewerSearchDeps,
  query: string,
  extra: { near?: LatLng; lang?: string } = {},
): Promise<ViewerSearchResult> {
  const apiKey = deps.env.GOOGLE_MAPS_API_KEY?.trim();
  const r = apiKey
    ? await searchPlaces({ apiKey, fetch: deps.fetch, now: deps.now }, query, extra)
    : await searchPlacesOsm({ fetch: deps.fetch, now: deps.now, userAgent: userAgentFor(deps.root), throttle: deps.throttle }, query, extra);
  return {
    source: r.source,
    fetchedAt: r.fetchedAt,
    results: r.results.map((p) => {
      const out: ViewerSearchResult['results'][number] = { name: p.name };
      if (p.address) out.address = p.address;
      if (p.loc) out.loc = { lat: p.loc.lat, lng: p.loc.lng };
      if (p.placeId) out.placeId = p.placeId;
      return out;
    }),
  };
}
