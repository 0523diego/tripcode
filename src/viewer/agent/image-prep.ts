// Getting a picture ready to send: big photos and retina screenshots are scaled down in the browser first, so a
// message stays small and fast and Claude does not receive more pixels than it can use. fitWithin is the pure part.

/** Longest edge we send; Claude downsizes anything bigger itself, so more pixels are only more bytes. */
export const MAX_EDGE = 1600;
/** A file already this small and within MAX_EDGE goes up untouched. */
export const KEEP_AS_IS_BYTES = 1.5 * 1024 * 1024;

export function fitWithin(width: number, height: number, max = MAX_EDGE): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (!(longest > max)) return { width, height };
  const scale = max / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** The bytes to upload: the file itself when it is small, otherwise a scaled PNG/JPEG. Rejects with a readable message. */
export async function prepareImage(file: Blob): Promise<Blob> {
  if (!file.type.startsWith('image/')) throw new Error('這不是圖片');
  // An animated GIF would lose its frames on a canvas; it goes up as is if it fits.
  if (file.type === 'image/gif') return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('瀏覽器讀不了這張圖片');
  }
  try {
    const small = file.size <= KEEP_AS_IS_BYTES && Math.max(bitmap.width, bitmap.height) <= MAX_EDGE;
    if (small && (file.type === 'image/png' || file.type === 'image/jpeg' || file.type === 'image/webp')) return file;
    const { width, height } = fitWithin(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('無法處理這張圖片');
    ctx.drawImage(bitmap, 0, 0, width, height);
    // Screenshots with text stay sharp as PNG; photos (or a PNG that is still big) go to JPEG.
    const png = file.type === 'image/png' ? await toBlob(canvas, 'image/png') : null;
    if (png && png.size <= 2 * 1024 * 1024) return png;
    const jpeg = await toBlob(canvas, 'image/jpeg', 0.86);
    if (!jpeg) throw new Error('無法處理這張圖片');
    return jpeg;
  } finally {
    bitmap.close();
  }
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('讀取圖片失敗'));
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.readAsDataURL(blob);
  });
}
