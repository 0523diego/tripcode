// `optimize <tripId> --day N`: proposes a better visiting order for one day. Read-only — it never
// edits the trip file; Claude applies the proposal through the trip-authoring skill.
import path from 'node:path';
import { stat } from 'node:fs/promises';
import { CliError, checkFileName, checkTripId, flagStr, printJson } from '../context.ts';
import type { CliContext, ParsedArgs } from '../context.ts';
import { GOOGLE_ROUTES_SOURCE, computeRouteMatrix } from '../google.ts';
import type { RouteMode } from '../google.ts';
import { estimateMinutes, optimizeDay, routableStops } from '../../src/core/optimize.ts';
import type { Item, Trip } from '../../src/core/types.ts';

const MODES = ['transit', 'walk', 'drive'];
export const ESTIMATE_SOURCE = 'haversine-estimate';
/** Used only when Google has no route for a pair and the stops have no coordinates to estimate from. */
const FALLBACK_PAIR_MINUTES = 60;

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function modeLabel(m: RouteMode): string {
  return m === 'transit' ? '大眾運輸' : m === 'walk' ? '步行' : '開車';
}

export interface MatrixOptions {
  /** Google Routes key; without one (or with `offline`) the straight-line estimate is used. */
  apiKey?: string;
  offline?: boolean;
  fetch: CliContext['fetch'];
  now: () => Date;
}

export interface MatrixOutcome {
  matrix: number[][];
  source: string;
  confidence: 'live' | 'reference';
  fetchedAt: string;
  /** True when the numbers are straight-line estimates rather than Google routes. */
  estimate: boolean;
  notes: string[];
}

/**
 * Travel-minute matrix for `stops` (index-aligned with `routableStops(day)`): Google Routes when a key is
 * given and `offline` is not set, otherwise the haversine estimate. Shared by the CLI and the dev server.
 */
export async function buildMatrix(opts: MatrixOptions, stops: Item[], mode: RouteMode): Promise<MatrixOutcome> {
  const notes: string[] = [];
  const estimateAll = (): number[][] => {
    const missing = stops.filter((s) => !s.loc).map((s) => s.title);
    if (missing.length) {
      throw new CliError(`離線估算需要座標，這些地點只有 placeId：${missing.join('、')}。請先補上 loc，或設定金鑰改用線上查詢。`);
    }
    return stops.map((a, i) => stops.map((b, j) => (i === j ? 0 : estimateMinutes(a.loc!, b.loc!, mode))));
  };

  if (opts.offline || !opts.apiKey) {
    notes.push(`距離為直線估算（步行 4.5 km/h、大眾運輸 25 km/h、開車 40 km/h，另加 5 分鐘），僅供參考，不是實際班次或路況`);
    return { matrix: estimateAll(), source: ESTIMATE_SOURCE, confidence: 'reference', fetchedAt: opts.now().toISOString(), estimate: true, notes };
  }
  let estimatedPairs = 0;
  const r = await computeRouteMatrix(
    { apiKey: opts.apiKey, fetch: opts.fetch, now: opts.now },
    stops.map((s) => ({ placeId: s.placeId?.startsWith('osm:') ? undefined : s.placeId, loc: s.loc })),
    { mode },
  );
  const matrix = r.matrix.map((row, i) =>
    row.map((v, j) => {
      if (v !== null) return v;
      estimatedPairs++;
      const a = stops[i]!.loc;
      const b = stops[j]!.loc;
      return a && b ? estimateMinutes(a, b, mode) : FALLBACK_PAIR_MINUTES;
    }),
  );
  if (estimatedPairs > 0) notes.push(`有 ${estimatedPairs} 組路線 Google 查無結果，已用直線估算或預設值代替`);
  if (mode === 'transit') notes.push('大眾運輸時間以查詢當下的班次為準，實際出發時間不同會有差異');
  return { matrix, source: r.source, confidence: 'live', fetchedAt: r.fetchedAt, estimate: false, notes };
}

