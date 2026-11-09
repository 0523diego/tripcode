// The two network-facing food operations, shared by the CLI (`food guide`, `food near`) and the dev-server endpoint behind the
// 這餐吃什麼 drawer. Network, trip loading and the clock are injected so tests never touch the network.
import path from 'node:path';
import { CliError } from './context.ts';
import type { FetchLike } from './google.ts';
import { fetchFoodElements } from './overpass.ts';
import { Throttle, userAgentFor } from './osm.ts';
import { fetchEatSection } from './wikivoyage.ts';
import { readFood, updateFood } from './food-store.ts';
import { addAttribution, putDish, putListings, putPlace, putShortlist, setPhoto, visibleDishes } from '../src/core/food.ts';
import { fetchPlacePhoto } from './food-photo.ts';
import type { SafeFetchDeps } from './safe-fetch.ts';
import { mergeDuplicates, rankVenues, venuesFrom } from '../src/core/food-find.ts';
import { DEFAULT_WINDOWS, findMealGaps } from '../src/core/meals.ts';
import { tryToMinutes } from '../src/core/time.ts';
import type { PlaceProfile } from '../src/core/food-types.ts';
import type { Trip } from '../src/core/types.ts';
import { dishSeeds, parseEatDishes, parseEatListings } from '../src/core/wikivoyage-food.ts';

export interface FoodDeps {
  /** Tests give a fast one; otherwise each service's shared throttle applies. */
  throttle?: Throttle;
  root: string;
  fetch: FetchLike;
  now: () => Date;
  loadTrip: (file: string) => Promise<Trip>;
  /** Tests give fakes for the public-web fetch used for photos. */
  safe?: SafeFetchDeps;
}

const iso = (d: Date) => d.toISOString().replace(/\.\d+Z$/, 'Z');

export interface GuideResult {
  page: string;
  url: string;
  revision: string;
  found: number;
  saved: boolean;
  /** How many of the page's {{eat}} entries (name, coordinates, edit date) were found / kept as the guide's picks. */
  listings: number;
  added: string[];
  /** Dishes not saved because the file already has them (same id, same city): left as they are. */
  skipped: string[];
  dishes: { id: string; name: string; label: string; tags: string[] }[];
}

export async function guideForTrip(deps: FoodDeps, tripId: string, args: { city: string; page: string; save: boolean }): Promise<GuideResult> {
  const eat = await fetchEatSection(args.page, { fetch: deps.fetch, userAgent: userAgentFor(deps.root), ...(deps.throttle ? { throttle: deps.throttle } : {}) });
  const seeds = dishSeeds(parseEatDishes(eat.wikitext), args.city, { url: eat.url, title: eat.title, revision: eat.revision, fetchedAt: iso(deps.now()) });
  const listings = parseEatListings(eat.wikitext);
  let added: string[] = [];
  let skipped: string[] = [];
  let shown = seeds;
  if (args.save) {
    const before = await readFood(deps.root, tripId);
    const byId = new Map(before.dishes.map((d) => [d.id, d]));
    const town = eat.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    // A dish already in the file for this city is never overwritten (it may have been improved). The same id in ANOTHER city
    // (pizza in Rome, pizza in Naples) is a different dish: it gets the page's name as a suffix instead of being dropped.
    const taken = new Map(byId);
    const fresh: typeof seeds = [];
    shown = seeds.map((d) => {
      let id = d.id;
      for (let n = 1; ; n++) {
        const known = taken.get(id);
        if (!known) break;
        if (known.city === d.city) {
          skipped.push(id);
          return { ...d, id };
        }
        id = n === 1 ? `${d.id.slice(0, 40 - town.length - 1)}-${town}` : `${id.slice(0, 36)}-${n}`;
      }
      const out = { ...d, id };
      taken.set(id, out);
      fresh.push(out);
      return out;
    });
    const toAdd = fresh.filter((d) => !byId.has(d.id));
    added = toAdd.map((d) => d.id);
    const source = { url: eat.url, title: eat.title, ...(eat.revision ? { revision: eat.revision } : {}), fetchedAt: iso(deps.now()) };
    const picks = listings.map((l) => ({ name: l.name, ...(l.alt ? { alt: l.alt } : {}), loc: { lat: l.lat, lng: l.lng }, city: args.city, source, ...(l.lastedit ? { lastedit: l.lastedit } : {}) }));
    if (toAdd.length > 0 || picks.length > 0) await updateFood(deps.root, tripId, (f) => addAttribution(putListings(toAdd.reduce((acc, d) => putDish(acc, d), f), picks), 'Wikivoyage contributors (CC BY-SA 4.0)'));
  }
  return { page: eat.title, url: eat.url, revision: eat.revision, found: seeds.length, saved: args.save, listings: listings.length, added, skipped, dishes: shown.map((d) => ({ id: d.id, name: d.nameLocal, label: d.nameZh, tags: d.tags })) };
}

