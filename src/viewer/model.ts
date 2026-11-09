// Pure helpers shared by viewer components: selection, colors, map data, inbox parsing.
import type { Candidate, Day, Item, Trip } from '../core/types.ts';
import { lodgingByDay, type Stay } from '../core/lodging.ts';
import { dayColorSlots, dayColorVar } from '../core/day-colors.ts';
import type { InboxFile } from './trips.ts';

export type Selection =
  | { type: 'item'; id: string }
  | { type: 'candidate'; id: string }
  | { type: 'gap'; date: string; targetId: string; from: string; to: string }
  | { type: 'day'; date: string };

/** Shared key for things that appear on the map and in the timeline. */
export function selKey(s: Selection | null): string | null {
  return s && (s.type === 'item' || s.type === 'candidate') ? `${s.type}:${s.id}` : null;
}

export const DAY_COLORS = 8;
/** CSS custom property name for a day's color (0-based day index). */
export function dayVar(i: number): string {
  return `--day-${(((i % DAY_COLORS) + DAY_COLORS) % DAY_COLORS) + 1}`;
}

/** CSS custom property holding the readable text color for a fill color variable (e.g. --day-2 → --on-day-2). */
export function onVar(color: string): string {
  if (color.startsWith('--day-')) return `--on-${color.slice(2)}`;
  if (color === '--discuss' || color === '--accept') return `--on-${color.slice(2)}`;
  return '--text';
}

export const KIND_LABEL: Record<Item['kind'], string> = {
  poi: '景點',
  meal: '用餐',
  hotel: '住宿',
  transit: '交通',
  flight: '航班',
  free: '自由',
};

