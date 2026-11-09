// Commands that operate on trips/<id>/ files: list, check, export.
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CliError, checkFileName, checkTripId, flagStr, printJson, requireApiKey } from '../context.ts';
import type { CliContext, ParsedArgs } from '../context.ts';
import { placeDetails } from '../google.ts';
import type { Issue, OpeningHours, Trip } from '../../src/core/types.ts';
import { tripToKml } from '../../src/core/kml.ts';
import { deriveBookingTodos } from '../../src/core/bookings.ts';
import { planStages, stageSummary } from '../../src/core/plan.ts';
import { readiness, readinessSummary } from '../../src/core/readiness.ts';

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function tripFile(ctx: CliContext, tripId: string, file: string): string {
  return path.join(ctx.root, 'trips', tripId, file);
}

async function loadTripOrFail(ctx: CliContext, tripId: string, file: string): Promise<Trip> {
  const p = tripFile(ctx, tripId, file);
  if (!(await exists(p))) throw new CliError(`找不到行程檔：trips/${tripId}/${file}`);
  try {
    return await ctx.loadTrip(p);
  } catch (e) {
    throw new CliError(`無法載入 trips/${tripId}/${file}：${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function listCommand(ctx: CliContext, args: ParsedArgs): Promise<void> {
  const tripsDir = path.join(ctx.root, 'trips');
  let names: string[] = [];
  try {
    names = (await readdir(tripsDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
    // no trips dir yet
  }
  const rows: { id: string; title?: string; start?: string; end?: string; days?: number; candidates?: number; variants: string[]; error?: string }[] = [];
  for (const id of names) {
    if (!(await exists(tripFile(ctx, id, 'trip.ts')))) continue;
    const variants = (await readdir(path.join(tripsDir, id))).filter((f) => /^variant-[a-z0-9-]+\.ts$/.test(f)).sort();
    try {
      const t = await ctx.loadTrip(tripFile(ctx, id, 'trip.ts'));
      rows.push({ id, title: t.title, start: t.start, end: t.end, days: t.days.length, candidates: t.candidates.length, variants });
    } catch (e) {
      rows.push({ id, variants, error: e instanceof Error ? e.message : String(e) });
    }
  }
  if (args.flags.pretty) {
    if (rows.length === 0) ctx.stdout('還沒有任何行程\n');
    for (const r of rows) {
      ctx.stdout(r.error ? `${r.id}  （載入失敗：${r.error}）\n` : `${r.id}  ${r.title}  ${r.start} ~ ${r.end}  ${r.days} 天\n`);
    }
  } else {
    printJson(ctx, rows);
  }
}

const LEVEL_LABEL = { error: '錯誤', warn: '警告' } as const;

export async function checkCommand(ctx: CliContext, args: ParsedArgs): Promise<number> {
  const tripId = checkTripId(args.positionals[1]);
  const file = checkFileName(flagStr(args, 'file'));
  const trip = await loadTripOrFail(ctx, tripId, file);
  const core = await ctx.loadCore();

  let hoursFor: ((item: { id: string }) => OpeningHours | undefined) | undefined;
  const liveErrors: string[] = [];
  if (args.flags.live) {
    const apiKey = requireApiKey(ctx);
    const byPlace = new Map<string, OpeningHours | undefined>();
    for (const day of trip.days) {
      for (const item of day.items) {
        if (!item.placeId || item.placeId.startsWith('osm:') || byPlace.has(item.placeId)) continue;
        try {
          const d = await placeDetails({ apiKey, fetch: ctx.fetch, now: ctx.now }, item.placeId);
          byPlace.set(item.placeId, d.hours?.value);
        } catch (e) {
          byPlace.set(item.placeId, undefined);
          liveErrors.push(`${item.id}：${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    hoursFor = (item) => {
      const placeId = (item as { placeId?: string }).placeId;
      return placeId ? byPlace.get(placeId) : undefined;
    };
  }

  const issues: Issue[] = core.checkTrip(trip, hoursFor ? { hoursFor } : undefined);
  const errors = issues.filter((i) => i.level === 'error').length;
  const warnings = issues.length - errors;
  for (const m of liveErrors) ctx.stderr(`無法取得即時營業時間：${m}\n`);

  if (args.flags.pretty) {
    if (issues.length === 0) ctx.stdout('行程健檢通過\n');
    for (const i of issues) {
      const where = [i.date, i.itemId].filter(Boolean).join(' ');
      ctx.stdout(`[${LEVEL_LABEL[i.level]}] ${i.code}${where ? ` (${where})` : ''}：${i.message}\n`);
    }
    if (issues.length) ctx.stdout(`\n${errors} 個錯誤，${warnings} 個警告\n`);
  } else {
    printJson(ctx, { tripId, file, live: !!args.flags.live, ok: errors === 0, errors, warnings, issues });
  }
  return errors > 0 ? 1 : 0;
}

/** 出發準備度: what is still open before you leave. Never fails the command: everything is a warning or a note. */
export async function readyCommand(ctx: CliContext, args: ParsedArgs): Promise<number> {
  const tripId = checkTripId(args.positionals[1]);
  const file = checkFileName(flagStr(args, 'file'));
  const trip = await loadTripOrFail(ctx, tripId, file);
  let brief: string | undefined;
  try {
    brief = await readFile(path.join(ctx.root, 'trips', tripId, 'brief.md'), 'utf8');
  } catch {
    /* no brief */
  }
  let profile: string | undefined;
  try {
    profile = await readFile(path.join(ctx.root, 'profile.md'), 'utf8');
  } catch {
    /* no profile: the default walking limit applies */
  }
  const issues = readiness(trip, { now: ctx.now(), brief, profile });
  const summary = readinessSummary(issues);
  const stages = planStages(trip, { now: ctx.now(), brief, profile });
  if (args.flags.pretty) {
    ctx.stdout(`${stageSummary(stages)}\n`);
    ctx.stdout(`${stages.map((s) => `${s.n}.${s.title}${s.status === 'done' ? ' ✓' : s.status === 'doing' ? ` ●(${s.open})` : ''}`).join('  ')}\n`);
    const cur = stages.find((s) => s.status === 'doing');
    if (cur) ctx.stdout(`下一步：${cur.next}（技能：${cur.skill}）\n`);
    ctx.stdout(`${summary.text}\n`);
    for (const i of issues) ctx.stdout(`[${i.level === 'warn' ? '必辦' : '提醒'}] ${i.code}${i.date ? ` (${i.date})` : ''}：${i.message}\n`);
  } else printJson(ctx, { tripId, file, ...summary, stages, issues });
  return 0;
}

/** The booking list: what has to be bought, with the links to buy it from. */
export async function bookingsCommand(ctx: CliContext, args: ParsedArgs): Promise<number> {
  const tripId = checkTripId(args.positionals[1]);
  const file = checkFileName(flagStr(args, 'file'));
  const trip = await loadTripOrFail(ctx, tripId, file);
  const list = deriveBookingTodos(trip, ctx.now());
  if (args.flags.pretty) {
    const left = list.items.filter((t) => t.status === 'todo').length;
    ctx.stdout(`${left} 件待買，${list.items.filter((t) => t.status === 'booked').length} 件已買，${list.unknown.length} 件沒有訂票資訊\n`);
    for (const t of list.items) {
      ctx.stdout(`${t.status === 'todo' ? '待買' : t.status === 'booked' ? '已買' : '不需要'}  ${t.urgency.padEnd(7)} ${t.date} ${t.title}  — ${t.reason}\n`);
      if (t.status === 'todo') for (const l of t.links) ctx.stdout(`      ${l.label}${l.urlKind === 'search' ? '（搜尋）' : ''}: ${l.url}\n`);
    }
  } else printJson(ctx, { tripId, file, ...list });
  return 0;
}

export async function exportCommand(ctx: CliContext, args: ParsedArgs): Promise<void> {
  const [, kind, id] = args.positionals;
  if (kind !== 'ics' && kind !== 'links' && kind !== 'kml') {
    throw new CliError('用法：export ics <tripId> | export links <tripId> | export kml <tripId>');
  }
  const tripId = checkTripId(id);
  const file = checkFileName(flagStr(args, 'file'));
  const trip = await loadTripOrFail(ctx, tripId, file);
  const core = await ctx.loadCore();
  const dir = path.join(ctx.root, 'trips', tripId, 'export');
  await mkdir(dir, { recursive: true });

  let outFile: string;
  let content: string;
  if (kind === 'ics') {
    outFile = path.join(dir, file === 'trip.ts' ? 'trip.ics' : file.replace(/\.ts$/, '.ics'));
    content = core.tripToIcs(trip);
  } else if (kind === 'kml') {
    outFile = path.join(dir, file === 'trip.ts' ? 'trip.kml' : file.replace(/\.ts$/, '.kml'));
    content = tripToKml(trip);
  } else {
    outFile = path.join(dir, file === 'trip.ts' ? 'links.md' : file.replace(/\.ts$/, '-links.md'));
    const lines = [`# ${trip.title}`, '', '各天 Google Maps 路線連結（點開即可導航）。', ''];
    const lodging = core.lodgingByDay?.(trip);
    trip.days.forEach((day, i) => {
      lines.push(`## 第 ${i + 1} 天 ${day.date}${day.title ? ` ${day.title}` : ''}`, '');
      const links = core.dayMapsLinks(day, { start: lodging?.[i]?.start?.item, end: lodging?.[i]?.end?.item });
      if (links.length === 0) lines.push('（這天沒有可導航的地點）');
      links.forEach((url, j) => lines.push(links.length > 1 ? `- [路線 ${j + 1}](${url})` : `- [路線](${url})`));
      lines.push('');
    });
    content = lines.join('\n');
  }
  await writeFile(outFile, content, 'utf8');
  const rel = path.relative(ctx.root, outFile);
  if (args.flags.pretty) ctx.stdout(`已寫入 ${rel}\n`);
  else printJson(ctx, { ok: true, written: rel });
}
