import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldLine, tripToIcs } from './ics.ts';
import type { Item, Trip } from './types.ts';

const NOW = new Date('2026-05-01T08:09:10.123Z');

function trip(items: Item[], extra: Partial<Trip> = {}): Trip {
  return {
    title: '瑞士, 之旅',
    start: '2026-06-14',
    end: '2026-06-16',
    tz: 'Europe/Zurich',
    party: { adults: 2, childrenAges: [] },
    days: [{ date: '2026-06-14', items }],
    candidates: [],
    ...extra,
  };
}

/** Unfold per RFC 5545 and split to logical lines. */
function unfold(ics: string): string[] {
  return ics.replace(/\r\n[ \t]/g, '').split('\r\n');
}

test('calendar skeleton, CRLF endings and trailing CRLF', () => {
  const ics = tripToIcs(trip([]), { now: NOW });
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n'));
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
  assert.ok(!/(^|[^\r])\n/.test(ics), 'every LF is preceded by CR');
  assert.ok(unfold(ics).includes('X-WR-CALNAME:瑞士\\, 之旅'));
});

test('semicolons, commas, backslashes and newlines in TEXT values are escaped', () => {
  const items: Item[] = [{ id: 'a', kind: 'poi', title: 'A; B, C\\D', start: '09:00', end: '10:00', note: 'x;y\nz' }];
  const lines = unfold(tripToIcs(trip(items), { now: NOW }));
  assert.ok(lines.includes('SUMMARY:A\\; B\\, C\\\\D'));
  assert.ok(lines.includes('DESCRIPTION:x\\;y\\nz'));
});

test('one VEVENT per timed item; untimed and malformed times are skipped', () => {
  const items: Item[] = [
    { id: 'a', kind: 'poi', title: 'A', start: '09:00', end: '10:00' },
    { id: 'b', kind: 'free', title: 'B' },
    { id: 'c', kind: 'poi', title: 'C', start: '9am' },
    { id: 'd', kind: 'meal', title: 'D', start: '12:30', end: '13:30' },
  ];
  const lines = unfold(tripToIcs(trip(items), { now: NOW }));
  assert.equal(lines.filter((l) => l === 'BEGIN:VEVENT').length, 2);
  assert.ok(lines.includes('UID:a@tripcode'));
  assert.ok(lines.includes('UID:d@tripcode'));
  assert.ok(!lines.includes('UID:b@tripcode'));
});

test('DTSTART/DTEND use TZID, DTSTAMP from opts.now, deterministic output', () => {
  const t = trip([{ id: 'a', kind: 'poi', title: 'A', start: '09:30', end: '11:05' }]);
  const lines = unfold(tripToIcs(t, { now: NOW }));
  assert.ok(lines.includes('DTSTART;TZID=Europe/Zurich:20260614T093000'));
  assert.ok(lines.includes('DTEND;TZID=Europe/Zurich:20260614T110500'));
  assert.ok(lines.includes('DTSTAMP:20260501T080910Z'));
  assert.equal(tripToIcs(t, { now: NOW }), tripToIcs(t, { now: NOW }));
});

test('missing end: poi.minutes, otherwise one hour; overnight end rolls to next day', () => {
  const items: Item[] = [
    { id: 'p', kind: 'poi', title: 'P', start: '10:00', minutes: 90 },
    { id: 'q', kind: 'poi', title: 'Q', start: '23:30' },
    { id: 'f', kind: 'flight', flightNo: 'BR1', title: 'Red-eye', start: '23:50', end: '06:30' },
  ];
  const lines = unfold(tripToIcs(trip(items), { now: NOW }));
  assert.ok(lines.includes('DTEND;TZID=Europe/Zurich:20260614T113000'));
  assert.ok(lines.includes('DTEND;TZID=Europe/Zurich:20260615T003000'));
  assert.ok(lines.includes('DTEND;TZID=Europe/Zurich:20260615T063000'));
});

test('LOCATION is the title; URL by place_id, by lat,lng, or absent', () => {
  const items: Item[] = [
    { id: 'a', kind: 'poi', title: 'Chapel Bridge', start: '09:00', end: '10:00', placeId: 'ChIJabc' },
    { id: 'b', kind: 'poi', title: 'B', start: '10:00', end: '11:00', loc: { lat: 47.05, lng: 8.3 } },
    { id: 'c', kind: 'poi', title: 'C', start: '11:00', end: '12:00' },
  ];
  const ics = unfold(tripToIcs(trip(items), { now: NOW }));
  assert.ok(ics.includes('LOCATION:Chapel Bridge'));
  assert.ok(ics.includes('URL:https://www.google.com/maps/search/?api=1&query=Chapel%20Bridge&query_place_id=ChIJabc'));
  assert.ok(ics.includes('URL:https://www.google.com/maps/search/?api=1&query=47.05,8.3'));
  assert.equal(ics.filter((l) => l.startsWith('URL:')).length, 2);
});

test('escapes commas, semicolons, backslashes and newlines; description carries flight info and note', () => {
  const items: Item[] = [
    { id: 'f', kind: 'flight', flightNo: 'LX 160', title: 'a, b; c\\d', start: '08:00', end: '09:00', bookingRef: 'ABC123', note: 'line1\nline2, ok' },
  ];
  const ics = unfold(tripToIcs(trip(items), { now: NOW }));
  assert.ok(ics.includes('SUMMARY:a\\, b\\; c\\\\d'));
  assert.ok(ics.includes('LOCATION:a\\, b\\; c\\\\d'));
  const desc = ics.find((l) => l.startsWith('DESCRIPTION:'));
  assert.equal(desc, 'DESCRIPTION:航班 LX 160\\n訂位代號 ABC123\\nline1\\nline2\\, ok');
});

test('long lines fold at <=75 octets without splitting multibyte characters', () => {
  const title = '很長的標題'.repeat(30); // 3 bytes per char
  const ics = tripToIcs(trip([{ id: 'a', kind: 'poi', title, start: '09:00', end: '10:00' }]), { now: NOW });
  const physical = ics.split('\r\n');
  for (const l of physical) assert.ok(new TextEncoder().encode(l).length <= 75, l);
  assert.ok(physical.some((l) => l.startsWith(' ')));
  assert.ok(unfold(ics).includes(`SUMMARY:${title}`));
  // no replacement chars from a split sequence
  assert.ok(!ics.includes('\uFFFD'));
});

test('foldLine leaves short lines alone and folds exactly at the boundary', () => {
  assert.equal(foldLine('x'.repeat(75)), 'x'.repeat(75));
  const folded = foldLine('x'.repeat(76));
  assert.equal(folded, 'x'.repeat(75) + '\r\n ' + 'x');
  assert.equal(foldLine('x'.repeat(75 + 74 + 1)).split('\r\n').length, 3);
});

test('multi-day trips produce events on their own dates', () => {
  const t = trip([], {
    days: [
      { date: '2026-06-14', items: [{ id: 'a', kind: 'poi', title: 'A', start: '09:00', end: '10:00' }] },
      { date: '2026-06-15', items: [{ id: 'b', kind: 'poi', title: 'B', start: '09:00', end: '10:00' }] },
    ],
  });
  const lines = unfold(tripToIcs(t, { now: NOW }));
  assert.ok(lines.includes('DTSTART;TZID=Europe/Zurich:20260614T090000'));
  assert.ok(lines.includes('DTSTART;TZID=Europe/Zurich:20260615T090000'));
});
