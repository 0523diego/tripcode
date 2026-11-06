// Travel facts shared by the on-screen itinerary and the printed one: how a transit leg is
// labelled, and how long it takes. Both views must say the same thing about the same leg,
// and both must mark an estimate as an estimate — a straight-line guess is never a timetable.
import type { Item, OptimizeMode } from '../core/index.ts';
import { estimateMinutes, haversineKm, toMinutes } from '../core/index.ts';

export const MODE_LABEL: Record<string, string> = {
  walk: '步行',
  train: '火車',
  bus: '巴士',
  tram: '電車',
  boat: '船',
  'cable-car': '纜車',
  taxi: '計程車',
  drive: '開車',
};

/** Item transit mode -> the three speeds `estimateMinutes` knows about. */
const OPTIMIZE_MODE: Record<string, OptimizeMode> = {
  walk: 'walk',
  train: 'transit',
  bus: 'transit',
  tram: 'transit',
  boat: 'transit',
  'cable-car': 'transit',
  taxi: 'drive',
  drive: 'drive',
};

/** Straight-line estimates stop being meaningful past this distance (rail/road routes diverge too much). */
export const ESTIMATE_MAX_KM = 80;

export interface TransitTime {
  minutes: number | null;
  km: number | null;
  /** True when computed from coordinates rather than read from a sourced `duration`. */
  estimated: boolean;
  tip: string;
}

/** Sourced duration when present, else a straight-line estimate between the neighbouring located stops. */
export function transitTime(items: Item[], idx: number): TransitTime | null {
  const it = items[idx]!;
  if (it.kind !== 'transit') return null;
  let km: number | null = null;
  let a: Item | undefined;
  let b: Item | undefined;
  for (let i = idx - 1; i >= 0 && !a; i--) if (items[i]!.kind !== 'transit' && items[i]!.loc) a = items[i];
  for (let i = idx + 1; i < items.length && !b; i++) if (items[i]!.kind !== 'transit' && items[i]!.loc) b = items[i];
  if (a?.loc && b?.loc) km = haversineKm(a.loc, b.loc);
  if (it.duration) {
    return { minutes: it.duration.value, km, estimated: false, tip: `時長來源：${it.duration.source}` };
  }
  if (!a?.loc || !b?.loc || km === null) return null;
  if (km > ESTIMATE_MAX_KM) {
    return { minutes: null, km, estimated: true, tip: '兩地直線距離太遠，無法用直線距離估算時間；請查實際班次。' };
  }
  const minutes = estimateMinutes(a.loc, b.loc, OPTIMIZE_MODE[it.mode] ?? 'transit');
  return { minutes, km, estimated: true, tip: '依前後兩個地點的直線距離粗估，不是實際路線或班次時間。' };
}

export function safeMinutes(t?: string): number | null {
  if (!t || !/^\d{1,2}:\d{2}$/.test(t)) return null;
  return toMinutes(t);
}

export function duration(min: number): string {
  if (min < 60) return `${min} 分`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} 小時 ${m} 分` : `${h} 小時`;
}

/** "約 24 分 · 7.7 km" for a transit leg, or null when nothing is known. */
export function transitText(tt: TransitTime | null): string | null {
  if (!tt) return null;
  const parts: string[] = [];
  if (tt.minutes !== null) parts.push(`${tt.estimated ? '約 ' : ''}${duration(tt.minutes)}`);
  if (tt.km !== null) parts.push(`${tt.km < 10 ? tt.km.toFixed(1) : Math.round(tt.km)} km`);
  return parts.length > 0 ? parts.join(' · ') : null;
}
