// `tripcode buy …`: price and sale-date watches, scheduled scans, alerts, and reading pages in TripCode's own Chrome.
// Nothing here pays: the AI-payment layer (vault, pay, purchase intents, ledger) was taken out on 2026-11-04 and a copy is kept
// outside the repo. The command keeps its name so the skills that read pages with `buy browser` keep working.
import { readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CliError, printJson } from '../context.ts';
import type { CliContext } from '../context.ts';
import { logActivity, hostOf } from '../../src/purchase/activity.ts';
import { scanWithActivity } from '../../src/purchase/office.ts';
import { checkBrowseUrl, clickText, listTabs, openUrl, pageLinks, pageText, pressKey, screenshot, typeInto } from '../../src/purchase/browse.ts';
import { connectBrowser } from '../../src/purchase/cdp.ts';
import type { BrowserHandle } from '../../src/purchase/cdp.ts';
import { checkId, loadAlerts, loadSamples, loadWatches, purchaseDir, saveAlerts, saveWatches, validateWatch } from '../../src/purchase/store.ts';
import { PurchaseError } from '../../src/purchase/types.ts';
import type { Alert, Watch } from '../../src/purchase/types.ts';

/** What the buy command may be given beyond a normal CLI context (tests inject these). */
export interface BuyContext extends CliContext {
  /** Overrides ~/.tripcode (the activity log and TripCode's own Chrome profile live there). */
  home?: string;
  connect?: () => Promise<BrowserHandle>;
  allowLocal?: boolean;
}

export const BUY_USAGE = `用法：tripcode buy <子指令>（預設輸出 JSON；加 --pretty 輸出易讀格式）

  watch add <tripId> --id x --title "…" --url https://… [--kind price|availability] [--every 360] [--target 120] [--drop 10]
                      [--currency EUR] [--regex "…(\\d+[.,]\\d+)"] [--opens ISO] [--until YYYY-MM-DD] [--item itemId]
                      [--render]   用 TripCode 的 Chrome 讀（價格由 JavaScript 產生的頁面）
  watch list <tripId> | watch pause|resume|rm <tripId> <watchId>
  scan <tripId>|--all [--force] [--loop] [--tick 30]     看一次到期的監控；--loop 常駐，每 --tick 分鐘看一次
  alerts <tripId>|--all [--ack]                           價格提醒；--ack 標成已讀
  browser open <url> | tabs | text | links | click "文字" | type "內容" [--into 欄位] | press Enter|Tab|… | shot <檔案.png>
                                                          操作 TripCode 自己的 Chrome：打開頁面、讀文字、點選（讀官方購票頁用）；可加 --tab N
`;

interface Args {
  pos: string[];
  flags: Record<string, string | true>;
}

const VALUE = new Set(['id', 'title', 'url', 'kind', 'every', 'target', 'drop', 'currency', 'regex', 'opens', 'until', 'item', 'tick', 'into', 'tab', 'max']);
const BOOL = new Set(['pretty', 'force', 'loop', 'all', 'ack', 'render', 'help']);

function parse(argv: string[]): Args {
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) {
      pos.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
    if (BOOL.has(name)) flags[name] = true;
    else if (VALUE.has(name)) {
      const v = eq === -1 ? argv[++i] : a.slice(eq + 1);
      if (v === undefined || v === '') throw new CliError(`--${name} 需要一個值`);
      flags[name] = v;
    } else throw new CliError(`未知的選項：--${name}\n\n${BUY_USAGE}`);
  }
  return { pos, flags };
}

const str = (a: Args, n: string) => (typeof a.flags[n] === 'string' ? (a.flags[n] as string) : undefined);
function num(a: Args, n: string): number | undefined {
  const s = str(a, n);
  if (s === undefined) return undefined;
  const v = Number(s);
  if (!Number.isFinite(v)) throw new CliError(`--${n} 必須是數字：${s}`);
  return v;
}

async function tripDir(ctx: CliContext, tripId: string | undefined): Promise<{ id: string; dir: string }> {
  if (!tripId) throw new CliError('請提供 tripId');
  if (!/^[a-z0-9-]+$/.test(tripId)) throw new CliError(`無效的 tripId：${tripId}`);
  try {
    await stat(path.join(ctx.root, 'trips', tripId));
  } catch {
    throw new CliError(`找不到旅程：trips/${tripId}`);
  }
  return { id: tripId, dir: purchaseDir(ctx.root, tripId) };
}

