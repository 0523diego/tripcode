// The food guide of a trip (trips/<id>/food.json): which local dishes are worth eating in each city, what the travellers like
// and avoid, and the places that were looked at for a meal, each with the evidence that it exists and is worth a visit.
// Only code (src/core/food.ts, `tripcode food …`) writes this file, so every field passes the same checks.
//
// What is stored and what is not: dish names, one-line reasons in our own words, links to sources, evidence about a place
// (exists, open then, recommended by) with where and when it was seen. Ratings and review counts from Google are NEVER stored
// (their terms limit it): they are shown live and forgotten. Text copied from Wikivoyage is not stored either, only names and links.

import type { Confidence, LatLng } from './types.ts';

export type MealSlot = 'breakfast' | 'lunch' | 'dinner' | 'snack';
export const MEAL_SLOTS: readonly MealSlot[] = ['breakfast', 'lunch', 'dinner', 'snack'];

export interface FoodSource {
  kind: 'wikivoyage' | 'wikipedia' | 'web' | 'michelin' | 'ai' | 'user';
  /** https only. A source of kind 'ai' has none: it is the AI's own recollection. */
  url?: string;
  /** Page or site name, in our own words. */
  title?: string;
  /** Wikivoyage revision id (or last-edit date) of the page the name came from. */
  revision?: string;
  fetchedAt: string;
}

export interface Dish {
  /** kebab-case, unique in the file: "amatriciana". */
  id: string;
  /** Matches Day.city, e.g. "羅馬". */
  city: string;
  nameZh: string;
  nameLocal: string;
  romanized?: string;
  /** One line, our own words: why this dish. */
  why: string;
  howTo?: string;
  slots?: MealSlot[];
  /** Lower-case kebab tags: pork, beef, seafood, raw, offal, spicy, vegetarian-ok, street-food, sit-down, dessert, ... */
  tags: string[];
  /** What to look for in a place's name or cuisine tag to say it serves this dish. */
  match: { names: string[]; cuisines?: string[]; venueWords?: string[] };
  /** Only 'ai' as a source means 「AI 的印象，尚未查證」. */
  sources: FoodSource[];
}

export const DIETS = ['vegetarian', 'vegan', 'halal', 'no-pork', 'no-beef', 'no-seafood', 'no-raw'] as const;
export type Diet = (typeof DIETS)[number];

export interface Taste {
  avoidDishes: string[];
  avoidTags: string[];
  likeTags: string[];
  diet: Diet[];
  allergies?: string;
  budget?: 'low' | 'mid' | 'high';
  queue?: 'no' | 'short' | 'ok';
  kids?: boolean;
  /** Walking minutes from the anchor; 10 when absent. */
  maxWalkMin?: number;
}

export interface Evidence {
  kind: 'map-osm' | 'map-google' | 'guide-wikivoyage' | 'web' | 'michelin' | 'user-link' | 'ai-memory';
  claim: 'exists' | 'open-at-slot' | 'closed-at-slot' | 'recommended' | 'serves-dish' | 'permanently-closed';
  /** URL, or a provider tag like "osm:node/123". */
  source: string;
  fetchedAt: string;
  confidence: Confidence;
  /** At most 80 characters in our own words; never a rating. */
  detail?: string;
}

/** What a place is like, in our own words, from pages the AI actually read (each listed in `sources`). Never a rating or a score. */
export interface PlaceProfile {
  /** What kind of place it is and why it is worth the walk: at most 160 characters. */
  summary: string;
  /** What to order, as the pages say (up to 5, each at most 40 characters). */
  order?: string[];
  /** The price as a page states it ("主菜約 €15–25"); only allowed with sources. */
  price?: string;
  /** What to know before going: a queue, cash only, the tourist menu, closes early (at most 120 characters). */
  watch?: string;
  /** The pages the profile comes from (https, 1–3). */
  sources: string[];
  fetchedAt: string;
}

/** A picture of the place from its own page, saved next to the trip. The picture belongs to the place: the card credits and links the page. */
export interface PlacePhoto {
  /** Relative to the trip folder: "attachments/food-<hash>.jpg". */
  file: string;
  /** The page it came from (https). */
  pageUrl: string;
  fetchedAt: string;
}

export interface FoodPlace {
  /** "osm:node/7082306423" or a Google place id. */
  key: string;
  name: string;
  nameLocal?: string;
  loc: LatLng;
  /** Keys of nodes merged into this one as duplicates. */
  alsoKeys?: string[];
  city: string;
  dishes: string[];
  evidence: Evidence[];
  profile?: PlaceProfile;
  photo?: PlacePhoto;
}

export type RejectReason = 'touristy' | 'far' | 'pricey' | 'meh' | 'closed' | 'other';
export const REJECT_REASONS: readonly RejectReason[] = ['touristy', 'far', 'pricey', 'meh', 'closed', 'other'];

/** An entry a travel-guide editor picked ("Wikivoyage lists it under Eat"), with where and when. A lead for ranking places: it is not a quality score. */
export interface GuideListing {
  name: string;
  alt?: string;
  loc: { lat: number; lng: number };
  city: string;
  /** The page the entry is on, its revision when it was read, and when. */
  source: { url: string; title: string; revision?: string; fetchedAt: string };
  /** YYYY-MM-DD, the editors' last touch of this entry. */
  lastedit?: string;
}

/** One place of a shortlist: how it looked in that search (distance, why it ranked, whether it was open). No rating. */
export interface ShortlistItem {
  key: string;
  distanceM: number;
  walkMin: number;
  tier: 'safe' | 'likely' | 'check';
  /** Reasons in our own words, at most 4. */
  why: string[];
  flags: string[];
  open: 'open' | 'closed' | 'unknown';
  hours?: string;
  website?: string;
  mapsUrl: string;
}

/** The result of one search (`food near --save`): what the board on the left of the screen shows while the AI talks about it. */
export interface ShortlistBatch {
  at: string;
  date: string;
  slot: 'lunch' | 'dinner';
  /** Where the search started ("大英博物館"). */
  anchor: string;
  city?: string;
  items: ShortlistItem[];
}

export interface FoodFile {
  version: 1;
  taste: Taste;
  dishes: Dish[];
  /** dish id → what the travellers said. */
  votes: Record<string, 'want' | 'no'>;
  places: FoodPlace[];
  /** The latest searches, newest last (at most 3). */
  shortlist: ShortlistBatch[];
  /** What the travel guide's editors listed (see GuideListing); used to tell a recommended place from an arbitrary one. */
  listings: GuideListing[];
  rejected: { key: string; reason?: RejectReason; at: string }[];
  /** Credits owed to the data sources used ("© OpenStreetMap contributors (ODbL)"). */
  attribution: string[];
}
