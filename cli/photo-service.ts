// Photos on an itinerary item (Photo in src/core/types.ts): what both the dev server (`photo-add`, `photo-fetch`, `photo-remove`)
// and `tripcode photo …` do, so the two paths make the same checks and the same file names.
//
// The bytes decide everything: the type comes from the magic bytes (JPEG, PNG or WebP; never the file name or the browser's
// MIME), the name from a hash of the bytes (`photos/<item>-<10 hex>.jpg`), so the same picture on the same item is stored once
// and nothing the user typed ever reaches the file system. Files live in trips/<id>/photos/ (gitignored).
// A web picture only comes through cli/safe-fetch.ts (public https, size and time caps), and the page it came from is kept.
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sniffImage } from '../src/agent/attachments.ts';
import { isPhotoFile, parsePhoto } from '../src/core/photos.ts';
import type { Photo } from '../src/core/types.ts';
import { photoCandidates } from './food-photo.ts';
import { fetchPublicHttps, SafeFetchError } from './safe-fetch.ts';
import type { PublicResponse, SafeFetchDeps } from './safe-fetch.ts';

export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
/** A web picture smaller than this is a logo or an icon, not a photo of the place. */
export const MIN_WEB_PHOTO_BYTES = 15_000;
const MAX_PAGE_BYTES = 1_500_000;

export type PhotoExt = 'jpg' | 'png' | 'webp';

/** A plain Traditional Chinese reason the photo cannot be stored (the server turns it into a 400, the CLI into an error). */
export class PhotoError extends Error {}

/** JPEG, PNG or WebP by the magic bytes; anything else (GIF, HEIC, HTML, SVG) is null. */
export function detectPhoto(bytes: Uint8Array): PhotoExt | null {
  const kind = sniffImage(bytes);
  return kind && kind.ext !== 'gif' ? kind.ext : null;
}

/** An iPhone HEIC / HEIF picture (ISO-BMFF `ftyp` box with a HEIF brand). */
export function isHeic(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  return ascii(4, 8) === 'ftyp' && ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(ascii(8, 12));
}

/** The type of an acceptable photo, or throws why not. `web` pictures must also be big enough to be a photo. */
export function checkPhotoBytes(bytes: Uint8Array, opts: { web?: boolean } = {}): PhotoExt {
  if (bytes.length === 0) throw new PhotoError('照片是空的');
  if (bytes.length > MAX_PHOTO_BYTES) throw new PhotoError(`照片太大（上限 ${MAX_PHOTO_BYTES / 1024 / 1024} MB）`);
  if (isHeic(bytes)) throw new PhotoError('這是 iPhone 的 HEIC 照片，請先轉成 JPEG 再加（iPhone：設定 › 相機 › 格式選「最相容」；Mac：用「預覽程式」打開後「輸出」成 JPEG）');
  const ext = detectPhoto(bytes);
  if (!ext) throw new PhotoError('不是 JPEG、PNG 或 WebP 照片');
  if (opts.web && bytes.length < MIN_WEB_PHOTO_BYTES) throw new PhotoError('這張圖太小（多半是標誌或圖示），不是地點的照片');
  return ext;
}

/** "photos/<item slug>-<10 hex of sha256>.<ext>": always matches PHOTO_FILE_RE. */
export function photoFileName(itemId: string, bytes: Uint8Array, ext: PhotoExt): string {
  const slug =
    itemId
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'photo';
  return `photos/${slug}-${createHash('sha256').update(bytes).digest('hex').slice(0, 10)}.${ext}`;
}

/** The pure edits this needs (src/core/source-edit.ts; the dev server passes its injected copy). */
export interface PhotoEdits {
  addPhoto(src: string, itemId: string, photo: Photo): string;
  removePhoto(src: string, itemId: string, file: string): string;
  findObjectById(src: string, id: string): { start: number; end: number } | null;
}

export interface PhotoDeps {
  /** Repo root: trips live in <root>/trips. */
  root: string;
  edits: PhotoEdits;
}

const TRIP_ID_RE = /^[a-z0-9-]+$/;
const FILE_RE = /^[a-z0-9-]+\.ts$/;

