// A photo for a place on the food list: the picture its own page offers for sharing (the og:image a link preview shows),
// saved next to the trip so the printed or on-screen card has something to look at. The picture belongs to the place; the card
// says where it came from and links to that page. Nothing else on the page is kept.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sniffImage } from '../src/agent/attachments.ts';
import { fetchPublicHttps, SafeFetchError } from './safe-fetch.ts';
import type { PublicResponse, SafeFetchDeps } from './safe-fetch.ts';

const MAX_PAGE_BYTES = 1_500_000;
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;
/** Below this a picture is an icon or a logo, not a photo of the place. */
const MIN_PHOTO_BYTES = 15_000;
const PHOTO_EXTS = new Set(['png', 'jpg', 'webp']);

const decodeEntities = (s: string): string => s.replace(/&amp;/g, '&').replace(/&#38;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

const SKIP_IMAGE = /logo|icon|sprite|pixel|avatar|flag|badge|payment|paiement|tripadvisor|facebook|instagram|twitter|loader|blank|placeholder|spacer|favicon|gift|qr|banner-cookie|\.svg|\.gif|\.ico/i;
const MAX_CANDIDATES = 6;

function resolveHttps(raw: string | undefined, baseUrl: string): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(decodeEntities(raw.trim()), baseUrl);
    return url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** The largest address of a srcset ("a.jpg 400w, b.jpg 1200w" → b.jpg). */
function biggestOfSrcset(srcset: string): string | undefined {
  let best: { url: string; w: number } | undefined;
  for (const part of srcset.split(',')) {
    const [url, size] = part.trim().split(/\s+/);
    const w = size ? parseFloat(size) : 0;
    if (url && (!best || w > best.w)) best = { url, w };
  }
  return best?.url;
}

/**
 * Picture addresses a page offers, best first: the picture it names for sharing (og:image and friends), the image of its
 * structured data (JSON-LD), then the pictures in the page itself that are not logos, icons or social badges. The caller tries
 * them in order until one is a real photo.
 */
export function photoCandidates(html: string, baseUrl: string): string[] {
  const head = html.slice(0, 600_000);
  const out: string[] = [];
  const add = (raw: string | undefined) => {
    const url = resolveHttps(raw, baseUrl);
    if (url && !out.includes(url)) out.push(url);
  };
  const found = new Map<string, string>();
  for (const tag of head.match(/<(?:meta|link)\b[^>]*>/gi) ?? []) {
    const key = /\b(?:property|name|rel)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    const value = /\b(?:content|href)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (key && value && !found.has(key)) found.set(key, value);
  }
  for (const key of ['og:image:secure_url', 'og:image', 'twitter:image', 'twitter:image:src', 'image_src']) add(found.get(key));
  for (const block of head.match(/<script[^>]+application\/ld\+json[^>]*>[\s\S]*?<\/script>/gi) ?? []) {
    const json = block.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '');
    for (const m of json.matchAll(/"image"\s*:\s*(\[[^\]]*\]|\{[^}]*\}|"[^"]+")/g)) {
      for (const u of m[1]!.matchAll(/"(?:url|contentUrl)"\s*:\s*"([^"]+)"|"(https?:[^"]+|\/[^"]+)"/g)) add((u[1] ?? u[2])?.replace(/\\\//g, '/'));
    }
  }
  for (const tag of head.match(/<img\b[^>]*>/gi) ?? []) {
    if (out.length >= MAX_CANDIDATES) break;
    const attr = (name: string) => new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i').exec(tag)?.[1];
    const src = attr('data-src') ?? attr('data-lazy-src') ?? attr('data-original') ?? (attr('srcset') ? biggestOfSrcset(attr('srcset')!) : undefined) ?? (attr('data-srcset') ? biggestOfSrcset(attr('data-srcset')!) : undefined) ?? attr('src');
    if (!src || src.startsWith('data:') || SKIP_IMAGE.test(src) || SKIP_IMAGE.test(attr('alt') ?? '') || SKIP_IMAGE.test(attr('class') ?? '')) continue;
    const w = Number(attr('width'));
    const h = Number(attr('height'));
    if ((w && w < 300) || (h && h < 200)) continue;
    add(src);
  }
  // Last: a cover picture set as a CSS background (some sites show their photo only that way).
  for (const m of head.matchAll(/url\(\s*["']?([^"')\s]+\.(?:jpe?g|webp))(?:\?[^"')\s]*)?["']?\s*\)/gi)) {
    if (out.length >= MAX_CANDIDATES) break;
    if (!SKIP_IMAGE.test(m[1]!)) add(m[1]);
  }
  return out.slice(0, MAX_CANDIDATES);
}

