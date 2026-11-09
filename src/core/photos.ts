// The rules a Photo (src/core/types.ts) must follow, in one place: the trip check reports a broken one, the source edit refuses
// to write one, and the dev server and the CLI check what they are about to store. Pure, no I/O (the viewer imports it too).
import type { Photo } from './types.ts';

/** "photos/<name>.jpg|png|webp": lowercase, no folders, no `..`. Names are generated (cli/photo-service.ts), never the user's. */
export const PHOTO_FILE_RE = /^photos\/[a-z0-9][a-z0-9._-]*\.(?:jpg|png|webp)$/;
export const MAX_PHOTO_CAPTION = 120;
export const MAX_PHOTO_LABEL = 120;
const MAX_URL = 2000;
const PHOTO_KEYS = ['file', 'caption', 'source'];

export function isPhotoFile(file: unknown): file is string {
  return typeof file === 'string' && file.length <= 200 && PHOTO_FILE_RE.test(file) && !file.includes('..');
}

/** One line of text: no newline, tab or other control character (it would break a string literal in trip.ts). */
function isSingleLine(s: string): boolean {
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u001f\u007f\u2028\u2029]/.test(s);
}

function isHttpsUrl(s: string): boolean {
  if (s.length > MAX_URL) return false;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' && !u.username && !u.password && u.hostname !== '';
  } catch {
    return false;
  }
}

/** What is wrong with `p` as a Photo, in Traditional Chinese, or undefined when it is fine. */
export function photoProblem(p: unknown): string | undefined {
  if (typeof p !== 'object' || p === null || Array.isArray(p)) return '照片必須是 { file, caption?, source? } 物件';
  const rec = p as Record<string, unknown>;
  const extra = Object.keys(rec).filter((k) => !PHOTO_KEYS.includes(k));
  if (extra.length > 0) return `照片有不認得的欄位：${extra.join('、')}（只能有 file、caption、source；不記評分）`;
  if (!isPhotoFile(rec.file)) return `照片檔名不合規則：${String(rec.file)}（要是 photos/小寫英數字.jpg、.png 或 .webp）`;
  if (rec.caption !== undefined) {
    if (typeof rec.caption !== 'string' || rec.caption.trim() === '') return '照片說明（caption）要是非空的文字';
    if (!isSingleLine(rec.caption)) return '照片說明（caption）只能有一行';
    if (rec.caption.length > MAX_PHOTO_CAPTION) return `照片說明（caption）最多 ${MAX_PHOTO_CAPTION} 字`;
  }
  if (rec.source !== undefined) {
    const s = rec.source;
    if (typeof s !== 'object' || s === null || Array.isArray(s)) return '照片來源（source）必須是 { url, label }';
    const src = s as Record<string, unknown>;
    const sExtra = Object.keys(src).filter((k) => k !== 'url' && k !== 'label');
    if (sExtra.length > 0) return `照片來源有不認得的欄位：${sExtra.join('、')}（只能有 url、label）`;
    if (typeof src.url !== 'string' || !isHttpsUrl(src.url)) return `照片來源網址要是 https：${String(src.url)}`;
    if (typeof src.label !== 'string' || src.label.trim() === '') return '照片來源要有名稱（source.label），例如「官方路線頁」';
    if (!isSingleLine(src.label)) return '照片來源名稱（source.label）只能有一行';
    if (src.label.length > MAX_PHOTO_LABEL) return `照片來源名稱（source.label）最多 ${MAX_PHOTO_LABEL} 字`;
  }
  return undefined;
}

/** `p` as a Photo, or throws the problem. */
export function parsePhoto(p: unknown): Photo {
  const problem = photoProblem(p);
  if (problem) throw new Error(problem);
  return p as Photo;
}
