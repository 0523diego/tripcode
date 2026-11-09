// Turns a ticket file the browser cannot print as a picture (a PDF, an iPhone HEIC photo) into PNG pages, so the printed
// itinerary can carry the ticket itself, QR code and all. Nothing is decoded or re-drawn: the pages are what the file shows.
//
// Tools, no dependencies: `pdftoppm` (poppler) when it is installed, otherwise macOS's own `sips` (first page only).
// Files are the user's own (trips/<id>/tickets/), the path is checked by the caller, and no shell is involved.
import { execFile } from 'node:child_process';
import { access, constants, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const MAX_TICKET_PAGES = 4;
/** 150 dpi: a ticket's QR code is still ~5 pixels per module, and a page is about 400 KB. */
const DPI = 150;
const MAX_PAGE_BYTES = 6 * 1024 * 1024;
const TIMEOUT_MS = 40_000;

export interface TicketPages {
  pages: { mime: 'image/png'; dataBase64: string }[];
  /** The file has more pages than were rendered (only the first MAX_TICKET_PAGES are). */
  more: boolean;
  /** Only the first page could be rendered (the machine has no PDF tool beyond sips). */
  firstPageOnly: boolean;
}

export type Run = (cmd: string, args: string[]) => Promise<void>;

const defaultRun: Run = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: TIMEOUT_MS, windowsHide: true }, (err) => (err ? reject(err) : resolve()));
  });

/** The folders a launchd service or a minimal PATH leaves out (Homebrew on Apple silicon and on Intel). */
const EXTRA_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];

export async function findTool(name: string, env: Record<string, string | undefined> = process.env): Promise<string | undefined> {
  const dirs = [...(env.PATH ?? '').split(path.delimiter), ...EXTRA_DIRS].filter(Boolean);
  for (const dir of new Set(dirs)) {
    const candidate = path.join(dir, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* try the next folder */
    }
  }
  return undefined;
}

const cache = new Map<string, TicketPages>();
const CACHE_MAX = 6;

export interface RenderDeps {
  run?: Run;
  find?: (name: string) => Promise<string | undefined>;
}

export async function renderTicketPages(abs: string, ext: 'pdf' | 'heic', deps: RenderDeps = {}): Promise<TicketPages> {
  const info = await stat(abs).catch(() => null);
  if (!info?.isFile()) throw new Error('找不到這個票券檔');
  const key = `${abs}:${info.size}:${info.mtimeMs}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const run = deps.run ?? defaultRun;
  const find = deps.find ?? findTool;
  const dir = await mkdtemp(path.join(tmpdir(), 'tripcode-ticket-'));
  try {
    let firstPageOnly = false;
    let more = false;
    const pdftoppm = ext === 'pdf' ? await find('pdftoppm') : undefined;
    if (pdftoppm) {
      // One page more than we keep, only to learn whether the file has more.
      await run(pdftoppm, ['-png', '-r', String(DPI), '-f', '1', '-l', String(MAX_TICKET_PAGES + 1), abs, path.join(dir, 'p')]);
    } else {
      const sips = await find('sips');
      if (!sips) throw new Error(ext === 'pdf' ? '這台電腦沒有把 PDF 轉成圖片的工具（Mac 內建 sips；其他系統請安裝 poppler 的 pdftoppm）' : '這台電腦沒有轉換這種圖片的工具（Mac 內建 sips）');
      await run(sips, ['-s', 'format', 'png', abs, '--out', path.join(dir, 'p-1.png')]);
      firstPageOnly = ext === 'pdf';
    }
    const names = (await readdir(dir)).filter((n) => n.endsWith('.png')).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    if (names.length === 0) throw new Error('轉換後沒有得到任何頁面');
    if (names.length > MAX_TICKET_PAGES) more = true;
    const pages: TicketPages['pages'] = [];
    for (const name of names.slice(0, MAX_TICKET_PAGES)) {
      const bytes = await readFile(path.join(dir, name));
      if (bytes.length > MAX_PAGE_BYTES) throw new Error('轉出來的頁面太大');
      pages.push({ mime: 'image/png', dataBase64: bytes.toString('base64') });
    }
    const result: TicketPages = { pages, more, firstPageOnly };
    cache.set(key, result);
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
    return result;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function clearTicketRenderCache(): void {
  cache.clear();
}
