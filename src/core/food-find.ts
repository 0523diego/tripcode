// Finding places to eat a given dish near a given spot, from OpenStreetMap data (no key). Pure: the Overpass answer comes in as
// data, ranked venues go out.
//
// What OSM can and cannot say: it knows a place exists (and often its cuisine, hours, website, and when someone last checked it);
// it has NO quality signal, no ratings, no reviews. So the ranking here says "this looks like a place that serves that dish, is
// open then, and is close" and nothing more; the screen has to say so, and the user opens the place in Google Maps for the
// ratings. With a Google Places key a later step can add them (live, never stored).
//
// Matching dishes to places works where the dish names the shop (Japan, Taiwan: たこ焼き, お好み焼き), and fails where it does
// not (a Roman trattoria never has "carbonara" in its name): there the match falls back to the cuisine tag ("regional") and to
// words like trattoria and osteria, and says that it is the weaker kind of match.
import { windowsFor } from './hours.ts';
import { parseOpeningHours } from './opening-hours-osm.ts';
import type { Dish, Evidence, GuideListing } from './food-types.ts';
import type { OpeningHours } from './types.ts';

export interface OsmElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

export interface Venue {
  /** "osm:node/123". */
  key: string;
  name: string;
  /** Other spellings of the name (name:en, name:ja, name:zh ...), for matching. */
  names: string[];
  loc: { lat: number; lng: number };
  cuisines: string[];
  amenity: string;
  website?: string;
  /** Raw OSM opening_hours text. */
  hours?: string;
  checkDate?: string;
  brand?: string;
  alsoKeys: string[];
}

// ---------- OSM elements → venues ----------

const FOOD_AMENITIES = new Set(['restaurant', 'fast_food', 'cafe', 'ice_cream', 'food_court', 'bar', 'pub']);
const NAME_KEYS = ['name', 'name:en', 'name:ja', 'name:ja-Latn', 'name:zh', 'name:zh-Hant', 'name:it', 'official_name', 'alt_name'];

export function venuesFrom(elements: OsmElement[]): Venue[] {
  const out: Venue[] = [];
  for (const e of elements) {
    const t = e.tags ?? {};
    const amenity = t.amenity;
    if (!amenity || !FOOD_AMENITIES.has(amenity) || !t.name) continue;
    // A place whose tags say it closed (disused:amenity, abandoned:...) must not be offered.
    if (Object.keys(t).some((k) => k.startsWith('disused:') || k.startsWith('abandoned:') || k.startsWith('was:'))) continue;
    const lat = e.lat ?? e.center?.lat;
    const lng = e.lon ?? e.center?.lon;
    if (typeof lat !== 'number' || typeof lng !== 'number') continue;
    const names = [...new Set(NAME_KEYS.map((k) => t[k]).filter((v): v is string => !!v))];
    out.push({
      key: `osm:${e.type}/${e.id}`,
      name: t.name,
      names,
      loc: { lat, lng },
      cuisines: (t.cuisine ?? '').split(';').map((c) => c.trim().toLowerCase()).filter(Boolean),
      amenity,
      ...(t.website || t['contact:website'] ? { website: t.website ?? t['contact:website']! } : {}),
      ...(t.opening_hours ? { hours: t.opening_hours } : {}),
      ...(t.check_date ? { checkDate: t.check_date } : {}),
      ...(t.brand ? { brand: t.brand } : {}),
      alsoKeys: [],
    });
  }
  return out;
}

// ---------- distance, names ----------

export function meters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

/** Streets are not straight: 1.3 detour factor at 80 m a minute (4.8 km/h). */
export const walkMinutes = (m: number): number => Math.max(1, Math.round((m * 1.3) / 80));

