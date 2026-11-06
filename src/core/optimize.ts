// Day route optimizer. Pure: the caller supplies the travel-time matrix (minutes), this module
// only searches for a better visiting order. It never edits a trip — it returns a proposal that
// Claude applies through the trip-authoring skill.
//
// Rules:
// - Stops are items with `loc` or `placeId`, excluding transit/free items (see `routableStops`).
// - Locked stops stay at their position in the stop sequence (fixed anchors).
// - A stop with BOTH `start` and `end` is a time window: it must be reached by `start`
//   (arrival is allowed to be earlier, the traveller waits) and is left at `end`.
// - Candidate orders are ranked by (minutes late for windows, total travel minutes), so a proposal
//   never makes lateness worse than the current order and is never longer than it.
// - ≤ 8 movable stops: exact branch-and-bound. Otherwise nearest-neighbour + 2-opt / or-opt.
import { tryToMinutes } from './time.ts';
import type { Day, Item, LatLng } from './types.ts';

export interface OptimizeOptions {
  /** "HH:MM" the day starts. Default: 09:00, or earlier if a stop has an earlier time. */
  dayStart?: string;
  /** Item ids whose current relative order must be kept. */
  keepOrder?: string[];
}

export interface OptimizeResult {
  /** Item ids of the routable stops in the proposed order (locked stops keep their slot). */
  order: string[];
  /** Total travel minutes of the current order. */
  before: number;
  /** Total travel minutes of the proposed order (never more than `before`). */
  after: number;
  /** Human-readable Traditional Chinese suggestions. */
  moves: string[];
}

export type OptimizeMode = 'transit' | 'walk' | 'drive';

/** Matrix value used when a pair has no usable number. */
const UNKNOWN_MINUTES = 9999;
const DEFAULT_STAY = 60;
const EXACT_LIMIT = 8;

/** Items that take part in routing, in day order. The optimizer matrix is index-aligned with this. */
export function routableStops(day: Day): Item[] {
  return day.items.filter((it) => it.kind !== 'transit' && it.kind !== 'free' && (it.loc !== undefined || it.placeId !== undefined));
}

// ---- offline estimate --------------------------------------------------------------------------

const SPEED_KMH: Record<OptimizeMode, number> = { walk: 4.5, transit: 25, drive: 40 };
const OVERHEAD_MIN = 5;

export function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Straight-line estimate: distance / mode speed + 5 min overhead. Reference quality only. */
export function estimateMinutes(a: LatLng, b: LatLng, mode: OptimizeMode): number {
  return Math.ceil((haversineKm(a, b) / SPEED_KMH[mode]) * 60) + OVERHEAD_MIN;
}

/** Symmetric estimate matrix (diagonal 0). */
export function estimateMatrix(locs: LatLng[], mode: OptimizeMode): number[][] {
  return locs.map((a, i) => locs.map((b, j) => (i === j ? 0 : estimateMinutes(a, b, mode))));
}

// ---- core search -------------------------------------------------------------------------------

interface StopInfo {
  id: string;
  title: string;
  locked: boolean;
  /** Window start/end minutes when both are set. */
  windowStart?: number;
  windowEnd?: number;
  /** Fixed leave time for items that only have `end` (e.g. an arriving flight). */
  endOnly?: number;
  /** Minutes spent at the stop when it is not a window. */
  stay: number;
  /** Rank in the keepOrder sequence, or -1. */
  keepRank: number;
}

interface State {
  clock: number;
  late: number;
  cost: number;
  prev: number;
}

function stayOf(it: Item): number {
  if (it.kind === 'hotel' || it.kind === 'flight') return 0;
  if (it.kind === 'poi' && it.minutes !== undefined && it.minutes >= 0) return it.minutes;
  return DEFAULT_STAY;
}

function better(a: { late: number; cost: number }, b: { late: number; cost: number }): boolean {
  if (a.late !== b.late) return a.late < b.late;
  return a.cost < b.cost;
}

