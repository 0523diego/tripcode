// Pictures in the agent panel, both ways.
//   Up:   the user pastes / drops / picks an image; the panel downsizes it and POSTs it to /__agent/uploads, which
//         stores it as a file and answers with its repo-relative path. A message then carries those paths and the
//         agent looks at the files with its Read tool, the same way Claude Code does with a path you give it.
//   Down: the agent may write an image (usually an SVG chart or diagram) under trips/<id>/ and show it with
//         `![說明](trips/<id>/attachments/x.svg)`; /__agent/files serves it back to the panel.
// Everything here treats the path as untrusted: only two directory shapes, only image extensions, no symlink escapes.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
export const MAX_IMAGES_PER_MESSAGE = 4;
/** Files the panel will display (an agent-made chart can be bigger than an upload, but not unbounded). */
const MAX_SERVED_BYTES = 12 * 1024 * 1024;

/** Where uploads go when the conversation has no trip folder yet (home page, a brand-new idea). */
export const GLOBAL_ATTACHMENTS = 'node_modules/.tripcode/attachments';

export interface ImageKind {
  ext: 'png' | 'jpg' | 'gif' | 'webp';
  mime: string;
}

/** What the bytes really are; the browser's claimed type and the file name are ignored. */
export function sniffImage(bytes: Uint8Array): ImageKind | null {
  const at = (i: number) => bytes[i] ?? -1;
  const ascii = (from: number, text: string) => [...text].every((c, n) => at(from + n) === c.charCodeAt(0));
  if (bytes.length >= 8 && at(0) === 0x89 && ascii(1, 'PNG') && at(4) === 0x0d && at(5) === 0x0a && at(6) === 0x1a && at(7) === 0x0a) return { ext: 'png', mime: 'image/png' };
  if (bytes.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (bytes.length >= 6 && (ascii(0, 'GIF87a') || ascii(0, 'GIF89a'))) return { ext: 'gif', mime: 'image/gif' };
  if (bytes.length >= 12 && ascii(0, 'RIFF') && ascii(8, 'WEBP')) return { ext: 'webp', mime: 'image/webp' };
  return null;
}

const UPLOAD_NAME_RE = /^img-[a-z0-9]+-[a-f0-9]{8}\.(?:png|jpg|gif|webp)$/;
const UPLOAD_REF_RE = /^(?:trips\/[a-z0-9-]+\/attachments|node_modules\/\.tripcode\/attachments)\/(img-[a-z0-9]+-[a-f0-9]{8}\.(?:png|jpg|gif|webp))$/;

/** Saves an uploaded image and returns its repo-relative path. Throws a Traditional Chinese message when it is not acceptable. */
export function saveUpload(root: string, tripId: string | null, bytes: Uint8Array): string {
  if (bytes.length === 0) throw new Error('圖片是空的');
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`圖片太大（上限 ${MAX_IMAGE_BYTES / 1024 / 1024} MB）`);
  const kind = sniffImage(bytes);
  if (!kind) throw new Error('不支援這種檔案：請用 PNG、JPEG、GIF 或 WebP 圖片');
  const dir = tripId && fs.existsSync(path.join(root, 'trips', tripId)) ? `trips/${tripId}/attachments` : GLOBAL_ATTACHMENTS;
  const name = `img-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}.${kind.ext}`;
  fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, dir, name), bytes, { flag: 'wx' });
  return `${dir}/${name}`;
}

/** True for a path that an upload could have produced and that still exists. */
export function isUploadRef(root: string, ref: unknown): ref is string {
  if (typeof ref !== 'string' || ref.length > 200 || !UPLOAD_REF_RE.test(ref)) return false;
  try {
    return fs.statSync(path.join(root, ref)).isFile();
  } catch {
    return false;
  }
}

const SERVED_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
};

export interface ServedImage {
  file: string;
  mime: string;
}

/**
 * The file behind a displayable image path, or null. Allowed: any image under trips/<id>/ (uploads, covers, charts the
 * agent drew) and the global upload folder. Never: dot-directories, `..`, other roots, symlinks that leave the folder.
 */
export function servedImage(root: string, ref: unknown): ServedImage | null {
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > 300 || /[\0\\]/.test(ref)) return null;
  const parts = ref.split('/');
  let base: string;
  if (ref.startsWith(`${GLOBAL_ATTACHMENTS}/`)) {
    if (parts.length !== 4 || !UPLOAD_NAME_RE.test(parts[3] ?? '')) return null;
    base = path.join(root, GLOBAL_ATTACHMENTS);
  } else if (parts[0] === 'trips' && parts.length >= 3 && /^[a-z0-9-]+$/.test(parts[1] ?? '')) {
    if (parts.slice(2).some((p) => p === '' || p.startsWith('.'))) return null;
    base = path.join(root, 'trips', parts[1] as string);
  } else {
    return null;
  }
  const mime = SERVED_EXT[path.extname(ref).toLowerCase()];
  if (!mime) return null;
  const file = path.join(root, ...parts);
  try {
    const real = fs.realpathSync(file);
    const realBase = fs.realpathSync(base);
    const rel = path.relative(realBase, real);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    const stat = fs.statSync(real);
    if (!stat.isFile() || stat.size > MAX_SERVED_BYTES) return null;
    return { file: real, mime };
  } catch {
    return null;
  }
}
