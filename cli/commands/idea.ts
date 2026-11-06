// `tripcode idea …`: step 0 (找方向). Reads and writes trips/<id>/idea.json, always through src/core/idea.ts.
// The file IO helpers (readIdea, writeIdea, createIdea, updateIdea, finishIdea) are exported for the dev server.
import { access, mkdir, readFile, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CliError, checkTripId, flagStr, parseArgs, printJson } from '../context.ts';
import type { CliContext, ParsedArgs } from '../context.ts';
import {
  ANSWER_FIELDS,
  IdeaError,
  STEP_TITLE,
  addPlaces,
  applyAnswer,
  chosenPlace,
  choosePlace,
  ideaBriefPrefill,
  ideaSummary,
  latestRound,
  markCreated,
  newIdea,
  nextStep,
  parseIdea,
  rejectPlace,
  rejectRound,
  roundPlaces,
  setDates,
  suggestTripId,
} from '../../src/core/idea.ts';
import type { Idea, IdeaAnswer, IdeaPlace, IdeaStep } from '../../src/core/idea.ts';
import { buildNewTripOptions, createTripFiles, writeTripFiles } from './new-trip.ts';

export const IDEA_USAGE = `用法：tripcode idea <子指令>（加 --pretty 輸出易讀格式，預設為 JSON）

  idea new <id>                                  建立 trips/<id>/idea.json（第 0 步：找方向）；trips/<id>/ 已存在就拒絕
  idea show <id> [--pretty]                      JSON：{idea, next, summary}；--pretty：現在問到哪、已回答什麼、這一輪的點子
  idea answer <id> <field> <value>               記錄一個回答；value 是 JSON，null 表示「不知道／跳過」
      known     '{"decided":true,"place":"瑞士"}' | '{"decided":false}' | '"瑞士"'（出發前就決定好了）
      origin    '"台北"' | 台北（沒有引號也行） | null
      focus     '"budget"' | '"scenery"' | '"both"'
      budget    '{"amount":60000,"currency":"TWD","per":"person"}' | null
      scenery   '{"tags":["mountains","food"],"text":"想泡溫泉"}' | null
      when      '{"months":[4,5],"text":"清明連假"}' | null
      days      5 | null
      party     '{"who":"friends","adults":3,"childrenAges":[]}' | null
      wantNow   true | false（直接推薦：跳過 suggest 之前還沒問的題目）
  idea places <id> --json '<陣列>' | --file <path>   AI 新增一輪點子（1–5 個）；--file 相對於專案根目錄
  idea choose <id> <placeId>                     選這個
  idea reject <id> <placeId>                     不要這個
  idea reject-round <id>                         再給我別的：把最新一輪還沒選的全部換掉
  idea dates <id> --start YYYY-MM-DD --end YYYY-MM-DD
  idea finish <id> [--title "<標題>"] [--tz <IANA>] [--adults N] [--children 5,8] [--trip-id <新代號>]
                                                  建立行程 trips/<新代號>/，並把 idea.json 搬進去
`;

// ---------------------------------------------------------------------------------------------
// File IO

export function ideaDir(root: string, id: string): string {
  return path.join(root, 'trips', id);
}

export function ideaFile(root: string, id: string): string {
  return path.join(ideaDir(root, id), 'idea.json');
}

const exists = (p: string) => access(p).then(() => true, () => false);

async function atomicWrite(file: string, content: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, file);
}

const serialize = (idea: Idea): string => JSON.stringify(idea, null, 2) + '\n';