export interface NearArgs {
  /** The trip file to read (trip.ts, or a variant): the same one the page will write the chosen place into. */
  file?: string | undefined;
  date: string;
  slot: 'lunch' | 'dinner';
  anchor?: string | undefined;
  dishes?: string[] | undefined;
  radius?: number | undefined;
  limit?: number | undefined;
  save?: boolean | undefined;
  /** With save: fetch the photos of the top places' own websites. 'wait' (the CLI) finishes them first; 'background' (the page) does not hold the answer up. */
  photos?: 'wait' | 'background' | 'none' | undefined;
}

export interface NearOutput {
  date: string;
  slot: 'lunch' | 'dinner';
  window: { from: string; to: string };
  anchor: { title: string; loc: { lat: number; lng: number } };
  city: string | null;
  dishes: string[];
  generalMode: boolean;
  radiusM: number;
  maxWalkMin: number;
  dropped: { closed: number; far: number; rejected: number; noMatch: number };
  attribution: string;
  note: string;
  saved: boolean;
  results: {
    key: string;
    name: string;
    loc: { lat: number; lng: number };
    distanceM: number;
    walkMin: number;
    tier: 'safe' | 'likely' | 'check';
    score: number;
    why: string[];
    flags: string[];
    open: 'open' | 'closed' | 'unknown';
    hours?: string;
    website?: string;
    matches: { dishId: string; how: string }[];
    mapsUrl: string;
    evidence: unknown[];
    /** What an earlier look learned about the place: pages the AI read, and a picture from the place's own page. */
    profile?: PlaceProfile;
    photo?: { path: string; pageUrl: string };
  }[];
}