export const STATUS_LABEL: Record<Candidate['status'], string> = {
  unconfirmed: '未確認',
  accepted: '已加入',
  discuss: '待討論',
  rejected: '不去',
};

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
export function dateLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) return date;
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}（${WEEK[wd]}）`;
}

export function hasLoc(it: { loc?: { lat: number; lng: number } }): boolean {
  return !!it.loc && Number.isFinite(it.loc.lat) && Number.isFinite(it.loc.lng);
}

// ---------- map data ----------

export type PinStyle = 'day' | 'unconfirmed' | 'discuss' | 'accepted' | 'rejected';

export interface MapPin {
  key: string;
  sel: Selection;
  lat: number;
  lng: number;
  /** Text inside the pin: number, "?", "…", "✓", "×". */
  label: string;
  title: string;
  /** CSS custom property name, e.g. "--day-1". */
  color: string;
  style: PinStyle;
}

export interface MapRoute {
  key: string;
  color: string;
  points: { lat: number; lng: number }[];
}

export interface MapData {
  pins: MapPin[];
  routes: MapRoute[];
  /** Non-transit items without coordinates (listed, not drawn). */
  unlocated: number;
}

export function buildMapData(trip: Trip, dayIdx: number | null): MapData {
  const pins: MapPin[] = [];
  const routes: MapRoute[] = [];
  let unlocated = 0;
  const slots = dayColorSlots(trip);
  const lodging = lodgingByDay(trip);
  /** Hotels a day starts or ends at, drawn as "宿" pins unless the hotel's own check-in item already has a pin. */
  const stays: { stay: Stay; color: string }[] = [];
  const stayPoint = (stay: Stay | undefined, color: string) => {
    if (!stay || !hasLoc(stay.item) || !stay.item.loc) return [];
    stays.push({ stay, color });
    return [{ lat: stay.item.loc.lat, lng: stay.item.loc.lng }];
  };
  trip.days.forEach((day, di) => {
    if (dayIdx !== null && di !== dayIdx) return;
    const color = dayColorVar(slots[di]!);
    const pts: { lat: number; lng: number }[] = [];
    let n = 0;
    for (const it of day.items) {
      if (it.kind === 'transit') continue;
      if (!hasLoc(it) || !it.loc) {
        unlocated++;
        continue;
      }
      n++;
      pts.push({ lat: it.loc.lat, lng: it.loc.lng });
      pins.push({
        key: `item:${it.id}`,
        sel: { type: 'item', id: it.id },
        lat: it.loc.lat,
        lng: it.loc.lng,
        label: String(n),
        title: it.title,
        color,
        style: 'day',
      });
    }
    // Every day starts and ends at where you sleep, even on the days between a hotel's check-in and check-out.
    const lodge = lodging[di];
    const route = [...stayPoint(lodge?.start, color), ...pts, ...stayPoint(lodge?.end, color)];
    if (route.length > 1) routes.push({ key: day.date, color, points: route });
  });
  const pinned = new Set(pins.map((p) => p.key));
  for (const { stay, color } of stays) {
    const key = `item:${stay.item.id}`;
    if (pinned.has(key) || !stay.item.loc) continue;
    pinned.add(key);
    pins.push({
      key,
      sel: { type: 'item', id: stay.item.id },
      lat: stay.item.loc.lat,
      lng: stay.item.loc.lng,
      label: '宿',
      title: stay.item.title,
      color,
      style: 'day',
    });
  }
  for (const c of trip.candidates) {
    if (!hasLoc(c) || !c.loc) continue;
    const dayOk = c.day !== undefined && c.day >= 1 && c.day <= trip.days.length;
    const styleBy: Record<Candidate['status'], [PinStyle, string, string]> = {
      unconfirmed: ['unconfirmed', '?', '--muted'],
      discuss: ['discuss', '…', '--discuss'],
      accepted: ['accepted', '✓', dayOk ? dayColorVar(slots[(c.day ?? 1) - 1]!) : '--accept'],
      rejected: ['rejected', '×', '--muted'],
    };
    const [style, label, color] = styleBy[c.status];
    pins.push({
      key: `candidate:${c.id}`,
      sel: { type: 'candidate', id: c.id },
      lat: c.loc.lat,
      lng: c.loc.lng,
      label,
      title: c.title,
      color,
      style,
    });
  }
  return { pins, routes, unlocated };
}

// ---------- locked facts ----------

export interface LockedRef {
  item: Item;
  dayIdx: number;
  day: Day;
}

export function lockedItems(trip: Trip): LockedRef[] {
  const out: LockedRef[] = [];
  trip.days.forEach((day, dayIdx) => {
    for (const item of day.items) if (item.locked) out.push({ item, dayIdx, day });
  });
  return out;
}

export function findItem(trip: Trip, id: string): LockedRef | undefined {
  for (let dayIdx = 0; dayIdx < trip.days.length; dayIdx++) {
    const day = trip.days[dayIdx];
    const item = day?.items.find((i) => i.id === id);
    if (day && item) return { item, dayIdx, day };
  }
  return undefined;
}

// ---------- inbox ----------

export interface InboxNote {
  file: string;
  /** Path as referenced by Candidate.sources, e.g. "inbox/01.md". */
  path: string;
  status: string;
  createdAt?: string;
  body: string;
  raw: string;
}

export function parseInbox(f: InboxFile): InboxNote {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(f.raw);
  const meta: Record<string, string> = {};
  let body = f.raw;
  if (m) {
    body = m[2] ?? '';
    for (const line of (m[1] ?? '').split(/\r?\n/)) {
      const kv = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
      if (kv && kv[1]) meta[kv[1]] = (kv[2] ?? '').trim();
    }
  }
  return {
    file: f.file,
    path: `inbox/${f.file}`,
    status: meta.status ?? 'pending',
    createdAt: meta.createdAt,
    body: body.trim(),
    raw: f.raw,
  };
}

export function inboxStatusText(note: InboxNote, candidates: Candidate[]): { text: string; tone: 'wait' | 'todo' | 'done' | 'bad' } {
  const refs = candidates.filter((c) => c.sources.includes(note.path));
  if (note.status === 'not-found') return { text: '找不到地點', tone: 'bad' };
  if (refs.length === 0) {
    return note.status === 'pending'
      ? { text: '等 Claude 解析', tone: 'wait' }
      : { text: '已解析', tone: 'done' };
  }
  const open = refs.filter((c) => c.status === 'unconfirmed').length;
  return open > 0
    ? { text: `${open} 個地點未確認`, tone: 'todo' }
    : { text: '地點皆已處理', tone: 'done' };
}

export function tileTitle(body: string): string {
  const t = body.replace(/^[#>\s*-]+/, '').replace(/\s+/g, ' ').trim();
  return t.length > 14 ? `${t.slice(0, 14)}…` : t || '（空白）';
}
