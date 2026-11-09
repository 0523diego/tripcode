// The printed itinerary as plain data. buildPrintDocument turns a Trip and the user's print options into a list of
// sections (day pages, ...) that PrintDocumentView renders and that tests can check without a browser.
//
// Design rules (the reasoning is in CHANGELOG.md, 2026-11-07):
//  - A day is one sheet: header with the colour bar, where you sleep, the rows in order.
//  - No QR codes of our own. A place QR only opens a map, and the person holding the phone can search the map. The only
//    codes on paper are the ones on the tickets the user attached; those pages are printed as they are (TicketsSection).
//  - A field the trip does not have is left out. Nothing is filled in.
import { deriveBookingTodos } from '../../core/bookings.ts';
import type { BookingCategory } from '../../core/types.ts';
import { dayColorSlots } from '../../core/day-colors.ts';
import { stayByNight } from '../../core/lodging.ts';
import type { Item, Trip } from '../../core/types.ts';
import { KIND_LABEL, STATUS_LABEL, dateLabel } from '../model.ts';
import { MODE_LABEL, duration, transitText, transitTime } from '../travel.ts';

export type Density = 'compact' | 'normal' | 'large';
export type Paper = 'A4' | 'Letter';

export interface PrintOptions {
  /** 'all', 'from-today' (days that are not over yet), or 1-based day numbers. */
  days: 'all' | 'from-today' | number[];
  /** Print the ticket files attached to the printed days (PDF pages and pictures, QR codes and all). */
  tickets: boolean;
  density: Density;
  notes: boolean;
  cover: boolean;
  bookings: boolean;
  candidates: boolean;
  paper: Paper;
}

export const DEFAULT_OPTIONS: PrintOptions = {
  days: 'all',
  tickets: true,
  density: 'normal',
  notes: true,
  cover: true,
  bookings: true,
  candidates: false,
  paper: 'A4',
};

const booked = (it: Item): boolean => it.booking?.status === 'booked' || !!it.booking?.bookedAt;

// ---------- document ----------

export interface StopRow {
  kind: 'stop';
  itemId: string;
  start?: string;
  end?: string;
  /** Only an end time is known: the row says 抵 HH:MM. */
  arriveOnly: boolean;
  title: string;
  kindLabel: string;
  /** Short facts after the name: length of stay, flight number. */
  meta: string[];
  /** 已訂 / 已確定 / 待訂, or undefined when nothing is known. */
  status?: '已訂' | '已確定' | '待訂';
  note?: string;
  tickets: string[];
}

export interface LegRow {
  kind: 'leg';
  itemId: string;
  mode: string;
  /** "約 25 分" style text from the trip's own travel data; undefined when none. */
  travel?: string;
  title: string;
  note?: string;
}

export interface DaySection {
  kind: 'day';
  /** 1-based, as the trip numbers its days. */
  dayNo: number;
  date: string;
  dateLabel: string;
  /** Colour slot 1–8 (the trip's own colouring: days in the same hotel share a colour). */
  color: number;
  title?: string;
  weatherClear: boolean;
  sleep?: { label: '今晚住' | '今天退房'; title: string };
  rows: (StopRow | LegRow)[];
  /** Start on a new sheet. */
  breakBefore: boolean;
  /** Keep the whole day on one sheet when it fits (compact density only). */
  keepTogether: boolean;
  /** Rough height in mm, used to decide how days share sheets. */
  estMm: number;
}

export interface CoverSection {
  kind: 'cover';
  title: string;
  /** "2026-10-21 → 2026-10-31 · 11 天 10 晚 · 3 位成人 · Europe/London" */
  dateLine: string;
  /** Every day of the trip, in one glance (not only the printed days). */
  glance: { dayNo: number; dateLabel: string; color: number; title?: string; sleep?: string; fixed: { time: string; title: string }[] }[];
  stays: { itemId: string; title: string; checkIn: string; checkOut: string; nights: number; bookingRef?: string; note?: string; color: number }[];
  /** Flights and booked long-distance transport. */
  transport: { date: string; time?: string; title: string; code?: string; bookingRef?: string }[];
  /** Still to buy and due: only what the trip's own booking data says is urgent. */
  urgent: { title: string; why: string }[];
}

/** One file the user attached to a stop: a PDF, a picture of a ticket, a booking confirmation. */
export interface TicketRef {
  dayNo: number;
  dateLabel: string;
  /** The stop it belongs to ("羅浮宮"). */
  itemTitle: string;
  /** The user's own label for the file ("門票 2 張"). */
  label: string;
  /** Path under the trip folder, always `tickets/<name>`. */
  file: string;
  /** How the printout can show it: a picture the browser prints as it is, a PDF or HEIC that has to be turned into pages first. */
  how: 'image' | 'convert';
}