export async function nearForTrip(deps: FoodDeps, tripId: string, args: NearArgs): Promise<NearOutput> {
  const tripPath = path.join(deps.root, 'trips', tripId, args.file ?? 'trip.ts');
  const trip = await deps.loadTrip(tripPath).catch(() => {
    throw new CliError(`找不到或無法載入 trips/${tripId}/${args.file ?? 'trip.ts'}`);
  });
  const day = trip.days.find((d) => d.date === args.date);
  if (!day) throw new CliError(`這趟行程沒有 ${args.date} 這一天`);
  const gap = findMealGaps(trip).find((g) => g.date === args.date && g.slot === args.slot);
  const window = gap?.window ?? DEFAULT_WINDOWS.find((w) => w.slot === args.slot)!;
  const anchorArg = args.anchor ?? gap?.defaultAnchor;
  let anchor: { title: string; loc?: { lat: number; lng: number } } | undefined;
  if (anchorArg === 'prev' || anchorArg === 'next' || anchorArg === 'hotel') anchor = gap?.[anchorArg];
  else if (anchorArg) {
    const item = trip.days.flatMap((d) => d.items).find((it) => it.id === anchorArg);
    anchor = item ? { title: item.title, ...(item.loc ? { loc: item.loc } : {}) } : undefined;
  }
  if (!anchor?.loc) throw new CliError('找不到可以當起點的地方（這一餐前後的景點或住宿都沒有座標）：請指定一個有座標的項目當起點');
  const food = await readFood(deps.root, tripId);
  const cities = [...new Set(food.dishes.map((d) => d.city))];
  const city = day.city ?? (cities.length === 1 ? cities[0]! : undefined);
  const dishes = args.dishes ? food.dishes.filter((d) => args.dishes!.includes(d.id)) : city ? visibleDishes(food, city, args.slot).shown.slice(0, 6) : [];
  const maxWalkMin = food.taste.maxWalkMin ?? 10;
  const radius = args.radius ?? Math.min(1500, Math.max(300, Math.round(((maxWalkMin * 80) / 1.3) * 1.1)));
  const elements = await fetchFoodElements({ fetch: deps.fetch, userAgent: userAgentFor(deps.root), lat: anchor.loc.lat, lng: anchor.loc.lng, radiusM: radius, ...(deps.throttle ? { throttle: deps.throttle } : {}) });
  const recommended = new Set(food.places.filter((p) => p.evidence.some((e) => e.claim === 'recommended')).flatMap((p) => [p.key, ...(p.alsoKeys ?? [])]));
  const result = rankVenues({
    venues: mergeDuplicates(venuesFrom(elements)),
    dishes,
    anchor: anchor.loc,
    weekday: new Date(`${args.date}T00:00:00Z`).getUTCDay(),
    startMin: tryToMinutes(window.from) ?? 12 * 60,
    endMin: tryToMinutes(window.to) ?? undefined,
    maxWalkMin,
    rejected: new Set(food.rejected.map((r) => r.key)),
    landmarks: day.items.filter((it) => it.loc && it.kind !== 'meal' && it.kind !== 'transit').map((it) => it.loc!),
    recommended,
    listings: food.listings,
    now: deps.now(),
  });
  const top = result.ranked.slice(0, Math.min(20, Math.max(1, args.limit ?? 8)));
  const mapsUrl = (name: string) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([name, city].filter(Boolean).join(' '))}`;
  if (args.save && top.length > 0) {
    await updateFood(deps.root, tripId, (f) => {
      let next = addAttribution(f, '© OpenStreetMap contributors (ODbL)');
      for (const r of top) {
        const keep = next.places.find((p) => p.key === r.venue.key);
        next = putPlace(next, {
          key: r.venue.key,
          name: r.venue.name,
          loc: { lat: r.venue.loc.lat, lng: r.venue.loc.lng, fetchedAt: iso(deps.now()) },
          ...(r.venue.alsoKeys.length ? { alsoKeys: r.venue.alsoKeys } : {}),
          city: city ?? '未知',
          dishes: [...new Set([...(keep?.dishes ?? []), ...r.matches.map((m) => m.dishId)])],
          // Evidence we already hold (a web page, a recommendation) stays; the map's own are refreshed.
          evidence: [...(keep?.evidence ?? []).filter((e) => e.kind !== 'map-osm'), ...r.evidence],
          // What was learned about the place before (the AI's introduction, its photo) survives a new search.
          ...(keep?.profile ? { profile: keep.profile } : {}),
          ...(keep?.photo ? { photo: keep.photo } : {}),
        });
      }
      return putShortlist(next, {
        at: iso(deps.now()),
        date: args.date,
        slot: args.slot,
        anchor: anchor.title.slice(0, 120),
        ...(city ? { city } : {}),
        items: top.map((r) => ({
          key: r.venue.key,
          distanceM: r.distanceM,
          walkMin: r.walkMin,
          tier: r.tier,
          why: r.why.slice(0, 4),
          flags: r.flags,
          open: r.open,
          ...(r.venue.hours ? { hours: r.venue.hours.slice(0, 200) } : {}),
          ...(r.venue.website ? { website: r.venue.website.slice(0, 300) } : {}),
          mapsUrl: mapsUrl(r.venue.name),
        })),
      });
    });
    // The place's own picture, so the board has something to look at without anyone asking the AI for it.
    const sites = top.filter((r) => r.venue.website && !food.places.find((p) => p.key === r.venue.key)?.photo).map((r) => ({ key: r.venue.key, site: r.venue.website! }));
    if (sites.length > 0 && args.photos !== 'none') {
      const job = autoPhotos(deps, tripId, sites);
      if (args.photos === 'background') void job.catch(() => undefined);
      else await job;
    }
  }
  const fresh = args.save && top.length > 0 ? await readFood(deps.root, tripId) : food;
  return {
    date: args.date,
    slot: args.slot,
    window,
    anchor: { title: anchor.title, loc: anchor.loc },
    city: city ?? null,
    dishes: dishes.map((d) => d.id),
    generalMode: result.generalMode,
    radiusM: radius,
    maxWalkMin,
    dropped: result.dropped,
    attribution: '© OpenStreetMap contributors (ODbL)',
    note: '地圖資料只能確認這些店存在、營業時間（有寫的話）和菜系；沒有評分和評論數。評分請在 Google 地圖看（每家附了連結）。',
    saved: args.save === true && top.length > 0,
    results: top.map((r) => {
      // What an earlier look already learned about this place (a profile from pages the AI read, a photo of its own).
      const known = fresh.places.find((p) => p.key === r.venue.key || p.alsoKeys?.includes(r.venue.key));
      return {
      key: r.venue.key,
      name: r.venue.name,
      loc: r.venue.loc,
      distanceM: r.distanceM,
      walkMin: r.walkMin,
      tier: r.tier,
      score: r.score,
      why: r.why,
      flags: r.flags,
      open: r.open,
      ...(r.venue.hours ? { hours: r.venue.hours } : {}),
      ...(r.venue.website ? { website: r.venue.website } : {}),
      matches: r.matches,
      mapsUrl: mapsUrl(r.venue.name),
      evidence: r.evidence,
      ...(known?.profile ? { profile: known.profile } : {}),
      ...(known?.photo ? { photo: { path: `trips/${tripId}/${known.photo.file}`, pageUrl: known.photo.pageUrl } } : {}),
    };
    }),
  };
}

/** Every place with a website of its own (the board shows up to eight). Best effort: a place whose site has no picture, or does not answer, is just left without one. At most three at a time, each with its own time limit. */
async function autoPhotos(deps: FoodDeps, tripId: string, sites: { key: string; site: string }[]): Promise<void> {
  const queue = [...sites];
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      // Map data often has the plain http address; the page is only fetched over https.
      const page = next.site.replace(/^http:\/\//i, 'https://');
      try {
        await photoForPlace({ root: deps.root, now: deps.now, ...(deps.safe ?? {}) }, tripId, { place: next.key, pageUrl: page });
      } catch {
        /* no picture for this one */
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
}

/** Saves the share picture of a place's own page next to the trip and remembers it on the place. */
export async function photoForPlace(deps: Pick<FoodDeps, 'root' | 'now'> & SafeFetchDeps, tripId: string, args: { place: string; pageUrl: string; imageUrl?: string }) {
  const food = await readFood(deps.root, tripId);
  if (!food.places.some((p) => p.key === args.place)) throw new CliError(`找不到店：${args.place}（先用 food near --save 找到它）`);
  const photo = await fetchPlacePhoto({ ...deps, userAgent: userAgentFor(deps.root) }, tripId, { pageUrl: args.pageUrl, ...(args.imageUrl ? { imageUrl: args.imageUrl } : {}) });
  await updateFood(deps.root, tripId, (f) => setPhoto(f, args.place, { file: photo.file, pageUrl: photo.pageUrl, fetchedAt: iso(deps.now()) }));
  return { place: args.place, file: `trips/${tripId}/${photo.file}`, pageUrl: photo.pageUrl, bytes: photo.bytes };
}
