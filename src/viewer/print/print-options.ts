// The print options as a URL query (so a printout can be reproduced from a link, and headless Chrome can ask for one),
// the remembered preferences, the PDF file name and a rough page count. Pure: storage is passed in.
import type { Trip } from '../../core/types.ts';
import { DEFAULT_OPTIONS, SHEET_MM } from './print-model.ts';
import type { Density, PrintDocument, PrintOptions } from './print-model.ts';

const DENSITIES: readonly Density[] = ['compact', 'normal', 'large'];
const MAX_DAY = 400;

/** "1-3,5" → [1,2,3,5]; "all" and "today" are the two named choices; anything else is not a days spec. */
export function parseDaysSpec(value: string | null): PrintOptions['days'] | null {
  if (value === null) return null;
  if (value === 'all') return 'all';
  if (value === 'today') return 'from-today';
  if (value === 'none') return [];
  if (!/^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(value)) return null;
  const out = new Set<number>();
  for (const part of value.split(',')) {
    const [a, b] = part.split('-').map(Number) as [number, number | undefined];
    const to = b ?? a;
    if (a < 1 || to < a || to > MAX_DAY) return null;
    for (let n = a; n <= to; n++) out.add(n);
  }
  return [...out].sort((x, y) => x - y);
}

/** [1,2,3,5] → "1-3,5". */
export function formatDays(days: number[]): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    parts.push(j > i ? `${sorted[i]}-${sorted[j]}` : String(sorted[i]));
    i = j + 1;
  }
  return parts.join(',');
}

const flag = (v: string | null): boolean | undefined => (v === '1' ? true : v === '0' ? false : undefined);

/** Reads the options a query asks for; anything unrecognised is left out (so the defaults or saved choices apply). */
export function parsePrintQuery(query: string): Partial<PrintOptions> {
  const q = new URLSearchParams(query.replace(/^\?/, ''));
  const out: Partial<PrintOptions> = {};
  const days = parseDaysSpec(q.get('days'));
  if (days !== null) out.days = days;
  const density = q.get('density');
  if (DENSITIES.includes(density as Density)) out.density = density as Density;
  for (const key of ['notes', 'cover', 'bookings', 'candidates', 'tickets'] as const) {
    const v = flag(q.get(key));
    if (v !== undefined) out[key] = v;
  }
  const paper = q.get('paper');
  if (paper === 'A4' || paper === 'Letter') out.paper = paper;
  return out;
}

/** Only what differs from the defaults, in a fixed order. */
export function toPrintQuery(o: PrintOptions): string {
  const q: string[] = [];
  if (o.days !== DEFAULT_OPTIONS.days) q.push(`days=${o.days === 'from-today' ? 'today' : o.days === 'all' ? 'all' : o.days.length === 0 ? 'none' : formatDays(o.days)}`);
  if (o.density !== DEFAULT_OPTIONS.density) q.push(`density=${o.density}`);
  for (const key of ['notes', 'cover', 'bookings', 'candidates', 'tickets'] as const) if (o[key] !== DEFAULT_OPTIONS[key]) q.push(`${key}=${o[key] ? 1 : 0}`);
  if (o.paper !== DEFAULT_OPTIONS.paper) q.push(`paper=${o.paper}`);
  return q.join('&');
}

export function mergeOptions(...parts: Partial<PrintOptions>[]): PrintOptions {
  return Object.assign({}, DEFAULT_OPTIONS, ...parts) as PrintOptions;
}

// ---------- remembered choices ----------

export const PREFS_KEY = 'tripcode.print';
type KeyValueStore = Pick<Storage, 'getItem' | 'setItem'>;

/** The choices worth remembering across trips. Which days to print is decided afresh each time. */
export function loadPrefs(storage?: KeyValueStore): Partial<PrintOptions> {
  try {
    const raw = (storage ?? localStorage).getItem(PREFS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(parsed)) q.set(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
    const { days: _days, ...rest } = parsePrintQuery(q.toString());
    return rest;
  } catch {
    return {};
  }
}

export function savePrefs(o: PrintOptions, storage?: KeyValueStore): void {
  try {
    const { days: _days, ...rest } = o;
    (storage ?? localStorage).setItem(PREFS_KEY, JSON.stringify(rest));
  } catch {
    /* private mode or blocked storage: the choices are simply not remembered */
  }
}

// ---------- file name and page count ----------

/** Chrome offers the page title as the PDF's file name. */
export function printFileTitle(trip: Pick<Trip, 'title'>, now: Date): string {
  return `${trip.title} 行程 ${now.toISOString().slice(0, 10)}`.replace(/[\\/:*?"<>|]/g, '-');
}

/** About how many sheets the browser will print (the real count is the browser's). */
export function estimatePages(doc: PrintDocument): number {
  let pages = 0;
  let closing = false;
  // Compact days flow into each other: their heights add up. Otherwise each day is its own sheet (or more).
  if (doc.density === 'compact') {
    const total = doc.sections.reduce((sum, s) => (s.kind === 'day' ? sum + s.estMm : sum), 0);
    pages += total > 0 ? Math.ceil(total / SHEET_MM) : 0;
  }
  for (const s of doc.sections) {
    if (s.kind === 'cover') pages += 1;
    else if (s.kind === 'day') pages += doc.density === 'compact' ? 0 : Math.max(1, Math.ceil(s.estMm / SHEET_MM));
    else if (s.kind === 'candidates') pages += 1;
    // A ticket sheet carries one ticket page, or two side by side in the compact density; a PDF may have more pages.
    else if (s.kind === 'tickets') pages += doc.density === 'compact' ? Math.ceil(s.items.length / 2) : s.items.length;
    else if (s.kind === 'bookings') {
      pages += 1;
      closing = true;
    } else if (!closing) pages += 1;
  }
  return pages;
}