export interface TicketsSection {
  kind: 'tickets';
  tripId: string;
  items: TicketRef[];
  /** Attached files that cannot be shown as a picture (wallet passes, notes): named so the user can print them another way. */
  skipped: { dayNo: number; itemTitle: string; label: string; file: string }[];
}

export interface BookingsSection {
  kind: 'bookings';
  rows: { date: string; title: string; category: string; status: '已訂' | '待訂'; via?: string; voucher: boolean; opensOn?: string; deadlineOn?: string; cancellation?: string }[];
}

export interface CandidatesSection {
  kind: 'candidates';
  items: { title: string; status: string; day?: number; why?: string }[];
}

export interface NotesSection {
  kind: 'notes';
  /** Labels only: the user writes the numbers in. Nothing is pre-filled. */
  writeIns: string[];
  lines: number;
}

export type PrintSection = CoverSection | DaySection | TicketsSection | BookingsSection | CandidatesSection | NotesSection;

export interface PrintDocument {
  title: string;
  printedOn: string;
  paper: Paper;
  density: Density;
  sections: PrintSection[];
}

function timeParts(it: Item): Pick<StopRow, 'start' | 'end' | 'arriveOnly'> {
  return {
    ...(it.start ? { start: it.start } : {}),
    ...(it.end ? { end: it.end } : {}),
    arriveOnly: !it.start && !!it.end,
  };
}

function metaOf(it: Item): string[] {
  const out: string[] = [];
  if (it.kind === 'hotel') out.push(`${it.nights} 晚`);
  else if (it.kind === 'poi' && it.minutes) out.push(duration(it.minutes));
  if (it.kind === 'flight' && it.flightNo) out.push(it.flightNo);
  return out;
}

function statusOf(it: Item): StopRow['status'] {
  if (it.booking?.status === 'booked' || it.booking?.bookedAt) return '已訂';
  if (it.locked) return '已確定';
  if (it.booking?.status === 'todo') return '待訂';
  return undefined;
}

function dayDocument(trip: Trip, index: number, density: Density, slots: number[], stays: ReturnType<typeof stayByNight>): DaySection {
  const day = trip.days[index]!;
  const prev = trip.days[index - 1];
  const tonight = stays.get(day.date);
  const lastNight = prev ? stays.get(prev.date) : undefined;
  const sleepItem = tonight?.item ?? lastNight?.item;
  const sleep: DaySection['sleep'] = sleepItem
    ? {
        label: tonight ? '今晚住' : '今天退房',
        title: sleepItem.title,
      }
    : undefined;

  const rows = day.items.map((it, i): StopRow | LegRow => {
    if (it.kind === 'transit') {
      const text = transitText(transitTime(day.items, i));
      return { kind: 'leg', itemId: it.id, mode: MODE_LABEL[it.mode] ?? it.mode, ...(text ? { travel: text } : {}), title: it.title, ...(it.note ? { note: it.note } : {}) };
    }
    const status = statusOf(it);
    return {
      kind: 'stop',
      itemId: it.id,
      ...timeParts(it),
      title: it.title,
      kindLabel: KIND_LABEL[it.kind],
      meta: metaOf(it),
      ...(status ? { status } : {}),
      ...(it.note ? { note: it.note } : {}),
      tickets: (it.attachments ?? []).map((a) => a.label),
    };
  });

  const section: DaySection = {
    kind: 'day',
    dayNo: index + 1,
    date: day.date,
    dateLabel: dateLabel(day.date),
    color: slots[index] ?? 1,
    ...(day.title ? { title: day.title } : {}),
    weatherClear: day.weather === 'clear',
    ...(sleep ? { sleep } : {}),
    rows,
    breakBefore: true,
    keepTogether: false,
    estMm: 0,
  };
  section.estMm = estimateDayMm(section, density);
  return section;
}

// ---------- height estimate and sheet sharing ----------

const DENSITY_SCALE: Record<Density, number> = { compact: 0.9, normal: 1, large: 1.25 };
/** Usable height of a sheet in mm: A4 minus margins is 268, Letter 250; planning with the smaller one keeps both safe. */
export const SHEET_MM = 250;
/** A day this tall or shorter may share a sheet in compact density. */
export const SHARE_MAX_MM = 120;

const noteLines = (text: string | undefined, perLine = 52): number => (text ? Math.ceil(Array.from(text).length / perLine) : 0);

export function estimateDayMm(day: Pick<DaySection, 'rows' | 'sleep'>, density: Density): number {
  let mm = 24;
  for (const row of day.rows) {
    if (row.kind === 'leg') mm += 5 + noteLines(row.note) * 3.4;
    else mm += 7.5 + noteLines(row.note) * 3.4 + (row.tickets.length > 0 ? 3.4 : 0);
  }
  return Math.round(mm * DENSITY_SCALE[density]);
}

