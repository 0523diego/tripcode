// Trip cover photos: the user picks any picture, the browser shrinks it to a small JPEG, and the dev server stores it as
// trips/<id>/cover.jpg (see the `cover` endpoint). Nothing leaves the machine.
import { post } from './api.ts';
import { COVER_MAX_BYTES, fitWithin } from './cover-fit.ts';

const blobToBase64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error('讀不到圖片'));
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.readAsDataURL(blob);
  });

/** Decodes the picture (honouring the camera's rotation), shrinks it and encodes a JPEG under the size limit. */
export async function shrinkToCover(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('這不是圖片檔');
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('瀏覽器讀不了這種圖片格式（例如 HEIC）。請先轉成 JPG 或 PNG 再選。');
  }
  const { width, height } = fitWithin(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('這個瀏覽器無法處理圖片');
  ctx.fillStyle = '#fff'; // PNGs with transparency would turn black in a JPEG
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  for (const q of [0.85, 0.75, 0.65, 0.55]) {
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', q));
    if (blob && blob.size <= COVER_MAX_BYTES) return blobToBase64(blob);
  }
  throw new Error('這張圖縮小後還是太大，請換一張');
}

export async function setCover(tripId: string, file: File): Promise<{ ok: boolean; error?: string }> {
  try {
    return await post('cover', { tripId, dataBase64: await shrinkToCover(file) });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export const removeCover = (tripId: string) => post('cover-remove', { tripId });
