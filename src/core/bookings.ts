// The booking list: what in a trip has to be bought or reserved, where, and by when. It is a view of the trip,
// not a second database: every row is derived from the items (and their optional `booking` field), and each row
// says why it is there so a wrong guess is visible. Pure: `now` is injected.

import type { Booking, BookingCategory, BookingNeed, BookingStatus, Item, Trip } from './types.ts';
import { addDays, isIsoDate } from './time.ts';
import { stayByNight } from './lodging.ts';

export type Urgency = 'overdue' | 'now' | 'soon' | 'later' | 'none';

/** How a row got onto the list. 'explicit' = the item has a `booking` field; the others are guesses and say so. */
export type Basis = 'explicit' | 'locked' | 'kind' | 'keyword' | 'gap';

export type LinkKey = 'official' | 'klook' | 'tripcom';

export interface BookingLink {
  key: LinkKey;
  label: string;
  url: string;
  /** product = a page that was checked; site = the operator's home page; search = only a search for it. */
  urlKind: 'product' | 'site' | 'search';
  source?: string;
  fetchedAt?: string;
}

export interface BookingTodo {
  itemId: string;
  date: string;
  title: string;
  category: BookingCategory;
  need: BookingNeed;
  status: BookingStatus;
  /** Why this row exists. Always shown. */
  reason: string;
  basis: Basis;
  urgency: Urgency;
  /** YYYY-MM-DD: tickets open / the last day to buy or cancel for free. */
  opensOn?: string;
  deadlineOn?: string;
  cancellation?: string;
  conflict?: string;
  timedSlots?: boolean;
  /** Official first, then Klook and Trip.com; a search link is the floor. Empty only for a lodging gap, which has nothing to link. */
  links: BookingLink[];
  hasVoucher: boolean;
  bookedAt?: string;
  boughtVia?: string;
}

// ---------- links ----------

/** Hosts that sell on behalf of others. They may be offered as an option, never as "the official page". */
export const RESELLER_HOSTS = ['klook.com', 'trip.com', 'kkday.com', 'getyourguide.com', 'viator.com', 'tiqets.com', 'headout.com', 'musement.com', 'tripadvisor.com', 'expedia.com'];

const TRACKING_PARAM = /^(utm_.*|aff.*|affiliate.*|ref|ref_.*|referrer|partner.*|aid|cid|cmp|campaign.*|gclid|fbclid|msclkid|irclickid|clickref|mc_.*|_ga|source|sid)$/i;

export function hostMatches(host: string, list: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/^www\./, '');
  return list.some((d) => h === d || h.endsWith(`.${d}`));
}

export function isResellerUrl(url: string): boolean {
  try {
    return hostMatches(new URL(url).hostname, RESELLER_HOSTS);
  } catch {
    return false;
  }
}

/** https only; tracking and affiliate parameters and the fragment are dropped. Returns undefined for anything else. */
export function cleanBookingUrl(raw: string): string | undefined {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return undefined;
  for (const key of [...u.searchParams.keys()]) if (TRACKING_PARAM.test(key)) u.searchParams.delete(key);
  u.hash = '';
  return u.toString();
}

const google = (q: string) => `https://www.google.com/search?q=${encodeURIComponent(q)}`;

/** Plain searches, so every row has somewhere to go without anyone guessing a seller's own URL format. */
export function searchLinks(title: string, city?: string): BookingLink[] {
  const name = [title.replace(/[（(].*?[）)]/g, '').trim() || title, city].filter(Boolean).join(' ');
  return [
    { key: 'official', label: '找官方購票頁', url: google(`${name} official tickets`), urlKind: 'search' },
    { key: 'klook', label: 'Klook', url: google(`${name} site:klook.com`), urlKind: 'search' },
    { key: 'tripcom', label: 'Trip.com', url: google(`${name} site:trip.com`), urlKind: 'search' },
  ];
}