async function tripPaths(root: string, tripId: string, file: string): Promise<{ dir: string; target: string }> {
  if (!TRIP_ID_RE.test(tripId)) throw new PhotoError(`無效的 tripId：${tripId}`);
  if (!FILE_RE.test(file)) throw new PhotoError(`無效的檔名：${file}`);
  const dir = path.join(path.resolve(root, 'trips'), tripId);
  if (!(await stat(dir).then((s) => s.isDirectory(), () => false))) throw new PhotoError('找不到這個旅程');
  return { dir, target: path.join(dir, file) };
}

/** Same pattern as the dev server's atomicWrite: a half-written trip.ts is never seen by the viewer. */
async function atomicWrite(file: string, content: string | Uint8Array): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await writeFile(tmp, content);
  await rename(tmp, file);
}

const quoted = (s: string) => [`'${s}'`, `"${s}"`];

/** True when any plan file of the trip (trip.ts, variant-*.ts) still names `photoFile`. */
async function referenced(dir: string, photoFile: string, override: { file: string; src: string }): Promise<boolean> {
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => FILE_RE.test(n));
  for (const name of names) {
    const src = name === override.file ? override.src : await readFile(path.join(dir, name), 'utf8').catch(() => '');
    if (quoted(photoFile).some((q) => src.includes(q))) return true;
  }
  return false;
}

export interface AddedPhoto {
  photo: Photo;
  /** False when this exact picture was already on the item (nothing changed). */
  added: boolean;
  bytes: number;
}

/**
 * Stores `bytes` as a photo of `itemId` and adds it to the plan file. Everything is checked before anything is written; when the
 * plan edit fails, a file this call created is removed again.
 */
export async function addPhotoBytes(
  deps: PhotoDeps,
  args: { tripId: string; file?: string; itemId: string; bytes: Uint8Array; caption?: string; source?: { url: string; label: string }; web?: boolean },
): Promise<AddedPhoto> {
  const file = args.file ?? 'trip.ts';
  const { dir, target } = await tripPaths(deps.root, args.tripId, file);
  const src = await readFile(target, 'utf8').catch(() => {
    throw new PhotoError(`找不到 ${file}`);
  });
  if (!deps.edits.findObjectById(src, args.itemId)) throw new PhotoError(`找不到 id 為「${args.itemId}」的項目`);
  const ext = checkPhotoBytes(args.bytes, { web: args.web });
  let photo: Photo;
  try {
    photo = parsePhoto({ file: photoFileName(args.itemId, args.bytes, ext), ...(args.caption !== undefined ? { caption: args.caption } : {}), ...(args.source ? { source: args.source } : {}) });
  } catch (e) {
    throw new PhotoError(e instanceof Error ? e.message : String(e));
  }
  const abs = path.join(dir, photo.file);
  const onDisk = await stat(abs).then((s) => s.isFile(), () => false);
  let next: string;
  try {
    next = deps.edits.addPhoto(src, args.itemId, photo);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (!/已在這個項目/.test(message)) throw new PhotoError(message);
    // The same bytes are already on this item: keep one copy (and put the file back if it went missing).
    if (!onDisk) {
      await mkdir(path.dirname(abs), { recursive: true });
      await atomicWrite(abs, args.bytes);
    }
    return { photo, added: false, bytes: args.bytes.length };
  }
  if (!onDisk) {
    await mkdir(path.dirname(abs), { recursive: true });
    await atomicWrite(abs, args.bytes);
  }
  try {
    await atomicWrite(target, next);
  } catch (e) {
    if (!onDisk) await unlink(abs).catch(() => undefined);
    throw e;
  }
  return { photo, added: true, bytes: args.bytes.length };
}

