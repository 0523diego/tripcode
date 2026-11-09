// 出發準備度: is this trip ready to leave with? The health check (check.ts) says whether the file is valid and
// the day is physically possible; this says what is still open: empty days, tickets not bought, nights without
// a bed, meals without a place. Everything here is a warning or a note, never an error. Pure: `now` is injected.

import type { Trip } from './types.ts';
import { deriveBookingTodos } from './bookings.ts';
import { findMealGaps } from './meals.ts';
import { LOAD, dayLoads, walkLimitFromProfile } from './load.ts';

export interface ReadinessIssue {
  /** warn = needs doing before you go; info = worth a look. */
  level: 'warn' | 'info';
  code: string;
  date?: string;
  itemId?: string;
  message: string;
}

const STALE_DAYS = 30;

/**
 * The day-structure rules the protocol fixes (skills/plan-trip). They judge a day by what it asks of the traveller
 * (estimated walking distance, time left per stop; see load.ts), not by how many points it has: two sights 200 m apart
 * cost almost nothing. Numbers live here so they are visible, tested and changeable in one edit; they only ever produce
 * notes (`info`), each can be accepted for a day (`Day.accepted`), and a day the user wants that way is fine.
 */
export const PLAN_RULES = {
  /** Used when profile.md gives no walking limit. About 10,000 steps. */
  defaultMaxWalkKm: 8,
  /** Less time than this for each stop (after travel and walking) is rushed: a sight, a meal. */
  minMinutesPerStop: 50,
  /** A day that uses at least this share of the walking limit counts as a hard day... */
  busyWalkShare: 0.75,
  /** ...and this many hard days in a row leave no easy day. */
  busyRun: 5,
} as const;