const SELLER_KEY: Record<string, LinkKey> = { klook: 'klook', 'trip.com': 'tripcom', tripcom: 'tripcom' };
const sellerKey = (name: string): LinkKey | undefined => SELLER_KEY[name.trim().toLowerCase()];

/** The three choices for one item: what was verified wins over the search fallback, per slot. */
export function linksFor(title: string, booking: Booking | undefined, city?: string): BookingLink[] {
  const out = searchLinks(title, city);
  const set = (key: LinkKey, link: BookingLink) => {
    const i = out.findIndex((l) => l.key === key);
    if (i >= 0) out[i] = link;
  };
  const o = booking?.bookingUrl ?? undefined;
  const site = booking?.officialSite ?? undefined;
  if (o && cleanBookingUrl(o.value) && !isResellerUrl(o.value)) {
    set('official', { key: 'official', label: '官方購票頁', url: cleanBookingUrl(o.value)!, urlKind: 'product', source: o.source, fetchedAt: o.fetchedAt });
  } else if (site && cleanBookingUrl(site.value) && !isResellerUrl(site.value)) {
    set('official', { key: 'official', label: '官網（從這裡找購票）', url: cleanBookingUrl(site.value)!, urlKind: 'site', source: site.source, fetchedAt: site.fetchedAt });
  }
  for (const s of booking?.sellers ?? []) {
    const url = cleanBookingUrl(s.link.value);
    if (!url) continue;
    if (s.kind === 'official') {
      if (!isResellerUrl(url)) set('official', { key: 'official', label: s.urlKind === 'product' ? '官方購票頁' : '官方', url, urlKind: s.urlKind, source: s.link.source, fetchedAt: s.link.fetchedAt });
      continue;
    }
    const key = sellerKey(s.name);
    if (key) set(key, { key, label: s.name, url, urlKind: s.urlKind, source: s.link.source, fetchedAt: s.link.fetchedAt });
  }
  return out;
}

// ---------- deriving the list ----------

const STRONG = [
  '尚未訂票', '尚未訂', '要預約', '需預約', '需要預約', '一律要預約', '預約時段', '開賣', '售完', '釋出', '搶票', '提前訂', '訂位',
  'reservation required', 'book in advance', 'timed entry', 'sold out', 'prenotazione obbligatoria',
];
const WEAK = ['票價', '門票', 'ticket', 'biglietto'];
/** The note says no reservation is needed (for all or part of the place). */
const NO_RESERVATION = ['免費免預約', '不需預約', '不用預約', '免預約', '現場買票即可', '現場購票即可'];
/** The note says it is already booked. */
const ALREADY = ['已訂', '已買', '已預約'];

const hit = (text: string, words: string[]) => words.some((w) => text.toLowerCase().includes(w.toLowerCase()));

function categoryOf(item: Item): BookingCategory {
  if (item.booking?.category) return item.booking.category;
  switch (item.kind) {
    case 'flight': return 'flight';
    case 'hotel': return 'lodging';
    case 'transit': return 'transport';
    case 'meal': return 'restaurant';
    default: return item.booking?.timedSlots?.value ? 'timed-entry' : 'entry';
  }
}

const hasVoucher = (item: Item) => (item.attachments ?? []).length > 0;
const dateOf = (iso: string | undefined) => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : undefined);

function daysBetween(a: string, b: string): number {
  const [y1, m1, d1] = a.split('-').map(Number);
  const [y2, m2, d2] = b.split('-').map(Number);
  return Math.round((Date.UTC(y2!, m2! - 1, d2!) - Date.UTC(y1!, m1! - 1, d1!)) / 86_400_000);
}