export function optimizeDay(day: Day, matrix: number[][], opts: OptimizeOptions = {}): OptimizeResult {
  const items = routableStops(day);
  const n = items.length;
  if (matrix.length !== n || matrix.some((row) => !Array.isArray(row) || row.length !== n)) {
    throw new RangeError(`距離矩陣大小需為 ${n}×${n}（與當天可排路線的地點數一致）`);
  }
  const m = (a: number, b: number): number => {
    const v = matrix[a]?.[b];
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : UNKNOWN_MINUTES;
  };

  const keepSet = new Set(opts.keepOrder ?? []);
  let keepCount = 0;
  const stops: StopInfo[] = items.map((it) => {
    const s = it.start !== undefined ? tryToMinutes(it.start) : undefined;
    const e = it.end !== undefined ? tryToMinutes(it.end) : undefined;
    const info: StopInfo = {
      id: it.id,
      title: it.title,
      locked: it.locked === true,
      stay: stayOf(it),
      keepRank: keepSet.has(it.id) ? keepCount++ : -1,
    };
    if (s !== undefined && e !== undefined && e >= s) {
      info.windowStart = s;
      info.windowEnd = e;
    } else if (s === undefined && e !== undefined) {
      info.endOnly = e;
    }
    return info;
  });

  // Initial clock.
  const times: number[] = [];
  for (const st of stops) for (const t of [st.windowStart, st.windowEnd, st.endOnly]) if (t !== undefined) times.push(t);
  const dayStartOpt = opts.dayStart !== undefined ? tryToMinutes(opts.dayStart) : undefined;
  if (opts.dayStart !== undefined && dayStartOpt === undefined) throw new RangeError(`dayStart 格式錯誤：${opts.dayStart}（需為 HH:MM）`);
  const startClock = dayStartOpt ?? Math.min(540, ...times);

  const step = (s: State, i: number): State => {
    const st = stops[i]!;
    const travel = s.prev < 0 ? 0 : m(s.prev, i);
    const arrival = s.clock + travel;
    let late = s.late;
    let depart: number;
    if (st.windowStart !== undefined && st.windowEnd !== undefined) {
      if (arrival > st.windowStart) late += arrival - st.windowStart;
      depart = Math.max(arrival, st.windowStart) + (st.windowEnd - st.windowStart);
      depart = Math.max(depart, st.windowEnd);
    } else if (st.endOnly !== undefined) {
      depart = Math.max(arrival, st.endOnly);
    } else {
      depart = arrival + st.stay;
    }
    return { clock: depart, late, cost: s.cost + travel, prev: i };
  };

  const init: State = { clock: startClock, late: 0, cost: 0, prev: -1 };
  const evalSeq = (seq: number[]): State => seq.reduce(step, init);
  const keepOk = (seq: number[]): boolean => {
    let ptr = 0;
    for (const i of seq) {
      const r = stops[i]!.keepRank;
      if (r === -1) continue;
      if (r !== ptr) return false;
      ptr++;
    }
    return true;
  };

  const original = items.map((_, i) => i);
  const origEval = evalSeq(original);
  const before = origEval.cost;
  const movableIdx = original.filter((i) => !stops[i]!.locked);

  let best: number[] = original;
  if (movableIdx.length >= 2) {
    best = movableIdx.length <= EXACT_LIMIT ? exactSearch() : heuristicSearch();
  }

  function exactSearch(): number[] {
    let bestSeq = original;
    let bestVal = { late: origEval.late, cost: origEval.cost };
    const used = new Array<boolean>(n).fill(false);
    const seq: number[] = [];
    const dfs = (pos: number, s: State, ptr: number): void => {
      // late and cost only grow along a prefix, so a prefix that is not strictly better is dead.
      if (s.late > bestVal.late || (s.late === bestVal.late && s.cost >= bestVal.cost)) return;
      if (pos === n) {
        bestVal = { late: s.late, cost: s.cost };
        bestSeq = seq.slice();
        return;
      }
      const candidates = stops[pos]!.locked ? [pos] : movableIdx.filter((i) => !used[i]);
      if (!stops[pos]!.locked && s.prev >= 0) candidates.sort((a, b) => m(s.prev, a) - m(s.prev, b));
      for (const i of candidates) {
        const r = stops[i]!.keepRank;
        if (r !== -1 && r !== ptr) continue;
        if (!stops[i]!.locked) used[i] = true;
        seq.push(i);
        dfs(pos + 1, step(s, i), r !== -1 ? ptr + 1 : ptr);
        seq.pop();
        if (!stops[i]!.locked) used[i] = false;
      }
    };
    dfs(0, init, 0);
    return bestSeq;
  }

  function heuristicSearch(): number[] {
    const fill = (mov: number[]): number[] => {
      let k = 0;
      return original.map((i) => (stops[i]!.locked ? i : mov[k++]!));
    };
    const score = (mov: number[]): { late: number; cost: number } | undefined => {
      const seq = fill(mov);
      if (!keepOk(seq)) return undefined;
      const s = evalSeq(seq);
      return { late: s.late, cost: s.cost };
    };
    const improve = (start: number[]): { mov: number[]; val: { late: number; cost: number } } | undefined => {
      let cur = start.slice();
      let val = score(cur);
      if (!val) return undefined;
      for (let iter = 0; iter < 200; iter++) {
        let improved = false;
        // 2-opt: reverse a segment of the movable order.
        for (let i = 0; i < cur.length - 1; i++) {
          for (let j = i + 1; j < cur.length; j++) {
            const cand = cur.slice(0, i).concat(cur.slice(i, j + 1).reverse(), cur.slice(j + 1));
            const v = score(cand);
            if (v && better(v, val)) {
              cur = cand;
              val = v;
              improved = true;
            }
          }
        }
        // or-opt: move one stop to another position.
        for (let i = 0; i < cur.length; i++) {
          for (let j = 0; j < cur.length; j++) {
            if (i === j) continue;
            const cand = cur.slice();
            const [x] = cand.splice(i, 1);
            cand.splice(j, 0, x!);
            const v = score(cand);
            if (v && better(v, val)) {
              cur = cand;
              val = v;
              improved = true;
            }
          }
        }
        if (!improved) break;
      }
      return { mov: cur, val };
    };

    // Nearest-neighbour seed (movable slots only; locked stay put).
    const nn = (): number[] | undefined => {
      const left = new Set(movableIdx);
      const seq: number[] = [];
      let ptr = 0;
      for (let pos = 0; pos < n; pos++) {
        if (stops[pos]!.locked) {
          const r = stops[pos]!.keepRank;
          if (r !== -1) {
            if (r !== ptr) return undefined;
            ptr++;
          }
          seq.push(pos);
          continue;
        }
        const prev = seq.length ? seq[seq.length - 1]! : -1;
        let pick = -1;
        let pickCost = Infinity;
        for (const i of left) {
          const r = stops[i]!.keepRank;
          if (r !== -1 && r !== ptr) continue;
          const c = prev < 0 ? 0 : m(prev, i);
          if (c < pickCost) {
            pick = i;
            pickCost = c;
          }
        }
        if (pick < 0) return undefined;
        left.delete(pick);
        if (stops[pick]!.keepRank !== -1) ptr++;
        seq.push(pick);
      }
      return seq.filter((i) => !stops[i]!.locked);
    };

    let bestMov = movableIdx;
    let bestVal: { late: number; cost: number } = { late: origEval.late, cost: origEval.cost };
    const seeds: number[][] = [movableIdx];
    const seed = nn();
    if (seed) seeds.push(seed);
    for (const s of seeds) {
      const r = improve(s);
      if (r && better(r.val, bestVal)) {
        bestMov = r.mov;
        bestVal = r.val;
      }
    }
    return fill(bestMov);
  }

  const afterEval = evalSeq(best);
  const after = afterEval.cost;

  return {
    order: best.map((i) => stops[i]!.id),
    before,
    after,
    moves: describeMoves(stops, original, best, m),
  };
}

