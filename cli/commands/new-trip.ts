// `tripcode new <tripId> --title ... --start ... --end ... --tz ...`: scaffold trips/<id>/.
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CliError, checkTripId, flagStr, printJson } from '../context.ts';
import type { CliContext, ParsedArgs } from '../context.ts';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[a-z0-9-]+$/;
const MAX_DAYS = 366;

function parseDate(label: string, v: string | undefined): Date {
  if (!v) throw new CliError(`缺少 --${label} YYYY-MM-DD`);
  const d = DATE_RE.test(v) ? new Date(`${v}T00:00:00Z`) : undefined;
  if (!d || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) {
    throw new CliError(`無效的日期 --${label} ${v}（格式 YYYY-MM-DD，且須為真實日期）`);
  }
  return d;
}

function listDates(start: Date, end: Date): string[] {
  const out: string[] = [];
  for (let t = start.getTime(); t <= end.getTime(); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

function parseCount(name: string, v: string | undefined, def: number, min: number): number {
  if (v === undefined) return def;
  if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > 99) throw new CliError(`無效的 --${name}：${v}（需為 ${min}–99 的整數）`);
  return Number(v);
}

function parseChildren(v: string | undefined): number[] {
  if (v === undefined) return [];
  const ages = v.split(',').map((s) => s.trim());
  for (const a of ages) {
    if (!/^\d+$/.test(a) || Number(a) > 17) throw new CliError(`無效的 --children：${v}（以逗號分隔的年齡 0–17，例如 5,8）`);
  }
  return ages.map(Number);
}

function checkSlug(name: string, v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  if (!ID_RE.test(v)) throw new CliError(`無效的 --${name}：${v}（只能使用小寫英數字與 -）`);
  return v;
}

function checkTz(v: string | undefined): string {
  if (!v) throw new CliError('缺少 --tz（IANA 時區，例如 Europe/Zurich、Asia/Tokyo）');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: v });
  } catch {
    throw new CliError(`無效的時區 --tz ${v}（需為 IANA 時區，例如 Europe/Zurich）`);
  }
  return v;
}

/** Single-quoted TS string literal. */
function q(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r\n|\r|\n|\u2028|\u2029/g, '\\n')}'`;
}

/** What step 0 (找方向) already knows; each value is a ready-made line for brief.md. */
export interface BriefPrefill {
  destination?: string;
  origin?: string;
  /** Replaces the 同行 line (which is otherwise built from adults / children). */
  party?: string;
  budget?: string;
  preferences?: string[];
}

export interface NewTripOptions {
  tripId: string;
  title: string;
  start: string;
  end: string;
  tz: string;
  adults: number;
  childrenAges: number[];
  destination?: string;
  style?: string;
  dates: string[];
  today: string;
  /** Only `tripcode idea finish` sets this; `tripcode new` leaves every field as 「（待填）」. */
  prefill?: BriefPrefill;
}

export function renderTripTs(o: NewTripOptions): string {
  const lines = [
    `import { defineTrip } from '../../src/core/types.ts';`,
    ``,
    `export default defineTrip({`,
    `  title: ${q(o.title)},`,
    `  start: ${q(o.start)},`,
    `  end: ${q(o.end)},`,
    `  tz: ${q(o.tz)},`,
    `  party: { adults: ${o.adults}, childrenAges: [${o.childrenAges.join(', ')}] },`,
  ];
  if (o.style) lines.push(`  style: ${q(o.style)},`);
  if (o.destination) lines.push(`  destination: ${q(o.destination)},`);
  lines.push(`  days: [`);
  for (const date of o.dates) lines.push(`    { date: ${q(date)}, items: [] },`);
  lines.push(`  ],`, `  candidates: [],`, `});`, ``);
  return lines.join('\n');
}

export function renderBrief(o: NewTripOptions): string {
  const pre = o.prefill;
  const party = pre?.party ?? `${o.adults} 位成人` + (o.childrenAges.length ? `、${o.childrenAges.length} 位小孩（${o.childrenAges.join('、')} 歲）` : '');
  const banner = pre
    ? `由 \`tripcode idea finish\` 於 ${o.today} 依第 0 步（找方向）的回答建立。已知的先填好；請與 Claude 跑 onboard-trip 補齊，標「（待填）」者尚未確認。`
    : `由 \`tripcode new\` 於 ${o.today} 建立的空白簡報。請與 Claude 跑 onboard-trip 補齊；標「（待填）」者尚未確認。`;
  const preferences = pre?.preferences?.length ? pre.preferences.map((p) => `- ${p}`).join('\n') : '- （待填）';
  return `# ${o.title} 旅程簡報

> ${banner}

## 基本
- 目的地 / 熟悉度：${pre?.destination ?? o.destination ?? '（待填）'} / （待填）
- 日期 / 天數：${o.start} ~ ${o.end}（${o.dates.length} 天，時區 ${o.tz}）
- 出發地：${pre?.origin ?? '（待填）'}
- 同行：${party}
- 行動限制：（待填）

## 已確定（locked）
- （待填）

## 一定 / 絕不
- 一定：（待填）
- 絕不：（待填）

## 偏好（比較題結果）
${preferences}

## 預算與取捨
- ${pre?.budget ?? '（待填）'}

## 待確認
- 
`;
}