/** The day notes a user may accept for a day. */
export const ACCEPTABLE_NOTES = ['walking-heavy', 'day-time-tight', 'no-easy-day'] as const;
const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export function readiness(trip: Trip, opts: { now: Date; brief?: string; profile?: string }): ReadinessIssue[] {
  const today = opts.now.toISOString().slice(0, 10);
  const out: ReadinessIssue[] = [];
  const upcoming = trip.days.filter((d) => d.date >= today);

  // Nothing planned at all: say it once, and do not repeat it for every day.
  const hasContent = (d: (typeof trip.days)[number]) => d.items.some((i) => i.kind !== 'hotel');
  const noItems = trip.days.length > 0 && trip.days.every((d) => d.items.length === 0);
  if (trip.days.length === 0 || noItems) {
    out.push({ level: 'warn', code: 'empty-trip', message: '這趟行程還是空殼：每一天都沒有任何項目。先把已訂的機票、住宿和想去的地方放進來。' });
  } else {
    for (const d of upcoming) {
      if (!hasContent(d)) out.push({ level: 'warn', code: 'empty-day', date: d.date, message: `${md(d.date)} 這天還沒有安排（只有住宿或什麼都沒有）` });
    }
  }
  if (opts.brief !== undefined && /（待填）|\(待填\)/.test(opts.brief)) {
    out.push({ level: 'info', code: 'brief-unfilled', message: '簡報（brief.md）還有「（待填）」：偏好、預算、步調沒填，建議的品質會打折' });
  }

  // Tickets and beds.
  const { items } = deriveBookingTodos(trip, opts.now);
  for (const t of items) {
    if (t.status !== 'todo') continue;
    if (t.basis === 'gap') {
      out.push({ level: 'warn', code: 'lodging-gap', date: t.date, message: `${t.title}：這幾晚沒有住宿` });
      continue;
    }
    if (t.need === 'required') {
      out.push({ level: 'warn', code: 'booking-required', date: t.date, itemId: t.itemId, message: `${t.title}（${md(t.date)}）必須預約或購買，還沒買${t.cancellation ? `；取消條件：${t.cancellation}` : ''}` });
    }
    if (t.opensOn !== undefined && daysBetween(today, t.opensOn) <= 7) {
      const open = t.opensOn <= today ? '已經開賣' : `${md(t.opensOn)} 開賣`;
      out.push({ level: 'warn', code: 'booking-opens', date: t.date, itemId: t.itemId, message: `${t.title}：${open}，還沒買` });
    }
    if (t.deadlineOn !== undefined && daysBetween(today, t.deadlineOn) <= 3) {
      out.push({ level: 'warn', code: 'booking-deadline', date: t.date, itemId: t.itemId, message: `${t.title}：${md(t.deadlineOn)} 截止（${t.deadlineOn < today ? '已過' : '快到了'}）` });
    }
  }
  // Things the notes say are not bought yet: the notes are keyword guesses, so one merged line, not one per item.
  const maybe = items.filter((t) => t.status === 'todo' && t.need === 'recommended' && t.basis === 'keyword');
  if (maybe.length > 0) {
    const names = maybe.slice(0, 5).map((t) => t.title);
    out.push({ level: 'warn', code: 'booking-unbought', message: `備註寫著還沒訂的有 ${maybe.length} 項：${names.join('、')}${maybe.length > 5 ? '…' : ''}。到訂票清單確認要不要買` });
  }
  // Booking facts older than a month: worth re-reading before you go.
  for (const day of upcoming) {
    for (const item of day.items) {
      const b = item.booking;
      if (!b) continue;
      const stamps = [b.officialSite, b.bookingUrl, b.opensAt, b.opensRule, b.deadline, b.cancellation, b.timedSlots, ...(b.sellers ?? []).map((s) => s.link)]
        .flatMap((s) => (s ? [s.fetchedAt] : []))
        .filter((f) => /^\d{4}-\d{2}-\d{2}/.test(f));
      if (b.status === 'todo' && stamps.some((f) => daysBetween(f.slice(0, 10), today) > STALE_DAYS)) {
        out.push({ level: 'info', code: 'booking-stale', date: day.date, itemId: item.id, message: `${item.title}：訂票資訊是 ${STALE_DAYS} 天前查的，出發前再確認一次` });
      }
    }
  }

  // Meals without a place, merged per day.
  const gaps = findMealGaps(trip).filter((g) => g.date >= today);
  for (const date of [...new Set(gaps.map((g) => g.date))]) {
    const names = gaps.filter((g) => g.date === date).map((g) => (g.slot === 'lunch' ? '午餐' : '晚餐'));
    out.push({ level: 'info', code: 'meal-gap', date, message: `${md(date)} ${names.join('、')}還沒決定` });
  }

  // A restaurant chosen from the food guide was seen on a map some time ago: places close and hours change, so one merged line
  // before leaving, and one for places chosen with no proof at all.
  const stale = upcoming.flatMap((d) => d.items.filter((it) => it.kind === 'meal' && it.checks?.exists && daysBetween(it.checks.exists.fetchedAt.slice(0, 10), today) > STALE_DAYS).map((it) => it.title));
  if (stale.length > 0) out.push({ level: 'info', code: 'meal-check-stale', message: `${stale.slice(0, 4).join('、')}${stale.length > 4 ? '…' : ''}：餐廳是 ${STALE_DAYS} 天前在地圖上確認的，出發前再看一次是否還在營業` });

  // Official purchase pages nobody has confirmed. Merged into one line; once someone has researched an item (a booking
  // field with a known `need`), it stops counting even if no page was found: 「找不到」 is an answer, silence is not.
  const unlinked = items.filter((t) => t.status === 'todo' && t.basis !== 'gap' && t.links[0]?.urlKind === 'search' && !(t.basis === 'explicit' && t.need !== 'unknown'));
  if (unlinked.length > 0) {
    const names = unlinked.slice(0, 5).map((t) => t.title);
    out.push({ level: 'info', code: 'booking-link-missing', message: `${unlinked.length} 項還沒有確認過的官方購票連結：${names.join('、')}${unlinked.length > 5 ? '…' : ''}（用 booking-checklist 補，或自己貼上）` });
  }

  // Day structure: judged by distance and time, from coordinates and fixed times (no map service needed).
  const limit = walkLimitFromProfile(opts.profile) ?? PLAN_RULES.defaultMaxWalkKm;
  const loads = new Map(dayLoads(trip).map((l) => [l.date, l]));
  const accepted = (d: (typeof trip.days)[number], code: string) => d.accepted?.includes(code) === true;
  const hours = (min: number) => `${Math.round((min / 60) * 10) / 10} 小時`;
  for (const day of upcoming) {
    const l = loads.get(day.date);
    if (!l) continue;
    const blind = l.unknown.length > 0 ? `（沒算到：${l.unknown.join('；')}）` : '';
    if (l.walkKm > limit && !accepted(day, 'walking-heavy')) {
      out.push({ level: 'info', code: 'walking-heavy', date: day.date, message: `${md(day.date)}：估計要走 ${l.walkKm} 公里（點與點的直線距離 ${l.straightKm} 公里 × ${LOAD.detour}，不含景點裡面的走動），超過你每天 ${limit} 公里的上限${blind}` });
    }
    if (l.perStopMin !== undefined && l.stops >= 3 && l.perStopMin < PLAN_RULES.minMinutesPerStop && !accepted(day, 'day-time-tight')) {
      const fixed = l.blockedMin + l.transitMin > 0 ? `搭機或火車與移動約 ${hours(l.blockedMin + l.transitMin)}、` : '';
      out.push({ level: 'info', code: 'day-time-tight', date: day.date, message: `${md(day.date)}：扣掉${fixed}走路約 ${hours(l.walkMin)}，一天 ${hours(l.windowMin)} 的白天只剩約 ${hours(l.freeMin)}，要停 ${l.stops} 個點，平均每個約 ${l.perStopMin} 分鐘${blind}` });
    }
  }
  let run = 0;
  for (const day of upcoming) {
    const l = loads.get(day.date);
    run = l && l.walkKm >= limit * PLAN_RULES.busyWalkShare ? run + 1 : 0;
    if (run === PLAN_RULES.busyRun && !accepted(day, 'no-easy-day')) {
      out.push({ level: 'info', code: 'no-easy-day', date: day.date, message: `連續 ${PLAN_RULES.busyRun} 天每天都要走到每日上限（${limit} 公里）的 ${Math.round(PLAN_RULES.busyWalkShare * 100)}% 以上，沒有輕鬆的一天` });
    }
  }

  // Places the map cannot draw and travel times nobody checked, merged per day.
  for (const day of upcoming) {
    const unplaced = day.items.filter((i) => (i.kind === 'poi' || i.kind === 'meal') && !i.loc && !(i.kind === 'meal' && !i.locked && !i.placeId && /待選|待定|附近/.test(i.title + (i.note ?? ''))));
    if (unplaced.length > 0) out.push({ level: 'info', code: 'missing-loc', date: day.date, message: `${md(day.date)}：${unplaced.length} 個地點沒有座標，地圖畫不出來，也找不到附近的餐廳` });
    const stale = day.items.filter((i) => i.loc?.fetchedAt && daysBetween(i.loc.fetchedAt.slice(0, 10), today) > 30);
    if (stale.length > 0) out.push({ level: 'info', code: 'coords-stale', date: day.date, message: `${md(day.date)}：${stale.length} 個座標超過 30 天沒更新` });
    const legs = day.items.filter((i) => i.kind === 'transit' && i.mode !== 'walk');
    const unchecked = legs.filter((i) => i.kind === 'transit' && (i.duration === undefined || /haversine/i.test(i.duration.source)));
    if (unchecked.length > 0) out.push({ level: 'info', code: 'transit-unverified', date: day.date, message: `${md(day.date)}：${unchecked.length}/${legs.length} 段交通時間沒有查證` });
  }
  return out;
}

export function readinessSummary(issues: ReadinessIssue[]): { warn: number; info: number; text: string } {
  const warn = issues.filter((i) => i.level === 'warn').length;
  const info = issues.length - warn;
  return { warn, info, text: warn === 0 ? (info === 0 ? '出發準備：都就緒' : `出發準備：沒有必辦的事，另有 ${info} 項提醒`) : `出發準備：還有 ${warn} 件必辦${info ? `、${info} 項提醒` : ''}` };
}
