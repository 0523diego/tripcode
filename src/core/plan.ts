// The fixed pipeline every trip goes through, and where this trip is in it. The stages are always the same five, in
// the same order, and "done" is computed from the trip file, never declared, so the user, the AI and the page always
// agree on what comes next. A stage counts as done only when every stage before it is done and its own condition holds.
// The rules behind each stage live in .claude/skills/plan-trip/SKILL.md; the day-structure numbers in readiness.ts.

import type { Issue, Trip } from './types.ts';
import { checkTrip } from './check.ts';
import { readiness } from './readiness.ts';
import type { ReadinessIssue } from './readiness.ts';

export type StageId = 'inventory' | 'itinerary' | 'review' | 'booking' | 'departure';

export interface Stage {
  id: StageId;
  n: number;
  title: string;
  /** What "done" means, in words. */
  criteria: string;
  status: 'done' | 'doing' | 'todo';
  /** Open things in this stage (0 when done). */
  open: number;
  /** What to do next, and with which skill (the user may also just do it by hand). */
  next: string;
  skill: string;
}

const DAY_NOTES = ['walking-heavy', 'day-time-tight', 'no-easy-day'];
const BOOKING = ['booking-required', 'booking-opens', 'booking-deadline', 'booking-unbought', 'booking-link-missing'];

export function planStages(trip: Trip, opts: { now: Date; brief?: string; profile?: string; check?: Issue[] }): Stage[] {
  const ready: ReadinessIssue[] = readiness(trip, { now: opts.now, brief: opts.brief, profile: opts.profile });
  const check = opts.check ?? checkTrip(trip);
  const count = (codes: string[]) => ready.filter((i) => codes.includes(i.code)).length;
  const defs: Omit<Stage, 'n' | 'status'>[] = [
    {
      id: 'inventory',
      title: '盤點',
      criteria: '你已訂的、想去的、不要的、限制，都告訴過 AI（簡報沒有「（待填）」）',
      open: count(['empty-trip', 'brief-unfilled']),
      next: '跟 AI 說你已經訂了什麼、一定要去哪、絕對不要什麼、體力與預算',
      skill: 'onboard-trip',
    },
    {
      id: 'itinerary',
      title: '排行程',
      criteria: '每一天都有安排，而且每一晚都有住宿點（住宿是每天的起點和終點；還沒訂也要先放一個「待選」的住宿）',
      open: count(['empty-day', 'lodging-gap']),
      next: '把每天的重點放進來，每一晚都要有住宿點（還沒訂就先放待選的）：貼上你的筆記或收藏，請 AI 整理',
      skill: 'create-trip',
    },
    {
      id: 'review',
      title: '審稿',
      criteria: '健檢沒有警告或錯誤，沒有排太滿的一天（走太多路、一天的時間不夠每個點用、連續太多天都很累）',
      open: check.length + count(DAY_NOTES),
      next: '請 AI 審稿，最多 7 條，每條附證據',
      skill: 'review-trip',
    },
    {
      id: 'booking',
      title: '訂票',
      criteria: '必須預約的都買了（含住宿要鎖定），每一項都有確認過的官方購票連結（或明說找不到）',
      open: count(BOOKING),
      next: '請 AI 補官方購票連結，然後到訂票清單自己去買',
      skill: 'booking-checklist',
    },
    {
      id: 'departure',
      title: '出發前',
      criteria: '每一餐都有地點、資料沒有過期、座標與交通時間都查證過',
      open: ready.length - count(['empty-trip', 'brief-unfilled', 'empty-day', 'lodging-gap', ...DAY_NOTES, ...BOOKING]),
      next: '決定還沒有地點的餐，重查過期的資料',
      skill: 'fill-meals',
    },
  ];
  let allBefore = true;
  let doingTaken = false;
  return defs.map((d, i) => {
    const met = d.open === 0;
    const done = allBefore && met;
    let status: Stage['status'] = 'todo';
    if (done) status = 'done';
    else if (allBefore && !doingTaken) {
      status = 'doing';
      doingTaken = true;
    }
    allBefore = allBefore && met;
    return { ...d, n: i + 1, status, open: done ? 0 : d.open };
  });
}

/** One line: 「現在在第 3 步：審稿（還有 2 件）」 or 「都完成了」. */
export function stageSummary(stages: Stage[]): string {
  const cur = stages.find((s) => s.status === 'doing');
  return cur ? `現在在第 ${cur.n} 步：${cur.title}（還有 ${cur.open} 件）` : '五個步驟都完成了';
}
