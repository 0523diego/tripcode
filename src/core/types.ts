// The TripCode data contract. Every trip lives in trips/<id>/trip.ts as
// `export default defineTrip({...})`. Claude Code edits these files; the
// viewer renders them; src/core/source-edit.ts makes the few targeted edits
// the viewer is allowed to make (comments, locked-item fields, candidate status).
//
// Keep this file free of runtime dependencies: it is imported by the viewer
// (browser), the CLI (Node with type stripping) and every trip file.

/** How fresh and trustworthy a sourced value is. */
export type Confidence = 'live' | 'recent' | 'reference';

/**
 * A fact that came from somewhere. Prices, durations and opening hours must be
 * wrapped in Sourced — `npm run check` rejects bare numbers for these fields.
 */
export interface Sourced<T> {
  value: T;
  /** URL, or a provider tag such as "google-routes" / "user". */
  source: string;
  /** ISO 8601 timestamp of when the value was fetched. */
  fetchedAt: string;
  confidence: Confidence;
}

export interface Money {
  /** Amount in major units (e.g. 54000 for ¥54,000, 12.5 for CHF 12.50). */
  amount: number;
  /** ISO 4217 code, e.g. "JPY", "CHF", "TWD". */
  currency: string;
}

export interface LatLng {
  lat: number;
  lng: number;
  /** Google allows caching coordinates for at most 30 days. */
  fetchedAt?: string;
}

/** Weekly opening hours. `day` follows JS Date#getDay(): 0 = Sunday. */
export interface OpeningHours {
  periods: { day: number; open: string; close: string }[];
  /** Specific dates (YYYY-MM-DD) the place is closed. */
  closedDates?: string[];
}

/**
 * A file kept with the trip (ticket, booking confirmation, pass). Files live under
 * trips/<id>/tickets/ (gitignored: personal data) and can be synced to Notion for phone access.
 */
export interface Attachment {
  /** Path relative to the trip folder, e.g. "tickets/rigi-day-pass.pdf". */
  file: string;
  /** Human label, e.g. 「Rigi 一日券」. */
  label: string;
  kind?: 'transport' | 'entry' | 'booking' | 'other';
}

/** Whether a place or ticket has to be bought or reserved ahead. 'unknown' = nobody has looked yet. */
export type BookingNeed = 'required' | 'recommended' | 'none' | 'unknown';
export type BookingStatus = 'todo' | 'booked' | 'not-needed';
export type BookingCategory = 'entry' | 'timed-entry' | 'transport' | 'lodging' | 'flight' | 'restaurant' | 'show' | 'other';

/**
 * A place to buy this from. Exactly one `official` entry is the operator's own page; `reseller` entries
 * (Klook, Trip.com, ...) are only ever shown next to it, never in its place. `urlKind: 'search'` means the link
 * is a search for the thing, not a page that was checked to be it. Links carry no affiliate or tracking parameters.
 */
export interface Seller {
  kind: 'official' | 'reseller';
  /** "Klook", "Trip.com", or the operator's name. */
  name: string;
  urlKind: 'product' | 'search';
  link: Sourced<string>;
}

/** What it takes to get in or get a seat, and where things stand. Written next to the item it belongs to. */
export interface Booking {
  need: BookingNeed;
  status: BookingStatus;
  category?: BookingCategory;
  /** The operator's own home page: what proves "this is the official one". */
  officialSite?: Sourced<string>;
  /** The page where the ticket is bought. Reached from `officialSite`, or pasted by the user. Never a reseller. */
  bookingUrl?: Sourced<string>;
  /** Everything the user can choose from: the official page first, then resellers. */
  sellers?: Seller[];
  /** Entry is by time slot. */
  timedSlots?: Sourced<boolean>;
  /** ISO 8601 with offset: when tickets go on sale. */
  opensAt?: Sourced<string>;
  /** "Opens N days before the visit" (turned into a date from the item's day). */
  opensRule?: Sourced<{ daysBefore: number; at?: string }>;
  /** ISO 8601: last time to buy, or last time to cancel for free. */
  deadline?: Sourced<string>;
  /** One sentence: refund and change terms. */
  cancellation?: Sourced<string>;
  /** When the user pressed 「我買好了」. */
  bookedAt?: string;
  /** Where it was bought: 'official', 'Klook', ... */
  boughtVia?: string;
  /** Sources disagree: say how, e.g. 「官網 9:00–19:30，第三方 9:30–17:50」. */
  conflict?: string;
}