function urgencyOf(t: Pick<BookingTodo, 'status' | 'need' | 'date' | 'opensOn' | 'deadlineOn'>, today: string): Urgency {
  if (t.status !== 'todo') return 'none';
  if ((t.deadlineOn && t.deadlineOn < today) || t.date < today) return 'overdue';
  const toVisit = daysBetween(today, t.date);
  const soonOpen = t.opensOn !== undefined && daysBetween(today, t.opensOn) <= 7;
  const soonDeadline = t.deadlineOn !== undefined && daysBetween(today, t.deadlineOn) <= 7;
  if (soonOpen || soonDeadline || (t.need === 'required' && toVisit <= 14)) return 'now';
  if (toVisit <= 30 || (t.opensOn !== undefined && daysBetween(today, t.opensOn) <= 30)) return 'soon';
  return 'later';
}

function opensOnOf(b: Booking | undefined, visit: string): string | undefined {
  if (!b) return undefined;
  const fixed = dateOf(b.opensAt?.value);
  if (fixed) return fixed;
  const rule = b.opensRule?.value;
  return rule && Number.isFinite(rule.daysBefore) ? addDays(visit, -rule.daysBefore) : undefined;
}

const ORDER: Record<Urgency, number> = { overdue: 0, now: 1, soon: 2, later: 3, none: 4 };

/** Most urgent first; inside a level, the earlier open/deadline, then the visit date. */
export function sortTodos(list: BookingTodo[]): BookingTodo[] {
  return [...list].sort((a, b) => ORDER[a.urgency] - ORDER[b.urgency] || (a.opensOn ?? a.deadlineOn ?? a.date).localeCompare(b.opensOn ?? b.deadlineOn ?? b.date) || a.date.localeCompare(b.date) || a.itemId.localeCompare(b.itemId));
}

export interface BookingList {
  /** Everything with a status: to buy, bought, or marked not needed. Sorted. */
  items: BookingTodo[];
  /** Places with a ticket price or a weak hint but no booking information: worth asking about, not worth nagging. */
  unknown: BookingTodo[];
}

const TRANSPORT_MODES = new Set(['train', 'bus', 'boat', 'cable-car']);

