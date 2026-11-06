// Sizing rules for cover photos, kept apart from the browser code so they can be tested in Node.

/** Longest side of a stored cover. A card shows it about 400 px wide, so this is generous on high-density screens. */
export const COVER_MAX_SIDE = 1200;
/** Stay under the server's limit (700 KB) with some room for base64 and the request envelope. */
export const COVER_MAX_BYTES = 600 * 1024;

/** Scales (w, h) down so the longer side is at most `max`; never scales up. */
export function fitWithin(w: number, h: number, max = COVER_MAX_SIDE): { width: number; height: number } {
  const k = Math.min(1, max / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}