export async function optimizeCommand(ctx: CliContext, args: ParsedArgs): Promise<void> {
  const tripId = checkTripId(args.positionals[1]);
  const file = checkFileName(flagStr(args, 'file'));
  const dayRaw = flagStr(args, 'day');
  if (!dayRaw || !/^\d+$/.test(dayRaw) || Number(dayRaw) < 1) {
    throw new CliError('用法：optimize <tripId> --day N [--file x.ts] [--mode transit|walk|drive] [--offline]（N 為第幾天，從 1 開始）');
  }
  const dayNo = Number(dayRaw);
  const mode = (flagStr(args, 'mode') ?? 'transit') as RouteMode;
  if (!MODES.includes(mode)) throw new CliError(`--mode 必須是 ${MODES.join('、')} 其中之一`);
  const dayStart = flagStr(args, 'start');
  if (dayStart !== undefined && !/^\d{2}:\d{2}$/.test(dayStart)) throw new CliError('--start 格式需為 HH:MM');

  const p = path.join(ctx.root, 'trips', tripId, file);
  if (!(await exists(p))) throw new CliError(`找不到行程檔：trips/${tripId}/${file}`);
  let trip: Trip;
  try {
    trip = await ctx.loadTrip(p);
  } catch (e) {
    throw new CliError(`無法載入 trips/${tripId}/${file}：${e instanceof Error ? e.message : String(e)}`);
  }
  const day = trip.days[dayNo - 1];
  if (!day) throw new CliError(`這個行程只有 ${trip.days.length} 天，沒有第 ${dayNo} 天`);

  const stops: Item[] = routableStops(day);
  const keepOrder = flagStr(args, 'keep')
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const id of keepOrder ?? []) {
    if (!stops.some((s) => s.id === id)) throw new CliError(`--keep 的項目 ${id} 不在第 ${dayNo} 天的可排路線地點中`);
  }
  const header = { tripId, file, day: dayNo, date: day.date, title: day.title, mode };
  const stopInfo = stops.map((s) => ({ id: s.id, title: s.title, locked: s.locked === true }));

  if (stops.length < 2) {
    const out = {
      ...header,
      note: '這天少於 2 個可排路線的地點，不需要最佳化',
      stops: stopInfo,
      order: stops.map((s) => s.id),
      before: 0,
      after: 0,
      moves: [] as string[],
      changed: false,
    };
    if (args.flags.pretty) ctx.stdout(`第 ${dayNo} 天：${out.note}\n`);
    else printJson(ctx, out);
    return;
  }

  // ---- matrix -------------------------------------------------------------------------------
  const key = ctx.env.GOOGLE_MAPS_API_KEY?.trim();
  const notes: string[] = [];
  if (!args.flags.offline && !key) {
    const msg = '找不到 GOOGLE_MAPS_API_KEY，改用直線距離估算（參考值）；要查真實交通時間請在 .env 設定金鑰';
    notes.push(msg);
    ctx.stderr(`注意：${msg}\n`);
  }
  const built = await buildMatrix({ apiKey: key, offline: args.flags.offline === true, fetch: ctx.fetch, now: ctx.now }, stops, mode);
  const { matrix, source, confidence, fetchedAt } = built;
  const offline = built.estimate;
  notes.push(...built.notes);

  // ---- optimize -----------------------------------------------------------------------------
  const result = optimizeDay(day, matrix, { dayStart, keepOrder });
  const current = stops.map((s) => s.id);
  const changed = result.order.some((id, i) => id !== current[i]);
  const out = {
    ...header,
    source,
    confidence,
    fetchedAt,
    estimate: offline,
    notes,
    stops: stopInfo,
    current,
    order: result.order,
    before: result.before,
    after: result.after,
    savedMinutes: result.before - result.after,
    moves: result.moves,
    changed,
    matrix,
  };

  if (args.flags.pretty) {
    const title = new Map(stops.map((s) => [s.id, s.title]));
    const lines: string[] = [];
    lines.push(`第 ${dayNo} 天 ${day.date}${day.title ? ` ${day.title}` : ''}（${modeLabel(mode)}）`);
    lines.push(offline ? `來源：${ESTIMATE_SOURCE}（直線估算，可信度 reference）` : `來源：${GOOGLE_ROUTES_SOURCE}（${fetchedAt}）`);
    lines.push('', `目前順序（共 ${result.before} 分鐘）：`);
    current.forEach((id, i) => lines.push(`  ${i + 1}. ${title.get(id)}${stopInfo[i]!.locked ? '（已確定）' : ''}`));
    if (changed) {
      lines.push('', `建議順序（共 ${result.after} 分鐘，少走 ${result.before - result.after} 分鐘）：`);
      result.order.forEach((id, i) => lines.push(`  ${i + 1}. ${title.get(id)}`));
      lines.push('', '調整：');
      for (const m of result.moves) lines.push(`  - ${m}`);
    } else {
      lines.push('', '目前的順序已經是最短路線，不需要調整。');
    }
    for (const n of notes) lines.push('', `注意：${n}`);
    ctx.stdout(lines.join('\n') + '\n');
  } else {
    printJson(ctx, out);
  }
}
