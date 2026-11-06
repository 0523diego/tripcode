// Validation for the itinerary's click-to-edit fields. The server checks again (HH:MM, one line);
// this only decides whether a typed value is worth sending, and tidies it first.

export type InlineKind = 'title' | 'time';

export const MAX_TITLE = 120;

/** "930", "9:30", "09.30" and full-width digits all become "09:30". */
export function normalizeTime(raw: string): string | null {
  const s = raw
    .trim()
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[：.．]/g, ':');
  const m = /^(\d{1,2}):?(\d{2})$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/**
 * The value to send for `raw`, or `null` when it cannot be sent (empty or too-long title, unreadable time).
 * Titles are one line: runs of whitespace, including pasted newlines, collapse to one space.
 */
export function normalizeInline(kind: InlineKind, raw: string): string | null {
  if (kind === 'time') return normalizeTime(raw);
  const title = raw.replace(/\s+/g, ' ').trim();
  return title === '' || title.length > MAX_TITLE ? null : title;
}

/** Why `normalizeInline` refused, for the input's tooltip. */
export function inlineProblem(kind: InlineKind, raw: string): string {
  if (kind === 'time') return '請輸入時間，例如 09:30';
  return raw.trim() === '' ? '標題不可為空' : `標題最多 ${MAX_TITLE} 字`;
}