/** Turns the difference between two orders into 「把 X 移到 Y 之前，少走 N 分鐘」 lines. */
function describeMoves(stops: StopInfo[], original: number[], best: number[], m: (a: number, b: number) => number): string[] {
  const movOrig = original.filter((i) => !stops[i]!.locked);
  const movBest = best.filter((i) => !stops[i]!.locked);
  const fill = (mov: number[]): number[] => {
    let k = 0;
    return original.map((i) => (stops[i]!.locked ? i : mov[k++]!));
  };
  const costOf = (seq: number[]): number => {
    let c = 0;
    for (let k = 1; k < seq.length; k++) c += m(seq[k - 1]!, seq[k]!);
    return c;
  };
  const lines: string[] = [];
  const cur = movOrig.slice();
  for (let k = 0; k < movBest.length; k++) {
    if (cur[k] === movBest[k]) continue;
    const target = cur[k]!;
    const x = movBest[k]!;
    const beforeCost = costOf(fill(cur));
    cur.splice(cur.indexOf(x), 1);
    cur.splice(k, 0, x);
    const delta = beforeCost - costOf(fill(cur));
    const tail = delta > 0 ? `，少走 ${delta} 分鐘` : delta < 0 ? `，多走 ${-delta} 分鐘（配合後續調整）` : '，路程相同';
    lines.push(`把 ${stops[x]!.title} 移到 ${stops[target]!.title} 之前${tail}`);
  }
  return lines;
}
