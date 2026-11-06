// Small, timezone-independent date/time helpers. Pure TS, no Date#getDay() on local time.

const HHMM = /^(\d{2}):(\d{2})$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parse "HH:MM" into minutes since midnight, or undefined when malformed. "24:00" is accepted (= 1440). */
export function tryToMinutes(hhmm: string): number | undefined {
  if (typeof hhmm !== 'string') return undefined;
  const m = HHMM.exec(hhmm);
  if (!m) return undefined;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59) return undefined;
  if (h > 24 || (h === 24 && min !== 0)) return undefined;
  return h * 60 + min;
}

/** "HH:MM" → minutes since midnight. Throws on malformed input. */
export function toMinutes(hhmm: string): number {
  const n = tryToMinutes(hhmm);
  if (n === undefined) throw new RangeError(`無效的時間格式：${String(hhmm)}（需為 HH:MM）`);
  return n;
}

/** Minutes since midnight → "HH:MM". Values outside 0..1439 wrap around midnight. */
export function fromMinutes(n: number): string {
  if (!Number.isFinite(n)) throw new RangeError(`無效的分鐘數：${n}`);
  const t = ((Math.round(n) % 1440) + 1440) % 1440;
  const h = Math.floor(t / 60);
  const m = t % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function parseDateUtc(date: string): number | undefined {
  const m = ISO_DATE.exec(date);
  if (!m) return undefined;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    return undefined;
  }
  return ms;
}

/** True for a real calendar date written as YYYY-MM-DD. */
export function isIsoDate(date: string): boolean {
  return typeof date === 'string' && parseDateUtc(date) !== undefined;
}

/** Day of week for a YYYY-MM-DD string, 0 = Sunday. Pure UTC math, independent of the host time zone. */
export function weekday(date: string): number {
  const ms = parseDateUtc(date);
  if (ms === undefined) throw new RangeError(`無效的日期格式：${String(date)}（需為 YYYY-MM-DD）`);
  return new Date(ms).getUTCDay();
}

/** Add (or subtract) whole days to a YYYY-MM-DD string. */
export function addDays(date: string, n: number): string {
  const ms = parseDateUtc(date);
  if (ms === undefined) throw new RangeError(`無效的日期格式：${String(date)}（需為 YYYY-MM-DD）`);
  const d = new Date(ms + Math.round(n) * 86_400_000);
  const y = String(d.getUTCFullYear()).padStart(4, '0');
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}
