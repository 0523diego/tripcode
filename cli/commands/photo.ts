// `tripcode photo …`: pictures on an itinerary item (Photo in src/core/types.ts, files in trips/<id>/photos/, gitignored).
// The same checks and names as the viewer's 「＋ 加照片」 (cli/photo-service.ts). From the web, only through the public-https guard
// (cli/safe-fetch.ts), and always with the page the picture came from.
import path from 'node:path';
import { CliError, checkFileName, checkTripId, printJson } from '../context.ts';
import type { CliContext } from '../context.ts';
import { userAgentFor } from '../osm.ts';
import { addPhotoBytes, fetchWebPhoto, PhotoError, removePhotoEntry } from '../photo-service.ts';
import type { SafeFetchDeps } from '../safe-fetch.ts';
import * as edits from '../../src/core/source-edit.ts';

export const PHOTO_USAGE = `用法：tripcode photo <子指令>（預設輸出 JSON；加 --pretty 輸出易讀格式）

  add <tripId> <itemId> (--image https://照片網址 | --page https://官方網頁) --label "來源名稱" [--caption "拍的是什麼"] [--file variant-b.ts]
        把網路上的一張照片存到 trips/<id>/photos/，掛在這個項目上，並記下來源網頁。--page 會用該網頁的分享圖片；
        --image 要是真的照片（JPEG／PNG／WebP，至少 15 KB，最多 8 MB）。兩個都給時，來源記 --page。只連到公開的 https 網站
  remove <tripId> <itemId> <photos/檔名> [--file variant-b.ts]
        從項目拿掉這張照片；沒有其他行程檔用到時，檔案也一起刪除
  list <tripId> [--item <itemId>] [--file variant-b.ts]
        列出有照片的項目
`;

const VALUE = new Set(['image', 'page', 'label', 'caption', 'item', 'file']);
const BOOL = new Set(['pretty', 'help']);

function parse(argv: string[]): { pos: string[]; flags: Record<string, string | true> } {
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
    } else throw new CliError(`未知的選項：--${name}`);
  }
  return { pos, flags };
}

/** Tests put a fake public-web fetch on the context as `photoFetch`; otherwise the real network, through the guard. */
const safeDeps = (ctx: CliContext): SafeFetchDeps => (ctx as { photoFetch?: SafeFetchDeps }).photoFetch ?? {};

export async function photoCommand(ctx: CliContext, argv: string[]): Promise<number> {
  const a = parse(argv);
  const flag = (name: string) => (typeof a.flags[name] === 'string' ? (a.flags[name] as string) : undefined);
  const [cmd] = a.pos;
  if (!cmd || a.flags.help) {
    ctx.stdout(PHOTO_USAGE);
    return cmd || a.flags.help ? 0 : 1;
  }
  const file = checkFileName(flag('file'));
  const deps = { root: ctx.root, edits };
  try {
    switch (cmd) {
      case 'add': {
        const tripId = checkTripId(a.pos[1]);
        const itemId = a.pos[2];
        const label = flag('label');
        const image = flag('image');
        const page = flag('page');
        if (!itemId || !label || (!image && !page)) throw new CliError('用法：photo add <tripId> <itemId> (--image <https 照片網址> | --page <https 網頁>) --label "來源名稱" [--caption "…"]');
        if (/[\u0000-\u001f\u007f]/.test(label) || label.length > 120) throw new CliError('--label 只能有一行，最多 120 字');
        const web = await fetchWebPhoto({ userAgent: userAgentFor(ctx.root), ...safeDeps(ctx) }, { ...(image ? { imageUrl: image } : {}), ...(page ? { pageUrl: page } : {}) });
        const caption = flag('caption');
        const r = await addPhotoBytes(deps, { tripId, file, itemId, bytes: web.bytes, web: true, source: { url: web.sourceUrl, label: label.trim() }, ...(caption ? { caption: caption.trim() } : {}) });
        if (a.flags.pretty) ctx.stdout(`${r.added ? '已加入' : '這張照片已經在這個項目上'}：trips/${tripId}/${r.photo.file}（${Math.round(r.bytes / 1024)} KB，來源 ${web.sourceUrl}）\n`);
        else printJson(ctx, { tripId, file, itemId, ...r, imageUrl: web.imageUrl });
        return 0;
      }
      case 'remove': {
        const tripId = checkTripId(a.pos[1]);
        const [, , itemId, photoFile] = a.pos;
        if (!itemId || !photoFile) throw new CliError('用法：photo remove <tripId> <itemId> <photos/檔名>');
        const r = await removePhotoEntry(deps, { tripId, file, itemId, photoFile });
        if (a.flags.pretty) ctx.stdout(`已從「${itemId}」拿掉 ${photoFile}${r.deleted ? '，檔案已刪除' : '（其他行程檔還用到，檔案保留）'}\n`);
        else printJson(ctx, { tripId, file, itemId, photoFile, ...r });
        return 0;
      }
      case 'list': {
        const tripId = checkTripId(a.pos[1]);
        const only = flag('item');
        let trip;
        try {
          trip = await ctx.loadTrip(path.join(ctx.root, 'trips', tripId, file));
        } catch {
          throw new CliError(`讀不到 trips/${tripId}/${file}`);
        }
        const items = trip.days.flatMap((d) =>
          d.items.filter((it) => (only ? it.id === only : (it.photos ?? []).length > 0)).map((it) => ({ itemId: it.id, title: it.title, date: d.date, photos: it.photos ?? [] })),
        );
        if (only && items.length === 0) throw new CliError(`找不到 id 為「${only}」的項目`);
        if (a.flags.pretty) {
          const lines = items.length === 0 ? ['沒有項目有照片。'] : items.flatMap((i) => [`${i.date} ${i.title}（${i.itemId}）`, ...(i.photos.length ? i.photos.map((p) => `  ${p.file}${p.caption ? `  ${p.caption}` : ''}${p.source ? `  來源：${p.source.label} ${p.source.url}` : ''}`) : ['  （沒有照片）'])]);
          ctx.stdout(`${lines.join('\n')}\n`);
        } else printJson(ctx, { tripId, file, items });
        return 0;
      }
      default:
        throw new CliError(`未知的子指令：photo ${cmd}\n\n${PHOTO_USAGE}`);
    }
  } catch (e) {
    if (e instanceof PhotoError) throw new CliError(e.message);
    throw e;
  }
}
