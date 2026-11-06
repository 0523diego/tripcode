// What the 訂票清單 page needs on top of src/core/bookings.ts: filters, grouping, countdown wording and where a
// restaurant goes in a day. Pure, so the wording and the placement rules are tested.
import type { BookingList, BookingTodo, Urgency } from '../../core/bookings.ts';
import type { MealGap } from '../../core/meals.ts';
import type { Day, Trip } from '../../core/types.ts';
import { stayByNight } from '../../core/lodging.ts';
import { weekday } from '../../core/time.ts';

export type Filter = 'todo' | 'booked' | 'not-needed' | 'all';

export const FILTER_LABEL: Record<Filter, string> = { todo: '待買', booked: '已買', 'not-needed': '不需要', all: '全部' };

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
export const weekdayZh = (date: string) => `週${WEEK[weekday(date)]}`;
export const shortDate = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;

export function filterTodos(list: BookingList, f: Filter): BookingTodo[] {
  return f === 'all' ? list.items : list.items.filter((t) => t.status === f);
}

export function counts(list: BookingList): Record<Filter, number> {
  const c = { todo: 0, booked: 0, 'not-needed': 0, all: list.items.length } as Record<Filter, number>;
  for (const t of list.items) c[t.status]++;
  return c;
}

// ---------- where each thing belongs: by city ----------

export interface Place {
  key: string;
  label: string;
  /** city = the day says so; stay = no city given, so the hotel you sleep in stands in; none = no hotel that night. */
  kind: 'city' | 'stay' | 'none';
}

export interface PlaceGroup<T> extends Place {
  /** First and last date of the items in the group. */
  from: string;
  to: string;
  items: T[];
}

const addDay = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Where a date belongs: the day's `city`, else the hotel you sleep in that night (or last night, on the day you leave). */
export function placeOf(trip: Pick<Trip, 'days'>): (date: string) => Place {
  const stays = stayByNight(trip);
  const cities = new Map(trip.days.map((d) => [d.date, d.city?.trim()]));
  return (date) => {
    const city = cities.get(date);
    if (city) return { key: `city:${city}`, label: city, kind: 'city' };
    const stay = stays.get(date) ?? stays.get(addDay(date, -1));
    if (stay) return { key: `stay:${stay.item.id}`, label: stay.item.title.replace(/[（(].*?[）)]/g, '').trim() || stay.item.title, kind: 'stay' };
    return { key: 'none', label: '還沒安排住宿的日子', kind: 'none' };
  };
}

/** Groups by place, in the order the trip reaches each place; inside a group by date. Items of one city that are far apart in time stay together. */
export function groupByPlace<T extends { date: string }>(items: T[], place: (date: string) => Place): PlaceGroup<T>[] {
  const groups = new Map<string, PlaceGroup<T>>();
  for (const it of [...items].sort((a, b) => a.date.localeCompare(b.date))) {
    const p = place(it.date);
    const g = groups.get(p.key);
    if (g) {
      g.items.push(it);
      g.to = it.date;
    } else groups.set(p.key, { ...p, from: it.date, to: it.date, items: [it] });
  }
  return [...groups.values()];
}

export const URGENCY_LABEL: Record<Urgency, string> = { overdue: '已過期', now: '現在要訂', soon: '這個月內', later: '之後', none: '' };

const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** 「已開賣」「3 天後開賣」「明天截止」, or nothing when there is no date to talk about. */
export function countdowns(t: Pick<BookingTodo, 'opensOn' | 'deadlineOn'>, today: string): string[] {
  const out: string[] = [];
  const say = (date: string, word: string, past: string) => {
    const d = dayDiff(today, date);
    if (d < 0) out.push(past);
    else if (d === 0) out.push(`今天${word}`);
    else if (d === 1) out.push(`明天${word}`);
    else out.push(`${d} 天後${word}（${shortDate(date)}）`);
  };
  if (t.opensOn) say(t.opensOn, '開賣', '已開賣');
  if (t.deadlineOn) say(t.deadlineOn, '截止', '已截止');
  return out;
}

export const NEED_LABEL = { required: '必須預約', recommended: '建議預約', none: '不用預約', unknown: '還不確定' } as const;

/** Which item to insert before so the new meal lands where the user chose; undefined = end of the day. */
export function insertionPoint(day: Day | undefined, gap: MealGap, anchor: 'prev' | 'next' | 'hotel'): string | undefined {
  if (!day) return undefined;
  const ids = day.items.map((i) => i.id);
  if (anchor === 'next' && gap.next) return gap.next.itemId;
  if (anchor === 'prev' && gap.prev) {
    const i = ids.indexOf(gap.prev.itemId);
    return i >= 0 ? ids[i + 1] : undefined;
  }
  if (anchor === 'hotel') return undefined;
  return gap.next?.itemId;
}

export function anchorChoices(gap: MealGap): { key: 'prev' | 'next' | 'hotel'; label: string; title: string }[] {
  const out: { key: 'prev' | 'next' | 'hotel'; label: string; title: string }[] = [];
  if (gap.prev) out.push({ key: 'prev', label: `前一站：${gap.prev.title}`, title: gap.prev.title });
  if (gap.next) out.push({ key: 'next', label: `後一站：${gap.next.title}`, title: gap.next.title });
  if (gap.hotel) out.push({ key: 'hotel', label: `住宿：${gap.hotel.title}`, title: gap.hotel.title });
  return out;
}

export const VIA_OPTIONS = ['官方', 'Klook', 'Trip.com', '其他'] as const;

export const BOOKING_PROMPTS: { label: string; text: string }[] = [
  { label: '補官方購票連結', text: '照 booking-checklist 技能，幫我把訂票清單裡還沒有官方購票連結的項目補上：從官網點到購票頁、附證據，找不到就明說，不要用轉售商當官方。' },
  { label: '哪些有開賣日', text: '訂票清單裡哪些項目有開賣日或截止日？去官方頁確認並寫進 booking，附來源。' },
  { label: '幫我決定這幾餐', text: '照 fill-meals 的做法，看我還沒決定的午餐和晚餐，依前後景點的位置提醒我該在哪一帶吃，先不要亂寫店名。' },
  { label: '審稿我的行程', text: '照 review-trip 技能審稿這趟行程：列出最多 7 條風險與機會，每條附證據、信心，以及不處理的代價。' },
];

/** 「剛剛」「5 分鐘前」「2 小時前」. */
export function relTime(iso: string | undefined, nowMs: number): string {
  if (!iso) return '';
  const sec = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000));
  if (sec < 45) return '剛剛';
  if (sec < 3600) return `${Math.max(1, Math.round(sec / 60))} 分鐘前`;
  if (sec < 86400) return `${Math.round(sec / 3600)} 小時前`;
  return `${Math.round(sec / 86400)} 天前`;
}