/** Lower case, accents and punctuation removed; CJK kept as it is. */
export function norm(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const tokens = (s: string): string[] => norm(s).split(' ').filter((w) => w.length >= 3 || /[぀-ヿ㐀-鿿]/.test(w));
const STOP = new Set(['the', 'and', 'del', 'della', 'dei', 'dal', 'alla', 'al', 'da', 'di', 'cafe', 'bar', 'restaurant', 'ristorante']);

// ---------- duplicates ----------

export const DUPLICATE_METERS = 40;

/**
 * The same shop under two entries has the same name (one of its spellings) or one name contains the other whole ("Mizuno" and
 * "Mizuno Okonomiyaki"). Sharing a single word is NOT enough: "Pizzeria da Mario" and "Pizzeria Luigi", or two takoyaki stalls next
 * door, are different shops and one must not swallow the other.
 */
const GENERIC = new Set(['pizzeria', 'trattoria', 'osteria', 'ristorante', 'restaurant', 'taverna', 'cafe', 'ramen', 'sushi', 'kebab', 'pizza', 'bistro']);

function sameName(a: Venue, b: Venue): boolean {
  const usable = (s: string) => !GENERIC.has(s) && (/[\u3040-\u30ff\u3400-\u9fff]/.test(s) ? s.length >= 2 : s.length >= 5);
  const an = a.names.map(norm).filter(Boolean);
  const bn = b.names.map(norm).filter(Boolean);
  return an.some((x) => bn.some((y) => x === y || (usable(x) && y.includes(x)) || (usable(y) && x.includes(y))));
}

const richness = (v: Venue): number => (v.hours ? 2 : 0) + (v.checkDate ? 2 : 0) + (v.website ? 1 : 0) + v.cuisines.length;

/** Two entries for the same shop (a node and a building, or two mappers) become one; the richer entry stays, the other's key is kept in alsoKeys. */
export function mergeDuplicates(venues: Venue[]): Venue[] {
  const kept: Venue[] = [];
  for (const v of [...venues].sort((a, b) => richness(b) - richness(a))) {
    const twin = kept.find((k) => meters(k.loc, v.loc) <= DUPLICATE_METERS && sameName(k, v));
    if (twin) twin.alsoKeys.push(v.key, ...v.alsoKeys);
    else kept.push({ ...v, alsoKeys: [...v.alsoKeys] });
  }
  return kept;
}

// ---------- dish matching ----------

export type MatchHow = 'name' | 'cuisine' | 'venue-word';
export interface DishMatch {
  dishId: string;
  how: MatchHow;
}

/** A dish name that ends in a particle ("お好み焼き") also matches the shop name without it ("お好み焼三平"). */
function stems(name: string): string[] {
  const n = norm(name);
  const cjk = /[぀-ヿ㐀-鿿]/.test(n);
  return cjk && n.length >= 4 ? [n, n.slice(0, -1)] : [n];
}

export function matchDishes(venue: Venue, dishes: Dish[]): DishMatch[] {
  const hay = venue.names.map(norm);
  const cuisines = venue.cuisines.map(norm);
  const out: DishMatch[] = [];
  for (const dish of dishes) {
    const wanted = dish.match.names.flatMap(stems).filter((s) => s.length >= (/[぀-ヿ㐀-鿿]/.test(s) ? 2 : 4));
    const cuisineWords = [...(dish.match.cuisines ?? []), ...dish.match.names].map(norm);
    if (wanted.some((w) => hay.some((h) => h.includes(w)))) out.push({ dishId: dish.id, how: 'name' });
    else if (cuisineWords.some((w) => w.length >= 3 && cuisines.includes(w))) out.push({ dishId: dish.id, how: 'cuisine' });
    else if ((dish.match.venueWords ?? []).map(norm).some((w) => hay.some((h) => h.split(' ').includes(w)))) out.push({ dishId: dish.id, how: 'venue-word' });
  }
  return out;
}

// ---------- opening hours at the meal ----------

export type OpenStatus = 'open' | 'closed' | 'unknown';
/** A meal that starts when the kitchen is about to close is not a meal. */
export const CLOSING_MARGIN_MIN = 45;

/**
 * Can you eat there in the meal's window? True when the place is open for at least CLOSING_MARGIN_MIN minutes inside
 * [startMin, endMin]: a place that opens at 12:30 is fine for a 12:00–14:30 lunch, one that closes at 14:40 is not.
 * `weekday`: 0 = Sunday. Unknown when the hours text is not a simple form.
 */
export function openStatus(hoursText: string | undefined, weekday: number, startMin: number, endMin: number = startMin + 90): OpenStatus {
  if (!hoursText) return 'unknown';
  const hours: OpeningHours | undefined = parseOpeningHours(hoursText);
  if (!hours) return 'unknown';
  const fits = windowsFor(hours, weekday).some((w) => {
    // A window that runs to midnight continues into the next day's early hours ("12:00-01:00").
    const spill = w.close >= 1440 ? (windowsFor(hours, (weekday + 1) % 7).find((n) => n.open === 0)?.close ?? 0) : 0;
    return Math.min(w.close + spill, endMin) - Math.max(w.open, startMin) >= CLOSING_MARGIN_MIN;
  });
  return fits ? 'open' : 'closed';
}

// ---------- the guide's picks ----------

/** A listing is the same place as a venue when it is within this many metres and the names agree. */
export const LISTING_METERS = 90;

/**
 * Which venues a travel guide's editors listed. A venue counts as listed when a listing lies within LISTING_METERS of it and has
 * the same name (or one name contains the other whole). Returns the listing for each such venue (keyed by venue key). This is a
 * lead that someone who knows the city picked the place, not a rating.
 */
export function matchListings(venues: Venue[], listings: GuideListing[]): Map<string, GuideListing> {
  const out = new Map<string, GuideListing>();
  const usable = (s: string) => !GENERIC.has(s) && (/[\u3040-\u30ff\u3400-\u9fff]/.test(s) ? s.length >= 2 : s.length >= 4);
  for (const v of venues) {
    const vn = v.names.map(norm).filter(Boolean);
    const hit = listings.find((l) => {
      if (meters(v.loc, { lat: l.loc.lat, lng: l.loc.lng }) > LISTING_METERS) return false;
      const ln = [l.name, l.alt ?? ''].map(norm).filter(Boolean);
      return ln.some((x) => vn.some((y) => x === y || (usable(x) && y.includes(x)) || (usable(y) && x.includes(y))));
    });
    if (hit) out.set(v.key, hit);
  }
  return out;
}

// ---------- ranking ----------

export type Flag = 'near-landmark' | 'chain' | 'fast-food' | 'merged-duplicate' | 'hours-unknown' | 'stale-data';
export type Tier = 'safe' | 'likely' | 'check';

export interface RankedVenue {
  venue: Venue;
  distanceM: number;
  walkMin: number;
  matches: DishMatch[];
  open: OpenStatus;
  flags: Flag[];
  tier: Tier;
  score: number;
  /** Short reasons, in order of weight, for the screen. */
  why: string[];
  evidence: Evidence[];
}

export interface RankInput {
  venues: Venue[];
  dishes: Dish[];
  anchor: { lat: number; lng: number };
  /** 0 = Sunday. */
  weekday: number;
  /** Minute of the day the meal window starts and ends. */
  startMin: number;
  endMin?: number;
  maxWalkMin: number;
  /** Places already rejected by the travellers. */
  rejected?: Set<string>;
  /** Other stops of the trip, to flag places right beside a landmark. */
  landmarks?: { lat: number; lng: number }[];
  /** Venue keys a source recommended (a web page the AI read): worth a lot. */
  recommended?: Set<string>;
  /** What a travel guide's editors listed near here; a venue that matches one is recommended by that guide. */
  listings?: GuideListing[];
  /** Kinds of place to offer (default: sit-down and fast food; a snack may want the rest). */
  amenities?: ReadonlySet<string>;
  now: Date;
}

export interface RankResult {
  ranked: RankedVenue[];
  /**
   * No place could be tied to any of the dishes (normal in Italy, where a trattoria's name never says "carbonara"): the list is then
   * every fitting place by evidence alone, and the screen must say that the dish is not confirmed for any of them.
   */
  generalMode: boolean;
  /** What was left out and why, so nothing vanishes silently. */
  dropped: { closed: number; far: number; rejected: number; noMatch: number };
}

export const DEFAULT_AMENITIES: ReadonlySet<string> = new Set(['restaurant', 'fast_food', 'food_court']);
const NEAR_LANDMARK_M = 150;
const FRESH_MONTHS = 18;

const monthsSince = (date: string, now: Date): number => (now.getTime() - Date.parse(date)) / (30.44 * 86_400_000);

export function rankVenues(input: RankInput): RankResult {
  const { dishes, anchor, now } = input;
  const dropped = { closed: 0, far: 0, rejected: 0, noMatch: 0 };
  const ranked: RankedVenue[] = [];
  const brandCount = new Map<string, number>();
  for (const v of input.venues) if (v.brand) brandCount.set(v.brand, (brandCount.get(v.brand) ?? 0) + 1);
  const amenities = input.amenities ?? DEFAULT_AMENITIES;
  const endMin = input.endMin ?? input.startMin + 90;

  // Who is even a candidate: the right kind of place, not rejected, close enough, open in the window. Only then is it asked
  // whether any of them can be tied to a dish (general mode), so a far or closed match cannot decide it.
  const fit: { venue: Venue; distanceM: number; walkMin: number; open: OpenStatus }[] = [];
  for (const venue of input.venues.filter((v) => amenities.has(v.amenity))) {
    if (input.rejected?.has(venue.key) || venue.alsoKeys.some((k) => input.rejected?.has(k))) {
      dropped.rejected++;
      continue;
    }
    const distanceM = Math.round(meters(anchor, venue.loc));
    const walkMin = walkMinutes(distanceM);
    if (walkMin > input.maxWalkMin) {
      dropped.far++;
      continue;
    }
    const open = openStatus(venue.hours, input.weekday, input.startMin, endMin);
    if (open === 'closed') {
      dropped.closed++;
      continue;
    }
    fit.push({ venue, distanceM, walkMin, open });
  }
  const listed = matchListings(fit.map((f) => f.venue), input.listings ?? []);
  const generalMode = dishes.length > 0 && fit.every((f) => matchDishes(f.venue, dishes).length === 0);

  for (const { venue, distanceM, walkMin, open } of fit) {
    const matches = dishes.length > 0 && !generalMode ? matchDishes(venue, dishes) : [];
    if (dishes.length > 0 && !generalMode && matches.length === 0) {
      dropped.noMatch++;
      continue;
    }
    const guide = listed.get(venue.key);
    const recommended = !!guide || (input.recommended?.has(venue.key) ?? false) || venue.alsoKeys.some((k) => input.recommended?.has(k));
    // A branded outlet is a chain even when only one of them shows up in this radius; a counter-service place is fast food.
    const chain = !!venue.brand || (brandCount.get(venue.brand ?? '') ?? 0) >= 2;
    const fastFood = venue.amenity === 'fast_food';
    const fresh = !!venue.checkDate && monthsSince(venue.checkDate, now) <= FRESH_MONTHS;
    const byName = matches.some((m) => m.how === 'name');
    const byCuisine = matches.some((m) => m.how === 'cuisine');
    const byWord = matches.some((m) => m.how === 'venue-word');
    const detour = Math.max(0, walkMin - 5);

    const score =
      (recommended ? 3 : 0) +
      (byName ? 2 : byCuisine ? 1 : byWord ? 0.5 : 0) +
      (open === 'open' ? 1 : 0) +
      (fresh ? 1 : 0) +
      (venue.website ? 0.5 : 0) -
      (chain ? 1.5 : 0) -
      (fastFood ? 4 : 0) -
      0.5 * (detour / 5);

    const flags: Flag[] = [];
    if (input.landmarks?.some((l) => meters(l, venue.loc) <= NEAR_LANDMARK_M)) flags.push('near-landmark');
    if (chain) flags.push('chain');
    if (fastFood) flags.push('fast-food');
    if (venue.alsoKeys.length > 0) flags.push('merged-duplicate');
    if (open === 'unknown') flags.push('hours-unknown');
    if (venue.checkDate && !fresh) flags.push('stale-data');

    const why: string[] = [];
    if (guide) why.push(`旅遊指南（Wikivoyage）列為推薦${guide.lastedit ? `，編修 ${guide.lastedit.slice(0, 7)}` : ''}`);
    else if (recommended) why.push('有來源推薦');
    if (generalMode) why.push('無法確認有沒有這道菜');
    else if (byName) why.push('店名就是這道菜');
    else if (byCuisine) why.push('地圖標的菜系對得上');
    else if (byWord) why.push('是這類傳統餐館（只能推測有這道菜）');
    if (open === 'open') why.push('用餐時間有營業');
    if (fresh) why.push(`地圖資料 ${venue.checkDate} 查過`);

    const evidence: Evidence[] = [
      { kind: 'map-osm', claim: 'exists', source: venue.key, fetchedAt: now.toISOString().replace(/\.\d+Z$/, 'Z'), confidence: fresh ? 'recent' : 'reference', ...(venue.checkDate ? { detail: `OSM 資料檢查日 ${venue.checkDate}` } : {}) },
      ...(guide ? [{ kind: 'guide-wikivoyage', claim: 'recommended', source: guide.source.url, fetchedAt: guide.source.fetchedAt, confidence: guide.lastedit && monthsSince(guide.lastedit, now) <= 36 ? 'recent' : 'reference', detail: `Wikivoyage 指南推薦${guide.lastedit ? `（編修 ${guide.lastedit}）` : ''}` } satisfies Evidence] : []),
      ...(open === 'open' && venue.hours ? [{ kind: 'map-osm', claim: 'open-at-slot', source: venue.key, fetchedAt: now.toISOString().replace(/\.\d+Z$/, 'Z'), confidence: 'reference', detail: `OSM 營業時間：${venue.hours}`.slice(0, 80) } satisfies Evidence] : []),
    ];

    ranked.push({
      venue,
      distanceM,
      walkMin,
      matches,
      open,
      flags,
      // Without a rating, "safe" means: it is open then and the shop itself says it serves the dish (or a source recommends it).
      tier: open === 'open' && (byName || recommended) ? 'safe' : 'likely',
      score: Math.round(score * 100) / 100,
      why,
      evidence,
    });
  }
  ranked.sort((a, b) => b.score - a.score || a.distanceM - b.distanceM || a.venue.name.localeCompare(b.venue.name));
  return { ranked, generalMode, dropped };
}