/** The picture address a page offers for sharing (the first candidate). */
export function pickShareImage(html: string, baseUrl: string): string | undefined {
  return photoCandidates(html, baseUrl)[0];
}

export interface PhotoResult {
  /** Relative to the trip folder: "attachments/food-<hash>.jpg". */
  file: string;
  pageUrl: string;
  imageUrl: string;
  bytes: number;
}

export interface PhotoDeps extends SafeFetchDeps {
  root: string;
  userAgent: string;
}

/**
 * Finds the share picture of `pageUrl` (or uses `imageUrl` when the AI already has a picture address), checks that the bytes
 * really are a PNG/JPEG/WebP, and saves them under trips/<id>/attachments/. Throws a plain message when it cannot.
 */
export async function fetchPlacePhoto(deps: PhotoDeps, tripId: string, args: { pageUrl: string; imageUrl?: string }): Promise<PhotoResult> {
  const get = (url: string, maxBytes: number, accept: string): Promise<PublicResponse> => fetchPublicHttps(url, { maxBytes, accept, userAgent: deps.userAgent }, deps);
  let pageUrl = args.pageUrl;
  let candidates: string[];
  if (args.imageUrl) candidates = [args.imageUrl];
  else {
    const page = await get(args.pageUrl, MAX_PAGE_BYTES, 'text/html,application/xhtml+xml');
    pageUrl = page.url;
    candidates = photoCandidates(new TextDecoder().decode(page.bytes), page.url);
    if (candidates.length === 0) throw new SafeFetchError('這個網頁上找不到可用的照片');
  }
  // A photo (JPEG or WebP) wins over a PNG: logos and graphics are mostly PNG. A PNG is kept only when nothing better turns up.
  // Tiny pictures are icons or logos, and a page's picture may be gone; each is skipped.
  let lastError = '這個網頁上找不到可用的照片';
  let fallback: PublicResponse | undefined;
  const save = async (img: PublicResponse, ext: string): Promise<PhotoResult> => {
    const name = `food-${createHash('sha256').update(img.bytes).digest('hex').slice(0, 10)}.${ext}`;
    const dir = path.join(deps.root, 'trips', tripId, 'attachments');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, name), img.bytes);
    return { file: `attachments/${name}`, pageUrl, imageUrl: img.url, bytes: img.bytes.length };
  };
  for (const imageUrl of candidates) {
    try {
      const img = await get(imageUrl, MAX_PHOTO_BYTES, 'image/avif,image/webp,image/png,image/jpeg');
      const kind = sniffImage(img.bytes);
      if (!kind || !PHOTO_EXTS.has(kind.ext)) {
        lastError = '抓到的不是 PNG、JPEG 或 WebP 圖片';
        continue;
      }
      if (img.bytes.length < MIN_PHOTO_BYTES && !args.imageUrl) {
        lastError = '網頁上的圖片都太小（多半是標誌或圖示）';
        continue;
      }
      if (kind.ext === 'png' && !args.imageUrl) {
        fallback ??= img;
        continue;
      }
      return await save(img, kind.ext);
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  if (fallback) return save(fallback, 'png');
  throw new SafeFetchError(lastError);
}