/** Raw (string) inputs, as they arrive from CLI flags or the dev-server endpoint. */
export interface NewTripInput {
  tripId?: string;
  title?: string;
  start?: string;
  end?: string;
  tz?: string;
  adults?: string;
  children?: string;
  destination?: string;
  style?: string;
}

/** Validates the raw inputs and expands them into render options. Throws CliError with a user-facing message. */
export function buildNewTripOptions(input: NewTripInput, today: string): NewTripOptions {
  const tripId = checkTripId(input.tripId);
  const title = input.title?.trim();
  if (!title) throw new CliError('缺少 --title "<標題>"');
  if (title.length > 120) throw new CliError('標題過長（最多 120 字）');
  const startD = parseDate('start', input.start);
  const endD = parseDate('end', input.end);
  if (startD.getTime() > endD.getTime()) throw new CliError('--start 不可晚於 --end');
  const dates = listDates(startD, endD);
  if (dates.length > MAX_DAYS) throw new CliError(`行程最多 ${MAX_DAYS} 天（目前 ${dates.length} 天）`);
  return {
    tripId,
    title,
    start: dates[0]!,
    end: dates[dates.length - 1]!,
    tz: checkTz(input.tz),
    adults: parseCount('adults', input.adults, 2, 1),
    childrenAges: parseChildren(input.children),
    destination: checkSlug('destination', input.destination),
    style: checkSlug('style', input.style),
    dates,
    today,
  };
}

/** Writes trip.ts, brief.md and inbox/.gitkeep into an existing folder (which the caller created or checked is free). */
export async function writeTripFiles(dir: string, opts: NewTripOptions): Promise<string[]> {
  await mkdir(path.join(dir, 'inbox'));
  await writeFile(path.join(dir, 'trip.ts'), renderTripTs(opts));
  await writeFile(path.join(dir, 'brief.md'), renderBrief(opts));
  await writeFile(path.join(dir, 'inbox', '.gitkeep'), '');
  return [`trips/${opts.tripId}/trip.ts`, `trips/${opts.tripId}/brief.md`, `trips/${opts.tripId}/inbox/.gitkeep`];
}

/** Creates trips/<id>/ (trip.ts, brief.md, inbox/.gitkeep). Refuses to overwrite an existing trip. */
export async function createTripFiles(root: string, opts: NewTripOptions): Promise<string[]> {
  const tripsDir = path.join(root, 'trips');
  const dir = path.join(tripsDir, opts.tripId);
  await mkdir(tripsDir, { recursive: true });
  try {
    await mkdir(dir); // non-recursive: fails if it already exists, so nothing is overwritten
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new CliError(`trips/${opts.tripId}/ 已存在，不會覆寫`);
    throw e;
  }
  return writeTripFiles(dir, opts);
}

export async function newTripCommand(ctx: CliContext, args: ParsedArgs): Promise<void> {
  const opts = buildNewTripOptions(
    {
      tripId: args.positionals[1],
      title: flagStr(args, 'title'),
      start: flagStr(args, 'start'),
      end: flagStr(args, 'end'),
      tz: flagStr(args, 'tz'),
      adults: flagStr(args, 'adults'),
      children: flagStr(args, 'children'),
      destination: flagStr(args, 'destination'),
      style: flagStr(args, 'style'),
    },
    ctx.now().toISOString().slice(0, 10),
  );
  const { tripId, dates } = opts;
  const files = await createTripFiles(ctx.root, opts);

  const warnings: string[] = [];
  for (const [kind, id] of [['destinations', opts.destination], ['styles', opts.style]] as const) {
    if (!id) continue;
    try {
      await access(path.join(ctx.root, kind, `${id}.md`));
    } catch {
      warnings.push(`找不到 ${kind}/${id}.md`);
    }
  }

  if (args.flags.pretty) {
    ctx.stdout(`已建立 trips/${tripId}/（${dates.length} 天）\n${files.map((f) => `  ${f}\n`).join('')}`);
    for (const w of warnings) ctx.stdout(`警告：${w}\n`);
    ctx.stdout(`下一步：用 onboard-trip 補齊 brief.md，或執行 npm run dev 開啟 viewer\n`);
  } else {
    printJson(ctx, { ok: true, tripId, files, ...(warnings.length ? { warnings } : {}) });
  }
}
