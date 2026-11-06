import { CliError, flagStr, printJson } from '../context.ts';
import type { CliContext, ParsedArgs } from '../context.ts';
import { computeRoute, parseLatLng } from '../google.ts';
import { estimateMinutes, haversineKm } from '../../src/core/optimize.ts';
import type { RouteMode, RouteResult } from '../google.ts';

export const ESTIMATE_SOURCE = 'haversine-estimate';
export const ESTIMATE_NOTE = '這是直線距離估算（參考值），不是實際路線；真實大眾運輸時間需要 GOOGLE_MAPS_API_KEY 或官方時刻表。不要把這個數字當成訂位或轉乘依據。';

const MODES = ['transit', 'walk', 'drive'];

function prettyRoute(r: RouteResult & { note?: string }): string {
  const lines = [`總時間 ${r.minutes} 分鐘，距離 ${(r.distanceMeters / 1000).toFixed(1)} 公里`];
  for (const s of r.steps) {
    const extra = [s.line, s.vehicle].filter(Boolean).join(' ');
    lines.push(`  - ${s.mode} ${s.minutes} 分${extra ? `（${extra}）` : ''}`);
  }
  if ('note' in r && r.note) lines.push(`注意：${r.note}`);
  lines.push(`來源：${r.source}，${r.fetchedAt}`);
  return lines.join('\n') + '\n';
}

export async function routesCommand(ctx: CliContext, args: ParsedArgs): Promise<void> {
  const [, from, to] = args.positionals;
  if (!from || !to) throw new CliError('用法：routes <from> <to> [--mode transit|walk|drive] [--depart ISO]（from/to 為 place_id:XXX 或 lat,lng）');
  const mode = flagStr(args, 'mode') ?? 'transit';
  if (!MODES.includes(mode)) throw new CliError(`--mode 必須是 ${MODES.join('、')} 其中之一`);
  const key = ctx.env.GOOGLE_MAPS_API_KEY?.trim();
  if (!key) {
    const a = parseLatLng(from);
    const b = parseLatLng(to);
    if (!a || !b) throw new CliError('沒有 GOOGLE_MAPS_API_KEY 時只能用 lat,lng 做直線估算（place_id: 需要金鑰）');
    ctx.stderr('注意：未設定 GOOGLE_MAPS_API_KEY，改用直線距離估算（參考值，不呼叫任何路線服務）。\n');
    const fetchedAt = ctx.now().toISOString();
    const minutes = estimateMinutes(a, b, mode as RouteMode);
    const r = {
      minutes,
      distanceMeters: Math.round(haversineKm(a, b) * 1000),
      steps: [],
      duration: { value: minutes, source: ESTIMATE_SOURCE, fetchedAt, confidence: 'reference' as const },
      source: ESTIMATE_SOURCE,
      fetchedAt,
      estimate: true,
      note: ESTIMATE_NOTE,
    };
    if (args.flags.pretty) ctx.stdout(prettyRoute(r));
    else printJson(ctx, r);
    return;
  }
  const r = await computeRoute({ apiKey: key, fetch: ctx.fetch, now: ctx.now }, from, to, {
    mode: mode as RouteMode,
    depart: flagStr(args, 'depart'),
    lang: flagStr(args, 'lang'),
  });
  if (args.flags.pretty) ctx.stdout(prettyRoute(r));
  else printJson(ctx, r);
}