/** Reads and strictly validates trips/<id>/idea.json. */
export async function readIdea(root: string, id: string): Promise<Idea> {
  checkTripId(id);
  let text: string;
  try {
    text = await readFile(ideaFile(root, id), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new CliError(`找不到 trips/${id}/idea.json（先用 tripcode idea new ${id} 建立）`);
    throw e;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new IdeaError(`trips/${id}/idea.json 不是有效的 JSON`);
  }
  return parseIdea(raw);
}

/** Validates, then writes atomically. The folder must already exist (only createIdea and finishIdea make folders). */
export async function writeIdea(root: string, id: string, idea: Idea): Promise<void> {
  checkTripId(id);
  await atomicWrite(ideaFile(root, id), serialize(parseIdea(idea)));
}

/** Creates trips/<id>/idea.json. Refuses when trips/<id>/ already exists, so nothing is overwritten. */
export async function createIdea(root: string, id: string, now: Date): Promise<Idea> {
  checkTripId(id);
  await mkdir(path.join(root, 'trips'), { recursive: true });
  try {
    await mkdir(ideaDir(root, id)); // non-recursive: fails if it exists
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new CliError(`trips/${id}/ 已存在，不會覆寫`);
    throw e;
  }
  const idea = newIdea(now);
  await writeIdea(root, id, idea);
  return idea;
}

/** Read, apply a pure operation from src/core/idea.ts, write. Last writer wins (the page and the AI take turns). */
export async function updateIdea(root: string, id: string, fn: (idea: Idea) => Idea): Promise<Idea> {
  const next = fn(await readIdea(root, id));
  await writeIdea(root, id, next);
  return next;
}

export interface IdeaListEntry {
  id: string;
  updatedAt: string;
  next: IdeaStep;
  /** Chips for the home page card (answered questions, in order). */
  summary: string[];
}

/**
 * Every unfinished idea (idea.json without tripId), newest first, for the home page. A broken or half-written file is
 * skipped rather than failing the whole list.
 */
export async function listIdeas(root: string): Promise<IdeaListEntry[]> {
  let dirs: string[];
  try {
    dirs = (await readdir(path.join(root, 'trips'), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const out: IdeaListEntry[] = [];
  for (const id of dirs) {
    try {
      const idea = await readIdea(root, id);
      if (!idea.tripId) out.push({ id, updatedAt: idea.updatedAt, next: nextStep(idea), summary: ideaSummary(idea) });
    } catch {
      /* no idea.json, or not valid yet */
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export interface FinishInput {
  title?: string;
  tz?: string;
  /** Raw strings, validated by buildNewTripOptions (same as `tripcode new`). */
  adults?: string;
  children?: string;
  /** Override the suggested `<slug>-<YYYY-MM>`. */
  tripId?: string;
}

export interface FinishResult {
  tripId: string;
  files: string[];
  /** True when the old trips/<ideaId>/ folder was removed (or reused, when the new id is the same). */
  ideaFolderRemoved: boolean;
  /** Things that were left in the old folder, which is therefore kept. */
  leftover?: string[];
}

/**
 * Creates the real trip from a finished idea: trips/<newId>/ with trip.ts, brief.md (prefilled with what step 0
 * knows), inbox/.gitkeep and idea.json (with tripId set); then moves idea.json and cover.jpg out of
 * trips/<ideaId>/ and removes it if nothing else is in it.
 */
export async function finishIdea(root: string, ideaId: string, input: FinishInput, now: Date): Promise<FinishResult> {
  const idea = await readIdea(root, ideaId);
  const step = nextStep(idea);
  if (step !== 'finish') throw new IdeaError(step === 'done' ? `行程已經建立（${idea.tripId}）` : `還不能建立行程：現在在「${STEP_TITLE[step]}」這一步`);
  const place = chosenPlace(idea)!;
  const dates = idea.dates!;

  const tripsDir = path.join(root, 'trips');
  const taken = new Set((await readdir(tripsDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name));
  taken.delete(ideaId); // the idea's own folder can be reused when the new id is the same
  const newId = input.tripId !== undefined ? checkTripId(input.tripId) : suggestTripId(idea, taken);
  if (taken.has(newId)) throw new CliError(`trips/${newId}/ 已存在，不會覆寫（用 --trip-id 換一個代號）`);

  const nDays = Math.round((Date.parse(`${dates.end}T00:00:00Z`) - Date.parse(`${dates.start}T00:00:00Z`)) / 86_400_000) + 1;
  const party = idea.party;
  // destinations/<country>.md only exists for countries the project already has notes on.
  const destination = place.kind === 'country' && (await exists(path.join(root, 'destinations', `${place.slug}.md`))) ? place.slug : undefined;
  const opts = buildNewTripOptions(
    {
      tripId: newId,
      title: input.title ?? `${place.name} ${nDays} 天`,
      start: dates.start,
      end: dates.end,
      tz: input.tz ?? place.tz,
      adults: input.adults ?? (party ? String(party.adults) : undefined),
      children: input.children ?? (party && party.childrenAges.length ? party.childrenAges.join(',') : undefined),
      destination,
    },
    now.toISOString().slice(0, 10),
  );
  opts.prefill = ideaBriefPrefill(idea);
  const created = markCreated(idea, newId, now);

  const oldDir = ideaDir(root, ideaId);
  const newDir = ideaDir(root, newId);
  let files: string[];
  if (newId === ideaId) {
    for (const f of ['trip.ts', 'brief.md', 'inbox']) {
      if (await exists(path.join(oldDir, f))) throw new CliError(`trips/${ideaId}/${f} 已存在，不會覆寫`);
    }
    files = await writeTripFiles(oldDir, opts);
    await writeIdea(root, newId, created);
    files.push(`trips/${newId}/idea.json`);
    return { tripId: newId, files, ideaFolderRemoved: true };
  }

  files = await createTripFiles(root, opts);
  await writeIdea(root, newId, created);
  files.push(`trips/${newId}/idea.json`);
  // Move, not copy: a second idea.json under the old id would show up as an unfinished idea.
  await unlink(ideaFile(root, ideaId));
  if (await exists(path.join(oldDir, 'cover.jpg'))) {
    await rename(path.join(oldDir, 'cover.jpg'), path.join(newDir, 'cover.jpg'));
    files.push(`trips/${newId}/cover.jpg`);
  }
  const left = await readdir(oldDir);
  if (left.length === 0) {
    await rmdir(oldDir);
    return { tripId: newId, files, ideaFolderRemoved: true };
  }
  return { tripId: newId, files, ideaFolderRemoved: false, leftover: left.sort() };
}

// ---------------------------------------------------------------------------------------------
// CLI

/** `--json` and `--trip-id` are not in cli/context.ts's flag tables, so they are taken out here before parseArgs. */
function takeExtraFlags(argv: string[]): { rest: string[]; json?: string; tripId?: string } {
  const rest: string[] = [];
  const out: { json?: string; tripId?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const m = /^--(json|trip-id)(=(.*))?$/.exec(a);
    if (!m) {
      rest.push(a);
      continue;
    }
    const v = m[2] !== undefined ? m[3] : argv[++i];
    if (v === undefined || v === '') throw new CliError(`--${m[1]} 需要一個值`);
    if (m[1] === 'json') out.json = v;
    else out.tripId = v;
  }
  return { rest, ...out };
}

function parseJsonValue(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new CliError(`${label} 不是有效的 JSON：${raw.slice(0, 80)}（字串要加雙引號，例如 '"台北"'）`);
  }
}

/** value is JSON; origin and known also take a bare string (台北), used when it is not valid JSON at all. */
function answerFromArgs(fieldRaw: string, raw: string): IdeaAnswer {
  const field = fieldRaw === 'want-now' ? 'wantNow' : fieldRaw;
  if (!(ANSWER_FIELDS as readonly string[]).includes(field)) throw new CliError(`不認得的欄位：${fieldRaw}（可用：${ANSWER_FIELDS.join('、')}）`);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    if (field !== 'origin' && field !== 'known') parseJsonValue(raw, 'value'); // throws
    value = raw;
  }
  // known: a plain place name means "I decided, and it is this".
  if (field === 'known' && typeof value === 'string') value = { decided: true, place: value };
  return { field, value } as IdeaAnswer;
}

const q = (s: string) => `'${s}'`;

/** What to do at each step, in words, for `show --pretty` (the page asks the same questions with cards). */
function stepGuide(id: string, step: IdeaStep, idea: Idea): string[] {
  const ans = (field: string, example: string) => `記錄：tripcode idea answer ${id} ${field} ${q(example)}（跳過就填 null）`;
  switch (step) {
    case 'known':
      return ['問：決定好要去哪了嗎？', ans('known', '{"decided":false}') + ' 或 ' + q('"瑞士"')];
    case 'origin':
      return ['問：從哪裡出發？', ans('origin', '"台北"')];
    case 'focus':
      return ['問：這趟比較在意預算、風景，還是兩者都要？（也可以說「直接推薦」→ wantNow true）', ans('focus', '"both"')];
    case 'budget':
      return ['問：預算大概多少？（金額、幣別、每人或總共）', ans('budget', '{"amount":60000,"currency":"TWD","per":"person"}')];
    case 'scenery':
      return ['問：想看什麼、想做什麼？（可複選：山、海、城市、美食、文化、古蹟、自然、雪、夜生活、購物）', ans('scenery', '{"tags":["mountains","food"]}')];
    case 'when':
      return ['問：大概什麼時候？（月份即可）', ans('when', '{"months":[4,5]}')];
    case 'days':
      return ['問：去幾天？', ans('days', '5')];
    case 'party':
      return ['問：跟誰去？幾位成人、小孩幾歲？', ans('party', '{"who":"friends","adults":3,"childrenAges":[]}')];
    case 'suggest':
      return [
        '做：照 find-destination skill 給 3 個不同方向的點子（最多 5 個），每個一句話 why 對應他的回答',
        `記錄：tripcode idea places ${id} --json ${q('[{"id":"…","slug":"…","name":"…","kind":"country","lat":0,"lng":0,"tz":"…","why":"…"}]')}`,
      ];
    case 'choose':
      return [
        '等使用者在畫面上選（選這個／不要／再給我別的）。使用者在面板說了就代他記錄：',
        `  tripcode idea choose ${id} <placeId> | idea reject ${id} <placeId> | idea reject-round ${id}（換新一輪再用 places）`,
      ];
    case 'locate':
      return [`做：把「${idea.known?.decided ? idea.known.place : ''}」放到地球上（一個地點）`, `記錄：tripcode idea places ${id} --json ${q('[{…}]')}（只給一個，會自動選定）`];
    case 'dates':
      return ['問：出發和回來的日期？', `記錄：tripcode idea dates ${id} --start YYYY-MM-DD --end YYYY-MM-DD`];
    case 'finish':
      return ['建立行程是使用者按畫面上的「建立行程」；使用者明說「幫我建立」才執行：', `  tripcode idea finish ${id}`];
    case 'done':
      return [`行程已建立：trips/${idea.tripId}/。之後照 plan-trip 走第 1 步（盤點）。`];
  }
}

function placeLine(p: IdeaPlace, i: number): string {
  const cost = p.cost ? `；費用：${p.cost.text}${p.cost.source ? `（來源 ${p.cost.source}）` : p.cost.text.includes('估計') ? '' : '（估計）'}` : '';
  const months = p.bestMonths?.length ? `；適合 ${p.bestMonths.join('、')} 月` : '';
  return `  ${i + 1}. [${p.status}] ${p.name}（id: ${p.id}，${p.tz}）— ${p.why}${months}${cost}`;
}

function showPretty(id: string, idea: Idea): string {
  const step = nextStep(idea);
  const out: string[] = [`第 0 步：找方向（trips/${id}/idea.json）`];
  const summary = ideaSummary(idea);
  out.push(summary.length ? '已回答：' : '還沒有回答。', ...summary.map((s) => `  - ${s}`));
  out.push('', `下一步：${step} — ${STEP_TITLE[step]}`, ...stepGuide(id, step, idea).map((s) => `  ${s}`));
  const round = latestRound(idea);
  if (round > 0) out.push('', `第 ${round} 輪的點子：`, ...roundPlaces(idea, round).map(placeLine));
  const rejected = idea.places.filter((p) => p.status === 'rejected');
  if (rejected.length) out.push('', `已被拒絕（新一輪不要再給）：${rejected.map((p) => p.name).join('、')}`);
  return out.join('\n') + '\n';
}

function report(ctx: CliContext, args: ParsedArgs, id: string, idea: Idea, doneText: string): void {
  const next = nextStep(idea);
  if (args.flags.pretty) ctx.stdout(`${doneText}\n下一步：${next} — ${STEP_TITLE[next]}\n`);
  else printJson(ctx, { ok: true, next, summary: ideaSummary(idea) });
}

export async function ideaCommand(ctx: CliContext, argv: string[]): Promise<number> {
  try {
    return await runIdea(ctx, argv);
  } catch (e) {
    // IdeaError is the model's user-facing error; the CLI reports it like any other CliError.
    if (e instanceof IdeaError) throw new CliError(e.message);
    throw e;
  }
}

async function runIdea(ctx: CliContext, argv: string[]): Promise<number> {
  const { rest, json, tripId: tripIdFlag } = takeExtraFlags(argv);
  const args = parseArgs(rest);
  const sub = args.positionals[0];
  if (!sub || args.flags.help || sub === 'help') {
    ctx.stdout(IDEA_USAGE);
    return sub || args.flags.help ? 0 : 1;
  }
  const now = ctx.now();
  const need = (i: number, what: string): string => {
    const v = args.positionals[i];
    if (!v) throw new CliError(`缺少 ${what}\n\n${IDEA_USAGE}`);
    return v;
  };
  const id = checkTripId(args.positionals[1]);

  switch (sub) {
    case 'new': {
      await createIdea(ctx.root, id, now);
      const file = `trips/${id}/idea.json`;
      if (args.flags.pretty) ctx.stdout(`已建立 ${file}\n下一步：known — ${STEP_TITLE.known}\n`);
      else printJson(ctx, { ok: true, tripId: id, file, next: 'known' });
      return 0;
    }
    case 'show': {
      const idea = await readIdea(ctx.root, id);
      if (args.flags.pretty) ctx.stdout(showPretty(id, idea));
      else printJson(ctx, { idea, next: nextStep(idea), summary: ideaSummary(idea) });
      return 0;
    }
    case 'answer': {
      const answer = answerFromArgs(need(2, '<field>'), need(3, '<value>'));
      const idea = await updateIdea(ctx.root, id, (i) => applyAnswer(i, answer, now));
      report(ctx, args, id, idea, `已記錄 ${answer.field}`);
      return 0;
    }
    case 'places': {
      const file = flagStr(args, 'file');
      if ((json === undefined) === (file === undefined)) throw new CliError('請二選一：--json \'<陣列>\' 或 --file <path>');
      let text = json;
      if (text === undefined) {
        try {
          text = await readFile(path.resolve(ctx.root, file!), 'utf8');
        } catch {
          throw new CliError(`讀不到檔案：${file}`);
        }
      }
      const raw = parseJsonValue(text, json !== undefined ? '--json' : file!);
      const list = Array.isArray(raw) ? raw : (raw as { places?: unknown } | null)?.places;
      const idea = await updateIdea(ctx.root, id, (i) => addPlaces(i, list, now));
      report(ctx, args, id, idea, `已新增第 ${latestRound(idea)} 輪的 ${roundPlaces(idea).length} 個點子`);
      return 0;
    }
    case 'choose': {
      const placeId = need(2, '<placeId>');
      const idea = await updateIdea(ctx.root, id, (i) => choosePlace(i, placeId, now));
      report(ctx, args, id, idea, `已選定 ${placeId}`);
      return 0;
    }
    case 'reject': {
      const placeId = need(2, '<placeId>');
      const idea = await updateIdea(ctx.root, id, (i) => rejectPlace(i, placeId, now));
      report(ctx, args, id, idea, `已排除 ${placeId}`);
      return 0;
    }
    case 'reject-round': {
      const idea = await updateIdea(ctx.root, id, (i) => rejectRound(i, now));
      report(ctx, args, id, idea, '已換掉這一輪的點子');
      return 0;
    }
    case 'dates': {
      const start = flagStr(args, 'start');
      const end = flagStr(args, 'end');
      if (!start || !end) throw new CliError('缺少 --start YYYY-MM-DD --end YYYY-MM-DD');
      const idea = await updateIdea(ctx.root, id, (i) => setDates(i, start, end, now));
      report(ctx, args, id, idea, `已記錄日期 ${start} ~ ${end}`);
      return 0;
    }
    case 'finish': {
      const r = await finishIdea(
        ctx.root,
        id,
        { title: flagStr(args, 'title'), tz: flagStr(args, 'tz'), adults: flagStr(args, 'adults'), children: flagStr(args, 'children'), tripId: tripIdFlag },
        now,
      );
      if (args.flags.pretty) {
        ctx.stdout(`已建立行程 trips/${r.tripId}/\n${r.files.map((f) => `  ${f}\n`).join('')}`);
        if (r.leftover) ctx.stdout(`警告：trips/${id}/ 裡還有 ${r.leftover.join('、')}，所以保留了這個資料夾\n`);
        ctx.stdout(`下一步：用 onboard-trip 補齊 brief.md（plan-trip 第 1 步），或在 viewer 開啟 #/trip/${r.tripId}\n`);
      } else printJson(ctx, { ok: true, ...r });
      return 0;
    }
    default:
      throw new CliError(`未知的 idea 子指令：${sub}\n\n${IDEA_USAGE}`);
  }
}