/**
 * Decides where sheets break. Normal and large density: every day starts a sheet. Compact: days flow one after another
 * (no forced break), a day of at most SHARE_MAX_MM is kept whole, a longer one may split between rows (the browser repeats
 * the running header). That is what makes compact the few-pages choice.
 */
export function planBreaks(sections: DaySection[], density: Density): DaySection[] {
  if (density !== 'compact') return sections.map((s) => ({ ...s, breakBefore: true, keepTogether: false }));
  return sections.map((s, i) => ({ ...s, breakBefore: i === 0, keepTogether: s.estMm <= SHARE_MAX_MM }));
}

// ---------- cover, bookings, notes ----------

function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) return date;
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

const CATEGORY: Record<BookingCategory, string> = {
  entry: '門票',
  'timed-entry': '定時入場',
  transport: '交通',
  lodging: '住宿',
  flight: '航班',
  restaurant: '餐廳',
  show: '演出',
  other: '其他',
};

const partyText = (trip: Trip): string => `${trip.party.adults} 位成人${trip.party.childrenAges.length > 0 ? `、${trip.party.childrenAges.length} 位孩童（${trip.party.childrenAges.join('、')} 歲）` : ''}`;
const timeText = (it: Item): string | undefined => (it.start && it.end ? `${it.start}–${it.end}` : it.start ? it.start : it.end ? `抵 ${it.end}` : undefined);
const LONG_TRANSIT = new Set(['train', 'bus', 'boat', 'cable-car']);

export function coverSection(trip: Trip, now: Date, variant?: string): CoverSection {
  const slots = dayColorSlots(trip);
  const stays = stayByNight(trip);
  const nights = Math.max(0, trip.days.length - 1);
  const glance: CoverSection['glance'] = trip.days.map((day, i) => ({
    dayNo: i + 1,
    dateLabel: dateLabel(day.date),
    color: slots[i] ?? 1,
    ...(day.title ? { title: day.title } : {}),
    ...(stays.get(day.date) ? { sleep: stays.get(day.date)!.item.title } : {}),
    fixed: day.items
      .filter((it) => it.start && (it.locked || booked(it)) && it.kind !== 'transit' && it.kind !== 'hotel')
      .slice(0, 3)
      .map((it) => ({ time: it.start!, title: it.title })),
  }));
  const stayCards: CoverSection['stays'] = [];
  const transport: CoverSection['transport'] = [];
  trip.days.forEach((day, i) => {
    for (const it of day.items) {
      if (it.kind === 'hotel') {
        stayCards.push({
          itemId: it.id,
          title: it.title,
          checkIn: day.date,
          checkOut: addDays(day.date, Math.max(1, it.nights)),
          nights: it.nights,
          ...(it.bookingRef ? { bookingRef: it.bookingRef } : {}),
          ...(it.note ? { note: it.note } : {}),
          color: slots[i] ?? 1,
        });
      } else if (it.kind === 'flight' || (it.kind === 'transit' && LONG_TRANSIT.has(it.mode) && (it.locked || booked(it)))) {
        const time = timeText(it);
        transport.push({
          date: dateLabel(day.date),
          ...(time ? { time } : {}),
          title: it.title,
          ...(it.kind === 'flight' && it.flightNo ? { code: it.flightNo } : {}),
          ...(it.kind === 'flight' && it.bookingRef ? { bookingRef: it.bookingRef } : {}),
        });
      }
    }
  });
  const urgent = deriveBookingTodos(trip, now)
    .items.filter((t) => t.status === 'todo' && (t.urgency === 'overdue' || t.urgency === 'now'))
    .slice(0, 5)
    .map((t) => ({ title: t.title, why: t.reason }));
  return {
    kind: 'cover',
    title: trip.title,
    dateLine: `${trip.start} → ${trip.end} · ${trip.days.length} 天 ${nights} 晚 · ${partyText(trip)} · ${trip.tz}${variant ? ` · 方案：${variant}` : ''}`,
    glance,
    stays: stayCards,
    transport,
    urgent,
  };
}