async function allTrips(ctx: CliContext): Promise<string[]> {
  try {
    const entries = await readdir(path.join(ctx.root, 'trips'), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

async function targets(ctx: CliContext, a: Args, at: number): Promise<{ id: string; dir: string }[]> {
  if (a.flags.all) {
    const out: { id: string; dir: string }[] = [];
    for (const id of await allTrips(ctx)) {
      if ((await loadWatches(purchaseDir(ctx.root, id))).length > 0) out.push({ id, dir: purchaseDir(ctx.root, id) });
    }
    return out;
  }
  return [await tripDir(ctx, a.pos[at])];
}

export async function buyCommand(ctx: BuyContext, argv: string[]): Promise<number> {
  try {
    return await run(ctx, argv);
  } catch (e) {
    if (e instanceof PurchaseError) throw new CliError(e.message);
    throw e;
  }
}

async function run(ctx: BuyContext, argv: string[]): Promise<number> {
  const a = parse(argv);
  const [cmd, sub] = a.pos;
  if (!cmd || a.flags.help) {
    ctx.stdout(BUY_USAGE);
    return cmd || a.flags.help ? 0 : 1;
  }
  const home = ctx.home ?? ctx.env.TRIPCODE_HOME?.trim() ?? path.join(os.homedir(), '.tripcode');

  switch (cmd) {
    case 'watch':
      return watchCommand(ctx, a, sub);
    case 'scan':
      return scanCommand(ctx, a);
    case 'alerts':
      return alertsCommand(ctx, a);
    case 'browser':
      return browserCommand(ctx, a, sub, home);
    default:
      throw new CliError(`未知的子指令：buy ${cmd}\n\n${BUY_USAGE}`);
  }
}

// ---------- watches ----------

async function watchCommand(ctx: BuyContext, a: Args, sub: string | undefined): Promise<number> {
  const { id: tripId, dir } = await tripDir(ctx, a.pos[2]);
  const watches = await loadWatches(dir);
  if (sub === 'list') {
    const samples = await loadSamples(dir);
    const rows = watches.map((w) => {
      const last = [...samples].reverse().find((s) => s.watchId === w.id);
      return { ...w, last };
    });
    if (a.flags.pretty) {
      if (rows.length === 0) ctx.stdout('還沒有監控\n');
      for (const r of rows) {
        const seen = r.last ? (r.last.ok ? (r.last.amount !== undefined ? `${r.last.currency ?? ''} ${r.last.amount}` : r.last.available ? '可購買' : '尚未開賣') : `讀取失敗：${r.last.error}`) : '還沒看過';
        ctx.stdout(`${r.id}  ${r.active ? '' : '（暫停）'}${r.title}  每 ${r.everyMinutes} 分鐘  最近：${seen}\n`);
      }
    } else printJson(ctx, rows);
    return 0;
  }
  if (sub === 'add') {
    const w: Partial<Watch> = {
      id: str(a, 'id'),
      title: str(a, 'title'),
      url: str(a, 'url'),
      kind: (str(a, 'kind') as Watch['kind'] | undefined) ?? 'price',
      everyMinutes: num(a, 'every'),
      targetPrice: num(a, 'target'),
      dropPercent: num(a, 'drop'),
      currency: str(a, 'currency'),
      regex: str(a, 'regex'),
      opensAt: str(a, 'opens'),
      until: str(a, 'until'),
      itemId: str(a, 'item'),
      render: a.flags.render === true ? true : undefined,
    };
    for (const k of Object.keys(w) as (keyof Watch)[]) if (w[k] === undefined) delete w[k];
    const watch = validateWatch(w, ctx.now(), { allowLocal: ctx.allowLocal });
    if (watches.some((x) => x.id === watch.id)) throw new CliError(`監控 ${watch.id} 已經存在`);
    await saveWatches(dir, [...watches, watch]);
    if (a.flags.pretty) ctx.stdout(`已加入監控 ${watch.id}，每 ${watch.everyMinutes} 分鐘看一次。\n`);
    else printJson(ctx, { ok: true, watch });
    return 0;
  }
  if (sub === 'pause' || sub === 'resume' || sub === 'rm') {
    const wid = checkId(a.pos[3], 'watchId');
    if (!watches.some((w) => w.id === wid)) throw new CliError(`找不到監控：${wid}`);
    await saveWatches(dir, sub === 'rm' ? watches.filter((w) => w.id !== wid) : watches.map((w) => (w.id === wid ? { ...w, active: sub === 'resume' } : w)));
    printJson(ctx, { ok: true, tripId, watch: wid, action: sub });
    return 0;
  }
  throw new CliError(`用法：buy watch add|list|pause|resume|rm …\n\n${BUY_USAGE}`);
}

function printAlerts(ctx: CliContext, tripId: string, alerts: Alert[]): void {
  for (const al of alerts) ctx.stdout(`[${tripId}] ${al.message}\n`);
}

async function scanCommand(ctx: BuyContext, a: Args): Promise<number> {
  const tick = num(a, 'tick') ?? 30;
  if (!(tick >= 5 && tick <= 1440)) throw new CliError('--tick 必須在 5 到 1440 分鐘之間');
  const once = async () => {
    const trips = await targets(ctx, a, 1);
    const report: { tripId: string; looked: number; alerts: Alert[] }[] = [];
    for (const t of trips) {
      const r = await scanWithActivity({ root: ctx.root, home: ctx.home ?? ctx.env.TRIPCODE_HOME?.trim() ?? path.join(os.homedir(), '.tripcode'), tripId: t.id, fetch: ctx.fetch, now: ctx.now, force: a.flags.force === true, env: ctx.env });
      report.push({ tripId: t.id, looked: r.results.length, alerts: r.alerts });
    }
    return report;
  };
  if (!a.flags.loop) {
    const report = await once();
    if (a.flags.pretty) {
      for (const r of report) {
        ctx.stdout(`${r.tripId}：看了 ${r.looked} 個監控，${r.alerts.length} 則新提醒\n`);
        printAlerts(ctx, r.tripId, r.alerts);
      }
    } else printJson(ctx, report);
    return 0;
  }
  ctx.stderr(`常駐掃描中，每 ${tick} 分鐘檢查一次到期的監控（Ctrl+C 結束）。\n`);
  let stop = false;
  process.once('SIGINT', () => (stop = true));
  while (!stop) {
    for (const r of await once()) printAlerts(ctx, r.tripId, r.alerts);
    for (let waited = 0; waited < tick * 60 && !stop; waited++) await new Promise((r) => setTimeout(r, 1000));
  }
  return 0;
}

async function alertsCommand(ctx: BuyContext, a: Args): Promise<number> {
  const trips = await targets(ctx, a, 1);
  const out: { tripId: string; alerts: Alert[] }[] = [];
  for (const t of trips) {
    const alerts = await loadAlerts(t.dir);
    out.push({ tripId: t.id, alerts: a.flags.ack ? alerts.map((x) => ({ ...x, seen: true })) : alerts });
    if (a.flags.ack) await saveAlerts(t.dir, alerts.map((x) => ({ ...x, seen: true })));
  }
  if (a.flags.pretty) {
    for (const o of out) for (const al of o.alerts.filter((x) => !x.seen || a.flags.ack)) ctx.stdout(`[${o.tripId}] ${al.seen ? '' : '● '}${al.message}\n`);
  } else printJson(ctx, out);
  return 0;
}

// ---------- browser ----------

async function browserCommand(ctx: BuyContext, a: Args, sub: string | undefined, home: string): Promise<number> {
  const tab = num(a, 'tab');
  // The office page shows these lines live. Short sentences only: a host, a button label; never typed text.
  const note = (text: string, level: 'info' | 'ok' | 'warn' | 'err' = 'info') => logActivity(home, { at: ctx.now().toISOString(), actor: 'browser', text, level });
  const browser = await (ctx.connect ?? (() => connectBrowser({ profileDir: path.join(home, 'chrome-profile'), env: ctx.env })))();
  try {
    const conn = browser.conn;
    switch (sub) {
      case 'open': {
        const url = a.pos[2];
        if (!url) throw new CliError('用法：buy browser open <網址>');
        const opened = await openUrl(conn, checkBrowseUrl(url));
        await note(`打開 ${hostOf(opened.url) || hostOf(url)}`);
        printJson(ctx, opened);
        return 0;
      }
      case 'tabs':
        printJson(ctx, await listTabs(conn));
        return 0;
      case 'text': {
        const r = await pageText(conn, { tab, max: num(a, 'max') });
        await note(`讀頁面 ${hostOf(r.url)}${r.title ? `：${r.title.slice(0, 40)}` : ''}`);
        ctx.stdout(`${r.title}\n${r.url}\n\n${r.text}\n`);
        return 0;
      }
      case 'links':
        printJson(ctx, await pageLinks(conn, { tab, max: num(a, 'max') }));
        return 0;
      case 'click': {
        if (!a.pos[2]) throw new CliError('用法：buy browser click "按鈕或連結上的文字"');
        const clicked = await clickText(conn, a.pos.slice(2).join(' '), { tab });
        await note(`點擊「${clicked.clicked.slice(0, 40)}」`);
        printJson(ctx, clicked);
        return 0;
      }
      case 'type': {
        if (!a.pos[2]) throw new CliError('用法：buy browser type "內容" [--into 欄位名稱]');
        const typed = await typeInto(conn, a.pos.slice(2).join(' '), { into: str(a, 'into'), tab });
        await note(`在「${(str(a, 'into') ?? '目前欄位').slice(0, 30)}」輸入 ${typed.typed} 個字`);
        printJson(ctx, typed);
        return 0;
      }
      case 'press': {
        if (!a.pos[2]) throw new CliError('用法：buy browser press Enter|Tab|Escape|Down|Up|Backspace');
        await pressKey(conn, a.pos[2], { tab });
        await note(`按下 ${a.pos[2]}`);
        printJson(ctx, { ok: true });
        return 0;
      }
      case 'shot': {
        const file = a.pos[2];
        if (!file) throw new CliError('用法：buy browser shot <檔案.png>');
        await writeFile(path.resolve(ctx.root, file), await screenshot(conn, { tab }));
        await note('截了一張畫面');
        printJson(ctx, { ok: true, file });
        return 0;
      }
      default:
        throw new CliError(`用法：buy browser open|tabs|text|links|click|type|press|shot\n\n${BUY_USAGE}`);
    }
  } finally {
    browser.conn.close();
  }
}
