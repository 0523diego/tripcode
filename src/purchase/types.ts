// Watches: things to look at on a schedule (a price, whether tickets can be bought yet) and the alerts they raise.
// Dependency-free like src/core/types.ts. TripCode does not pay for anything: the AI-payment layer was taken out on
// 2026-11-04 (a copy is kept outside the repo); what stays is reading pages and sale-date reminders.
import type { Money } from '../core/types.ts';

export type { Money };

/** Something to look at on a schedule: a price, or whether tickets can be bought yet. */
export interface Watch {
  /** kebab-case, unique within the trip. */
  id: string;
  title: string;
  /** https page to read. */
  url: string;
  kind: 'price' | 'availability';
  /** Minutes between looks. At least 60: this is personal, low-frequency reading. */
  everyMinutes: number;
  active: boolean;
  createdAt: string;
  /** Trip item this is for. */
  itemId?: string;
  /** ISO 4217. A price in another currency is treated as unreadable rather than compared. */
  currency?: string;
  /** Alert when the price is at or below this. */
  targetPrice?: number;
  /** Alert when the price fell by at least this many percent since the last reading. */
  dropPercent?: number;
  /** price: first capture group is the amount. availability: matches when the thing can be bought. */
  regex?: string;
  /** ISO date-time tickets go on sale. Alerts one day before and when it opens; no page needed. */
  opensAt?: string;
  /** YYYY-MM-DD: stop looking after this day. */
  until?: string;
  /** Read the page in TripCode's own Chrome (JavaScript runs, a consent choice made once is remembered) instead of a plain download. */
  render?: boolean;
}

/** One look at a watched page. */
export interface Sample {
  watchId: string;
  /** ISO timestamp of the look. */
  at: string;
  ok: boolean;
  amount?: number;
  currency?: string;
  /** How the price was read: 'regex' | 'json-ld' | 'meta' | 'itemprop'. */
  via?: string;
  available?: boolean;
  error?: string;
}

export type AlertKind = 'target' | 'drop' | 'available' | 'opens-soon' | 'opens' | 'unreadable';

export interface Alert {
  id: string;
  watchId: string;
  at: string;
  kind: AlertKind;
  /** Traditional Chinese, ready to show. */
  message: string;
  amount?: number;
  currency?: string;
  seen: boolean;
}

export class PurchaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PurchaseError';
  }
}