export function bookingsSection(trip: Trip, now: Date): BookingsSection | null {
  const rows = deriveBookingTodos(trip, now)
    .items.filter((t) => t.status === 'booked' || t.status === 'todo')
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((t): BookingsSection['rows'][number] => ({
      date: dateLabel(t.date),
      title: t.title,
      category: CATEGORY[t.category] ?? '其他',
      status: t.status === 'booked' ? '已訂' : '待訂',
      ...(t.boughtVia ? { via: t.boughtVia } : {}),
      voucher: t.hasVoucher,
      ...(t.opensOn ? { opensOn: t.opensOn } : {}),
      ...(t.deadlineOn ? { deadlineOn: t.deadlineOn } : {}),
      ...(t.cancellation ? { cancellation: t.cancellation } : {}),
    }));
  return rows.length > 0 ? { kind: 'bookings', rows } : null;
}

/** Places still under discussion (not rejected), for people who want the "maybe" list on paper too. */
export function candidatesSection(trip: Trip): CandidatesSection | null {
  const items = trip.candidates
    .filter((c) => c.status !== 'rejected')
    .map((c): CandidatesSection['items'][number] => ({
      title: c.title,
      status: STATUS_LABEL[c.status],
      ...(c.status === 'accepted' && c.day ? { day: c.day } : {}),
      ...(c.why ? { why: c.why } : {}),
    }));
  return items.length > 0 ? { kind: 'candidates', items } : null;
}

export const WRITE_INS = ['旅遊平安險／保險公司電話', '駐外辦事處電話', '家人聯絡電話', '航空公司／旅行社電話'];

// ---------- tickets ----------

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);
const CONVERT_EXT = new Set(['pdf', 'heic']);
/** Same shape the server accepts when a file is attached (vite-plugin-tripcode.ts). */
const TICKET_FILE = /^tickets\/[a-z0-9][a-z0-9._-]*$/;

/**
 * The files attached to the stops of the printed days, in day order, each once. This is the only place the printout carries
 * a QR code: the one on the ticket itself. A trip without attachments has no tickets section.
 */
export function ticketsSection(trip: Trip, dayNos: number[], tripId: string): TicketsSection | null {
  const items: TicketRef[] = [];
  const skipped: TicketsSection['skipped'] = [];
  const seen = new Set<string>();
  for (const n of dayNos) {
    const day = trip.days[n - 1];
    if (!day) continue;
    for (const it of day.items) {
      for (const a of it.attachments ?? []) {
        if (typeof a.file !== 'string' || seen.has(a.file)) continue;
        seen.add(a.file);
        const ext = a.file.includes('.') ? a.file.slice(a.file.lastIndexOf('.') + 1).toLowerCase() : '';
        const base = { dayNo: n, itemTitle: it.title, label: a.label, file: a.file };
        if (!TICKET_FILE.test(a.file) || a.file.includes('..')) skipped.push(base);
        else if (IMAGE_EXT.has(ext)) items.push({ ...base, dateLabel: dateLabel(day.date), how: 'image' });
        else if (CONVERT_EXT.has(ext)) items.push({ ...base, dateLabel: dateLabel(day.date), how: 'convert' });
        else skipped.push(base);
      }
    }
  }
  return items.length > 0 || skipped.length > 0 ? { kind: 'tickets', tripId, items, skipped } : null;
}

// ---------- entry point ----------

/** 1-based numbers of the days to print. */
export function selectDays(spec: PrintOptions['days'], dayCount: number, todayIdx: number | null): number[] {
  const all = Array.from({ length: dayCount }, (_, i) => i + 1);
  if (spec === 'all') return all;
  if (spec === 'from-today') return todayIdx === null ? all : all.filter((n) => n - 1 >= todayIdx);
  return all.filter((n) => spec.includes(n));
}

export function buildPrintDocument(trip: Trip, opts: PrintOptions, ctx: { now: Date; todayIdx?: number | null; variant?: string; tripId?: string }): PrintDocument {
  const slots = dayColorSlots(trip);
  const stays = stayByNight(trip);
  const wanted = selectDays(opts.days, trip.days.length, ctx.todayIdx ?? null);
  const days = planBreaks(wanted.map((n) => dayDocument(trip, n - 1, opts.density, slots, stays)), opts.density);
  const tickets = opts.tickets && ctx.tripId ? ticketsSection(trip, wanted, ctx.tripId) : null;
  const bookings = opts.bookings ? bookingsSection(trip, ctx.now) : null;
  const candidates = opts.candidates ? candidatesSection(trip) : null;
  const sections: PrintSection[] = [
    ...(opts.cover ? [coverSection(trip, ctx.now, ctx.variant)] : []),
    ...days,
    ...(tickets ? [tickets] : []),
    ...(bookings ? [bookings] : []),
    ...(candidates ? [candidates] : []),
    ...(opts.notes ? [{ kind: 'notes', writeIns: WRITE_INS, lines: 14 } satisfies NotesSection] : []),
  ];
  return { title: trip.title, printedOn: ctx.now.toISOString().slice(0, 10), paper: opts.paper, density: opts.density, sections };
}
