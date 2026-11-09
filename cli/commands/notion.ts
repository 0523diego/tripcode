// `tripcode export notion <tripId> [--file x.ts] [--parent <pageId>] [--dry-run]`
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CliError, checkFileName, checkTripId, flagStr, printJson } from '../context.ts';
import type { CliContext, ParsedArgs } from '../context.ts';
import { NotionClient, normalizePageId, syncTrip } from '../notion.ts';
import type { NotionState } from '../notion.ts';
import { mapAttachments } from '../notion.ts';
import { renderTrip, stripMarkers } from '../notion-render.ts';
import type { Issue } from '../../src/core/types.ts';

export const NOTION_SETUP = `一次性設定：
  1. 開啟 https://www.notion.so/profile/integrations ，建立 Internal integration，複製 secret
  2. 在專案根目錄的 .env 加入  NOTION_TOKEN=你的secret
  3. 在 Notion 建一個用來放行程的頁面，右上角 ⋯ → Connections → 加入你的 integration
  4. 複製該頁面網址（或網址最後那串 32 碼 id），在 .env 加入  NOTION_PARENT_PAGE_ID=頁面id
  詳見 README「在手機上看行程（Notion）」。`;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
function formatTime(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function readState(file: string): Promise<NotionState> {
  try {
    const j = JSON.parse(await readFile(file, 'utf8'));
    return { ...(j.pageId ? { pageId: j.pageId } : {}), ...(j.variants ? { variants: j.variants } : {}), files: j.files ?? {} };
  } catch {
    return { files: {} };
  }
}
async function writeState(file: string, state: NotionState): Promise<void> {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  await rename(tmp, file);
}

export async function notionCommand(ctx: CliContext, args: ParsedArgs): Promise<void> {
  const tripId = checkTripId(args.positionals[2]);
  const file = checkFileName(flagStr(args, 'file'));
  const dry = args.flags['dry-run'] === true;
  const tripDir = path.join(ctx.root, 'trips', tripId);
  const tripPath = path.join(tripDir, file);
  try {
    await stat(tripPath);
  } catch {
    throw new CliError(`找不到行程檔：trips/${tripId}/${file}`);
  }
  let trip;
  try {
    trip = await ctx.loadTrip(tripPath);
  } catch (e) {
    throw new CliError(`無法載入 trips/${tripId}/${file}：${e instanceof Error ? e.message : String(e)}`);
  }
  const core = await ctx.loadCore();
  const issues: Issue[] = core.checkTrip(trip);
  const blocks = renderTrip({ trip, issues, mapsLinks: (d) => {
      const l = core.lodgingByDay?.(trip)?.[trip.days.indexOf(d)];
      return core.dayMapsLinks(d, { start: l?.start?.item, end: l?.end?.item });
    }, syncedAt: formatTime(ctx.now()) });
  const title = file === 'trip.ts' ? trip.title : `${trip.title}（${file.replace(/\.ts$/, '')}）`;

  if (dry) {
    const shown = stripMarkers(
      mapAttachments(blocks, (b) => {
        const copy = JSON.parse(JSON.stringify(b));
        copy[b.type].file_upload = { id: `<upload:${b._attach!.file}>` };
        delete copy._attach;
        return copy;
      }),
    );
    printJson(ctx, { dryRun: true, title, parent: { type: 'page_id', page_id: '<NOTION_PARENT_PAGE_ID>' }, children: shown });
    return;
  }

  const token = ctx.env.NOTION_TOKEN?.trim();
  if (!token) throw new CliError(`找不到 NOTION_TOKEN。\n${NOTION_SETUP}`);

  const stateFile = path.join(tripDir, '.notion.json');
  const state = await readState(stateFile);
  const existing = file === 'trip.ts' ? state.pageId : state.variants?.[file];

  let parentPageId: string | undefined;
  const rawParent = flagStr(args, 'parent') ?? ctx.env.NOTION_PARENT_PAGE_ID?.trim();
  if (rawParent) {
    parentPageId = normalizePageId(rawParent);
    if (!parentPageId) throw new CliError(`無法辨識父頁面 id：${rawParent}（請貼頁面網址或 32 碼 id）`);
  } else if (!existing) {
    throw new CliError(`找不到父頁面。請設定 NOTION_PARENT_PAGE_ID，或加上 --parent <pageId>。\n${NOTION_SETUP}`);
  }

  const client = new NotionClient({ token, fetch: ctx.fetch });
  await mkdir(tripDir, { recursive: true });
  const result = await syncTrip({
    client,
    title,
    ...(parentPageId ? { parentPageId } : {}),
    ...(existing ? { existingPageId: existing } : {}),
    blocks,
    tripDir,
    state,
    save: async (s) => {
      // pageId is recorded as soon as it is known by the sync, below; here we only persist hashes.
      await writeState(stateFile, s);
    },
    warn: (m) => ctx.stderr(`警告：${m}\n`),
    onPage: (id) => {
      if (file === 'trip.ts') state.pageId = id;
      else (state.variants ??= {})[file] = id;
    },
  });
  await writeState(stateFile, state);

  const out = { ok: true, tripId, file, ...result };
  if (args.flags.pretty) {
    ctx.stdout(`${result.created ? '已建立' : '已更新'} Notion 頁面（${result.blocks} 個區塊，上傳 ${result.uploaded} 個附件、沿用 ${result.reused} 個）\n${result.url ?? result.pageId}\n`);
  } else printJson(ctx, out);
}