export function deriveBookingTodos(trip: Trip, now: Date, opts: { city?: string } = {}): BookingList {
  const today = now.toISOString().slice(0, 10);
  const items: BookingTodo[] = [];
  const unknown: BookingTodo[] = [];

  const make = (item: Item, date: string, over: Partial<BookingTodo> & Pick<BookingTodo, 'need' | 'status' | 'reason' | 'basis'>): BookingTodo => {
    const b = item.booking;
    const todo: BookingTodo = {
      itemId: item.id,
      date,
      title: item.title,
      category: categoryOf(item),
      urgency: 'none',
      opensOn: opensOnOf(b, date),
      deadlineOn: dateOf(b?.deadline?.value),
      cancellation: b?.cancellation?.value,
      conflict: b?.conflict,
      timedSlots: b?.timedSlots?.value,
      links: linksFor(item.title, b, opts.city),
      hasVoucher: hasVoucher(item),
      bookedAt: b?.bookedAt,
      boughtVia: b?.boughtVia,
      ...over,
    };
    todo.urgency = urgencyOf(todo, today);
    return todo;
  };

  for (const day of trip.days) {
    for (const item of day.items) {
      const text = `${item.title} ${item.note ?? ''}`;
      const b = item.booking;
      const voucher = (item.attachments ?? []).some((a) => a.kind === 'entry' || a.kind === 'booking' || a.kind === 'transport');
      const bookingRef = (item.kind === 'hotel' || item.kind === 'flight') && !!item.bookingRef;

      // 1. The item says so itself.
      if (b) {
        const reason = b.status === 'booked' ? '你標記過已買' : b.status === 'not-needed' ? '你標記過不需要' : `booking.need = ${b.need}`;
        items.push(make(item, day.date, { need: b.need, status: b.status, reason, basis: 'explicit' }));
        continue;
      }
      // 2. Locked and there is a voucher or a reference: it is booked.
      if (item.locked && (voucher || bookingRef)) {
        items.push(make(item, day.date, { need: 'required', status: 'booked', reason: voucher ? 'locked，而且有票券檔' : 'locked，而且有訂位代號', basis: 'locked' }));
        continue;
      }
      // 3. Things that are always booked: flights, hotels, intercity transport.
      // A tube or metro ride is `mode: 'train'` too, so a transit leg only counts when it is locked, says "book", or is long.
      const longLeg = item.kind === 'transit' && (item.duration?.value ?? 0) >= 90;
      const isBookable =
        item.kind === 'flight' ||
        item.kind === 'hotel' ||
        (item.kind === 'transit' && TRANSPORT_MODES.has(item.mode) && (item.locked || longLeg || hit(text, STRONG)));
      if (isBookable) {
        items.push(
          item.locked
            ? make(item, day.date, { need: 'required', status: 'booked', reason: 'locked：視為已訂', basis: 'kind' })
            : make(item, day.date, { need: 'required', status: 'todo', reason: `${item.kind === 'hotel' ? '住宿' : item.kind === 'flight' ? '機票' : '城際交通'}還沒鎖定（locked）`, basis: 'kind' }),
        );
        continue;
      }
      if (item.kind !== 'poi' && item.kind !== 'meal') continue;
      // 4. A strong hint in the text: probably worth booking, but only "recommended".
      if (hit(text, STRONG) && !hit(text, ALREADY)) {
        const word = STRONG.find((w) => text.toLowerCase().includes(w.toLowerCase()))!;
        // Notes like 「大教堂免費免預約；登圓頂要預約」 say both: list it, and say why it needs a second look.
        const mixed = hit(text, NO_RESERVATION) ? '；備註同時寫了免預約，請確認是哪一部分' : '';
        items.push(make(item, day.date, { need: 'recommended', status: 'todo', reason: `備註提到「${word}」（只是關鍵字推測，請確認）${mixed}`, basis: 'keyword' }));
        continue;
      }
      if (hit(text, ALREADY)) continue;
      // 5. A price or a weak hint: ask, do not nag.
      if (item.kind === 'poi' && (item.ticket !== undefined || hit(text, WEAK)) && !hit(text, NO_RESERVATION)) {
        unknown.push(make(item, day.date, { need: 'unknown', status: 'todo', reason: item.ticket !== undefined ? '有門票價格，但沒有訂票資訊' : '備註提到票價，但沒有訂票資訊', basis: 'keyword' }));
      }
    }
  }

  // Nights with nowhere to sleep, merged into runs.
  if (trip.days.length > 0) {
    const stays = stayByNight(trip);
    const gaps: string[] = [];
    for (let d = trip.start; d < trip.end && isIsoDate(d); d = addDays(d, 1)) if (!stays.has(d)) gaps.push(d);
    for (let i = 0; i < gaps.length; ) {
      let j = i;
      while (j + 1 < gaps.length && gaps[j + 1] === addDays(gaps[j]!, 1)) j++;
      const first = gaps[i]!;
      const nights = j - i + 1;
      const md = (s: string) => s.slice(5).replace('-', '/');
      const title = `住宿：缺 ${md(first)}${nights > 1 ? `–${md(gaps[j]!)}` : ''}（${nights} 晚）`;
      const fake = { id: `lodging-gap-${first}`, kind: 'hotel', title, nights } as Item;
      const todo = make(fake, first, { need: 'required', status: 'todo', reason: '這幾晚行程裡沒有住宿', basis: 'gap' });
      todo.links = [];
      items.push(todo);
      i = j + 1;
    }
  }

  // What is already behind us cannot be bought any more: keep the record of what was bought, drop the rest.
  const live = items.filter((t) => t.status !== 'todo' || t.date >= today);
  return { items: sortTodos(live), unknown: unknown.filter((t) => t.date >= today).sort((a, b) => a.date.localeCompare(b.date)) };
}