/** Takes the photo off the item, and deletes the file when no plan file of the trip names it any more. */
export async function removePhotoEntry(deps: PhotoDeps, args: { tripId: string; file?: string; itemId: string; photoFile: string }): Promise<{ deleted: boolean }> {
  if (!isPhotoFile(args.photoFile)) throw new PhotoError(`無效的照片檔名：${args.photoFile}`);
  const file = args.file ?? 'trip.ts';
  const { dir, target } = await tripPaths(deps.root, args.tripId, file);
  const src = await readFile(target, 'utf8').catch(() => {
    throw new PhotoError(`找不到 ${file}`);
  });
  let next: string;
  try {
    next = deps.edits.removePhoto(src, args.itemId, args.photoFile);
  } catch (e) {
    throw new PhotoError(e instanceof Error ? e.message : String(e));
  }
  await atomicWrite(target, next);
  if (await referenced(dir, args.photoFile, { file, src: next })) return { deleted: false };
  try {
    await unlink(path.join(dir, args.photoFile));
    return { deleted: true };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    return { deleted: false };
  }
}

export interface WebPhotoDeps extends SafeFetchDeps {
  userAgent: string;
}

export interface WebPhoto {
  bytes: Uint8Array;
  ext: PhotoExt;
  /** The picture's own address (after redirects). */
  imageUrl: string;
  /** What the photo's `source.url` records: the page when one was given, else the picture. */
  sourceUrl: string;
}

const httpsOnly = (raw: string, label: string): string => {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new PhotoError(`${label} 不是有效的網址`);
  }
  if (u.protocol !== 'https:') throw new PhotoError(`${label} 必須是 https 網址`);
  return u.toString();
};

/**
 * A picture from the web. With `imageUrl`: exactly that picture, which must be a real JPEG/PNG/WebP photo (≥ 15 KB, ≤ 8 MB).
 * With only `pageUrl`: the page's share picture, tried like the food cards do (og:image, structured data, big <img>), JPEG/WebP
 * before PNG. Throws PhotoError with a plain reason.
 */
export async function fetchWebPhoto(deps: WebPhotoDeps, args: { imageUrl?: string; pageUrl?: string }): Promise<WebPhoto> {
  const pageUrl = args.pageUrl ? httpsOnly(args.pageUrl, 'pageUrl') : undefined;
  const imageUrl = args.imageUrl ? httpsOnly(args.imageUrl, 'imageUrl') : undefined;
  if (!pageUrl && !imageUrl) throw new PhotoError('請給 imageUrl（照片網址）或 pageUrl（照片所在的官方網頁）');
  const get = (url: string, maxBytes: number, accept: string): Promise<PublicResponse> => fetchPublicHttps(url, { maxBytes, accept, userAgent: deps.userAgent }, deps);
  const asPhoto = async (url: string): Promise<{ img: PublicResponse; ext: PhotoExt }> => {
    const img = await get(url, MAX_PHOTO_BYTES, 'image/webp,image/png,image/jpeg');
    return { img, ext: checkPhotoBytes(img.bytes, { web: true }) };
  };
  try {
    if (imageUrl) {
      const { img, ext } = await asPhoto(imageUrl);
      return { bytes: img.bytes, ext, imageUrl: img.url, sourceUrl: pageUrl ?? imageUrl };
    }
    const page = await get(pageUrl!, MAX_PAGE_BYTES, 'text/html,application/xhtml+xml');
    const candidates = photoCandidates(new TextDecoder().decode(page.bytes), page.url);
    if (candidates.length === 0) throw new PhotoError('這個網頁上找不到可用的照片：請改用 imageUrl 指定照片網址');
    let lastError = '這個網頁上找不到可用的照片';
    let fallback: { img: PublicResponse; ext: PhotoExt } | undefined;
    for (const url of candidates) {
      try {
        const got = await asPhoto(url);
        // Logos and graphics are mostly PNG: a PNG is kept only when no JPEG / WebP photo turns up.
        if (got.ext === 'png') {
          fallback ??= got;
          continue;
        }
        return { bytes: got.img.bytes, ext: got.ext, imageUrl: got.img.url, sourceUrl: pageUrl! };
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
      }
    }
    if (fallback) return { bytes: fallback.img.bytes, ext: fallback.ext, imageUrl: fallback.img.url, sourceUrl: pageUrl! };
    throw new PhotoError(lastError);
  } catch (e) {
    if (e instanceof SafeFetchError) throw new PhotoError(`抓不到照片：${e.message}`);
    throw e;
  }
}
