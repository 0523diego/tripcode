import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setBooking } from './source-edit.ts';

const base = `export default defineTrip({
  days: [
    {
      date: '2026-11-21',
      items: [
        {
          id: 'duomo',
          kind: 'poi',
          title: '米蘭大教堂',
          note: '尚未訂票',
        },
        { id: 'inline', kind: 'poi', title: 'X', booking: { need: 'required', status: 'todo' } },
        {
          id: 'rich',
          kind: 'poi',
          title: 'Y',
          booking: {
            need: 'required',
            status: 'todo',
            bookingUrl: { value: 'https://tickets.example.org/', source: 'https://example.org/', fetchedAt: '2026-11-04T10:00:00Z', confidence: 'recent' },
            cancellation: { value: '不可退', source: 's', fetchedAt: '2026-11-04T10:00:00Z', confidence: 'recent' },
          },
        },
        { id: 'plain', kind: 'free', title: 'Z' },
      ],
    },
  ],
});
`;

const changedLines = (a: string, b: string) => {
  const x = a.split('\n');
  const y = b.split('\n');
  return { removed: x.filter((l) => !y.includes(l)), added: y.filter((l) => !x.includes(l)) };
};

describe('setBooking', () => {
  test('creates a booking on an item that has none, right below its id, touching nothing else', () => {
    const out = setBooking(base, 'duomo', { need: 'recommended', status: 'booked', bookedAt: '2026-11-04T12:00:00.000Z' });
    assert.deepEqual(changedLines(base, out), { removed: [], added: ["          booking: { need: 'recommended', status: 'booked', bookedAt: '2026-11-04T12:00:00.000Z' },"] });
  });
  test('creating needs need and status', () => {
    assert.throws(() => setBooking(base, 'duomo', { status: 'booked' }), /need 與 status/);
  });
  test('changes status inside a one-line booking and adds bookedAt and boughtVia', () => {
    const out = setBooking(base, 'inline', { status: 'booked', bookedAt: '2026-11-04T12:00:00.000Z', boughtVia: 'Klook' });
    assert.match(out, /booking: \{ need: 'required', status: 'booked', bookedAt: '2026-11-04T12:00:00.000Z', boughtVia: 'Klook' \}/);
    assert.equal(changedLines(base, out).removed.length, 1, 'only that one line changed');
  });
  test('inside a multi-line booking only the asked fields change; links and dates stay byte for byte', () => {
    const out = setBooking(base, 'rich', { status: 'booked', bookedAt: '2026-11-04T12:00:00.000Z' });
    const { removed, added } = changedLines(base, out);
    assert.deepEqual(removed, ["            status: 'todo',"]);
    assert.deepEqual(added, ["            status: 'booked',", "            bookedAt: '2026-11-04T12:00:00.000Z',"]);
  });
  test('undo by hand: marking it todo again and removing the stamps restores the original', () => {
    const booked = setBooking(base, 'rich', { status: 'booked', bookedAt: '2026-11-04T12:00:00.000Z', boughtVia: 'official' });
    const back = setBooking(booked, 'rich', { status: 'todo', bookedAt: null, boughtVia: null });
    assert.equal(back, base);
    const inline = setBooking(setBooking(base, 'inline', { status: 'booked', bookedAt: 'x' }), 'inline', { status: 'todo', bookedAt: null });
    assert.equal(inline, base);
  });
  test('refuses fields it does not own and items that do not exist', () => {
    assert.throws(() => setBooking(base, 'rich', { officialSite: 'x' } as never), /不允許/);
    assert.throws(() => setBooking(base, 'nope', { need: 'none', status: 'not-needed' }), /找不到/);
  });
  test('a string with quotes is escaped', () => {
    const out = setBooking(base, 'inline', { boughtVia: "Trip.com 'TW'" });
    assert.match(out, /boughtVia: 'Trip\.com \\'TW\\''/);
  });
});

describe('setDayAccepted', () => {
  const src = `export default defineTrip({\n  days: [\n    {\n      date: '2026-11-21',\n      items: [],\n    },\n  ],\n});\n`;
  test('adds, replaces and removes the list on the day, touching nothing else', async () => {
    const { setDayAccepted } = await import('./source-edit.ts');
    const a = setDayAccepted(src, '2026-11-21', ['walking-heavy']);
    assert.match(a, /accepted: \['walking-heavy'\]/);
    const b = setDayAccepted(a, '2026-11-21', ['walking-heavy', 'no-easy-day']);
    assert.match(b, /accepted: \['walking-heavy', 'no-easy-day'\]/);
    assert.equal(setDayAccepted(b, '2026-11-21', []), src);
    assert.throws(() => setDayAccepted(src, '2026-12-01', ['no-easy-day']), /找不到/);
  });
});
