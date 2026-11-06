// iCalendar (RFC 5545) export. Pure string building; CRLF line endings, folded at 75 octets.

import type { Item, Trip } from './types.ts';
import { addDays, isIsoDate, tryToMinutes } from './time.ts';
import { googlePlaceId } from './links.ts';

const encoder = new TextEncoder();

/** Escape a TEXT value (RFC 5545 §3.3.11). */
function escapeText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
}

/** Fold one content line to at most 75 octets per physical line, never splitting a UTF-8 sequence. */
export function foldLine(line: string): string {
  if (encoder.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = '';
  let curBytes = 0;
  let limit = 75; // continuation lines start with one space that counts toward the limit
  for (const ch of line) {
    const n = encoder.encode(ch).length;
    if (curBytes + n > limit) {
      out.push(cur);
      cur = '';
      curBytes = 0;
      limit = 74;
    }
    cur += ch;
    curBytes += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** Local date-time "YYYYMMDDTHHMMSS" for a date plus minutes since that date's midnight (may roll over days). */
function localStamp(date: string, minutes: number): string {
  const dayShift = Math.floor(minutes / 1440);
  const rem = minutes - dayShift * 1440;
  const d = (dayShift === 0 ? date : addDays(date, dayShift)).replace(/-/g, '');
  const hh = String(Math.floor(rem / 60)).padStart(2, '0');
  const mm = String(rem % 60).padStart(2, '0');
  return `${d}T${hh}${mm}00`;
}

function mapsUrl(item: Item): string | undefined {
  const placeId = googlePlaceId(item.placeId);
  if (placeId !== undefined) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(item.title)}&query_place_id=${encodeURIComponent(placeId)}`;
  }
  if (item.loc) return `https://www.google.com/maps/search/?api=1&query=${item.loc.lat},${item.loc.lng}`;
  return undefined;
}

function description(item: Item): string {
  const lines: string[] = [];
  if (item.kind === 'flight') lines.push(`航班 ${item.flightNo}`);
  if ((item.kind === 'flight' || item.kind === 'hotel') && item.bookingRef) lines.push(`訂位代號 ${item.bookingRef}`);
  if (item.note) lines.push(item.note);
  return lines.join('\n');
}

/** One VEVENT per timed item; untimed items are skipped. Times use TZID = trip.tz. */
export function tripToIcs(trip: Trip, opts: { now?: Date } = {}): string {
  const dtstamp = stamp(opts.now ?? new Date());
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//TripCode//Trip Planner//ZH',
    'CALSCALE:GREGORIAN',
    `X-WR-CALNAME:${escapeText(trip.title)}`,
    `X-WR-TIMEZONE:${trip.tz}`,
  ];

  for (const day of trip.days) {
    if (!isIsoDate(day.date)) continue;
    for (const item of day.items) {
      const start = item.start === undefined ? undefined : tryToMinutes(item.start);
      if (start === undefined) continue;
      const parsedEnd = item.end === undefined ? undefined : tryToMinutes(item.end);
      let end: number;
      if (parsedEnd !== undefined) {
        end = parsedEnd < start ? parsedEnd + 1440 : parsedEnd; // overnight (e.g. red-eye flight)
      } else {
        end = start + (item.kind === 'poi' && item.minutes ? item.minutes : 60);
      }
      lines.push('BEGIN:VEVENT');
      lines.push(`UID:${item.id}@tripcode`);
      lines.push(`DTSTAMP:${dtstamp}`);
      lines.push(`DTSTART;TZID=${trip.tz}:${localStamp(day.date, start)}`);
      lines.push(`DTEND;TZID=${trip.tz}:${localStamp(day.date, end)}`);
      lines.push(`SUMMARY:${escapeText(item.title)}`);
      lines.push(`LOCATION:${escapeText(item.title)}`);
      const url = mapsUrl(item);
      if (url) lines.push(`URL:${url}`);
      const desc = description(item);
      if (desc) lines.push(`DESCRIPTION:${escapeText(desc)}`);
      lines.push('END:VEVENT');
    }
  }

  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}
