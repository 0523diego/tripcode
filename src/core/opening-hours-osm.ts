// OSM opening_hours text → OpeningHours, simple forms only (the same rules as cli/osm.ts's parser, which lives in the CLI layer
// and cannot be imported from src/core). Anything else (holidays, months, "off", comments) is undefined: unknown, never guessed.
import type { OpeningHours } from './types.ts';

const DAY_CODES = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

function parseDays(s: string): number[] | undefined {
  const days = new Set<number>();
  for (const part of s.split(',')) {
    const m = /^(Mo|Tu|We|Th|Fr|Sa|Su)(?:-(Mo|Tu|We|Th|Fr|Sa|Su))?$/.exec(part.trim());
    if (!m) return undefined;
    const a = DAY_CODES.indexOf(m[1]!);
    if (!m[2]) {
      days.add(a);
      continue;
    }
    const b = DAY_CODES.indexOf(m[2]);
    for (let d = a; ; d = (d + 1) % 7) {
      days.add(d);
      if (d === b) break;
    }
  }
  return [...days];
}

function hhmm(s: string): string | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return undefined;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59 || h > 24 || (h === 24 && min !== 0)) return undefined;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

export function parseOpeningHours(raw: string): OpeningHours | undefined {
  const s = raw.trim();
  if (s === '24/7') return { periods: Array.from({ length: 7 }, (_, d) => ({ day: d, open: '00:00', close: '24:00' })) };
  // `origin` = the day whose rule produced the period (a period past midnight also lands on the next day): in OSM syntax a later
  // rule for a day REPLACES what an earlier rule said for it ("Mo-Su 12:00-23:00; Tu 18:00-23:00" opens Tuesdays at 18:00).
  const kept: { origin: number; day: number; open: string; close: string }[] = [];
  for (const rule of s.split(';')) {
    // A rule with no days ("11:00-24:00") means every day.
    const m = /^\s*(?:([A-Za-z,-]+)\s+)?(\d{1,2}:\d{2}-\d{1,2}:\d{2}(?:\s*,\s*\d{1,2}:\d{2}-\d{1,2}:\d{2})*)\s*$/.exec(rule);
    if (!m) return undefined;
    const days = m[1] ? parseDays(m[1]) : [0, 1, 2, 3, 4, 5, 6];
    if (!days) return undefined;
    for (let i = kept.length - 1; i >= 0; i--) if (days.includes(kept[i]!.origin)) kept.splice(i, 1);
    for (const range of m[2]!.split(',')) {
      const [o, c] = range.trim().split('-');
      const open = hhmm(o!);
      const close = hhmm(c!);
      if (!open || !close || open === close) return undefined;
      for (const day of days) {
        if (close > open) kept.push({ origin: day, day, open, close });
        else {
          kept.push({ origin: day, day, open, close: '24:00' });
          if (close !== '00:00') kept.push({ origin: day, day: (day + 1) % 7, open: '00:00', close });
        }
      }
    }
  }
  const periods: OpeningHours['periods'] = kept.map(({ day, open, close }) => ({ day, open, close }));
  return periods.length ? { periods } : undefined;
}