interface ItemBase {
  /** Stable, unique within the trip, kebab-case, e.g. "kapellbruecke". */
  id: string;
  title: string;
  /** Local time "HH:MM" on the item's day. */
  start?: string;
  end?: string;
  placeId?: string;
  loc?: LatLng;
  /** Locked items (booked hotels, flights, must-dos) are never changed by AI. */
  locked?: boolean;
  note?: string;
  /** Non-Google hours source (e.g. official site). Google hours are fetched live. */
  hours?: Sourced<OpeningHours>;
  /** Tickets and booking files for this item. */
  attachments?: Attachment[];
  /** What has to be bought or reserved for this, and its status. Absent = nobody has looked. */
  booking?: Booking;
}

export type Item = ItemBase &
  (
    | { kind: 'poi'; minutes?: number; ticket?: Sourced<Money> }
    | {
        kind: 'meal';
        slot?: 'breakfast' | 'lunch' | 'dinner' | 'snack';
        /** Ids of the dishes (trips/<id>/food.json) this meal is meant to be. */
        dishes?: string[];
        checks?: MealChecks;
      }
    | { kind: 'hotel'; nights: number; price?: Sourced<Money>; bookingRef?: string }
    | {
        kind: 'transit';
        mode: 'walk' | 'train' | 'bus' | 'tram' | 'boat' | 'cable-car' | 'taxi' | 'drive';
        /** Minutes. */
        duration?: Sourced<number>;
        fare?: Sourced<Money>;
      }
    | {
        kind: 'flight';
        flightNo: string;
        from?: string;
        to?: string;
        price?: Sourced<Money>;
        bookingRef?: string;
      }
    | { kind: 'free' }
  );

/** What was found out about the place chosen for a meal. Only facts with a source and a date; never a rating. */
export interface MealChecks {
  /** The place exists (seen on a map: "osm:node/…", a Google place, or a link the user pasted). */
  exists?: Sourced<boolean>;
  /** Open when the meal starts, from the place's own opening hours. Never written as false: a place closed then is not chosen. */
  openAtSlot?: Sourced<boolean>;
  /** Pages that recommend it; the value is a short label, the source the address. */
  recommendedBy?: Sourced<string>[];
}

export type ItemKind = Item['kind'];

export interface Day {
  /** YYYY-MM-DD */
  date: string;
  title?: string;
  /** The city this day belongs to, e.g. "米蘭". The booking page groups what to buy by it; without it, by where you sleep. */
  city?: string;
  /**
   * The day's color, 1–8 (the viewer's --day-N palette). Absent = automatic: days that sleep in the same hotel share one
   * color (src/core/day-colors.ts). Set from the viewer's color dot next to the day's heading.
   */
  color?: number;
  /** 'clear' marks a day that needs good weather and may be swapped with an 'any' day. */
  weather?: 'clear' | 'any';
  /** Day-structure notes (readiness codes such as 'walking-heavy') the user looked at and accepts for this day. */
  accepted?: string[];
  items: Item[];
}

export type CandidateStatus = 'unconfirmed' | 'accepted' | 'discuss' | 'rejected';

/** A place on the map that is not (yet) scheduled into a day. */
export interface Candidate {
  id: string;
  title: string;
  placeId?: string;
  loc?: LatLng;
  status: CandidateStatus;
  /** When status is 'accepted': 1-based day number the user wants it on. Claude schedules it. */
  day?: number;
  /** Where it came from, e.g. ["inbox/01.md", "inbox/04.md"] or ["claude"]. */
  sources: string[];
  /** Why Claude recommends it (for AI suggestions). */
  why?: string;
}

export interface Trip {
  title: string;
  /** YYYY-MM-DD */
  start: string;
  end: string;
  /** IANA time zone of the destination, e.g. "Europe/Zurich". */
  tz: string;
  party: { adults: number; childrenAges: number[] };
  /** styles/<id>.md */
  style?: string;
  /** destinations/<id>.md */
  destination?: string;
  days: Day[];
  candidates: Candidate[];
}

/** Identity helper that gives trip files type checking and editor completion. */
export function defineTrip(trip: Trip): Trip {
  return trip;
}

/** One problem reported by the trip check (`npm run check` and the viewer). */
export interface Issue {
  level: 'error' | 'warn';
  /** Machine-readable code, e.g. "overlap", "closed", "missing-source". */
  code: string;
  /** Day date (YYYY-MM-DD) the issue belongs to, if any. */
  date?: string;
  itemId?: string;
  /** Human-readable message in Traditional Chinese. */
  message: string;
}
