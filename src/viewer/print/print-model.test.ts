import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Day, Item, Trip } from '../../core/types.ts';
import { buildMapData } from '../model.ts';
import { DEFAULT_OPTIONS, SHEET_MM, buildPrintDocument, estimateDayMm, planBreaks, selectDays, ticketsSection } from './print-model.ts';
import type { CoverSection, DaySection, PrintDocument, PrintOptions, TicketsSection } from './print-model.ts';

const daysOf = (doc: PrintDocument): DaySection[] => doc.sections.filter((s): s is DaySection => s.kind === 'day');

const NOW = new Date('2026-11-07T10:00:00Z');
const at = (lat: number, lng: number) => ({ lat, lng, fetchedAt: '2026-11-01T00:00:00Z' });
const HOTEL = at(41.9, 12.5);
// Roughly: 0.0001 degrees of latitude is 11 m.
const far = (n: number) => at(41.9 + n * 0.002, 12.5 + n * 0.002);

const item = (id: string, over: Record<string, unknown>): Item => ({ id, kind: 'poi', title: id, ...over }) as Item;

function trip(days: Day[]): Trip {
  return { title: '羅馬測試', start: days[0]!.date, end: days.at(-1)!.date, tz: 'Europe/Rome', party: { adults: 2, childrenAges: [] }, days, candidates: [] };
}

const hotel = item('hotel', { kind: 'hotel', title: '羅馬飯店', nights: 2, loc: HOTEL, start: '15:00' });
const day1: Day = {
  date: '2026-11-20',
  title: '抵達',
  items: [
    hotel,
    item('walk', { kind: 'transit', mode: 'walk', title: '走去景點' }),
    item('a', { title: '競技場', loc: far(1), start: '10:00', end: '12:00', locked: true }),
    item('b', { title: '附近的小店', loc: far(1) }), // within 60 m of a: no code of its own
    item('c', { title: '真理之口', loc: far(3), booking: { need: 'required', status: 'booked', title: 'x' } }),
    item('lunch', { kind: 'meal', title: '午餐', loc: far(5) }),
    item('nowhere', { title: '沒座標的景點' }),
  ],
};
const day2: Day = { date: '2026-11-21', items: [item('d', { title: '梵蒂岡', loc: far(8), start: '09:00' }), item('e', { title: '聖彼得', loc: far(9), attachments: [{ label: '門票', file: 'tickets/vatican.pdf' }] })] };
const day3: Day = { date: '2026-11-22', title: '離開', items: [item('f', { title: '機場', loc: far(12) })] };
const t = trip([day1, day2, day3]);

test('a day section: sleep box, status words, tickets, legs', () => {
  const doc = buildPrintDocument(t, DEFAULT_OPTIONS, { now: NOW });
  const [d1, d2, d3] = daysOf(doc);
  assert.deepEqual([d1!.dayNo, d1!.dateLabel, d1!.title, d1!.sleep?.label, d1!.sleep?.title], [1, '11/20（五）', '抵達', '今晚住', '羅馬飯店']);
  assert.equal(d2!.sleep?.label, '今晚住', 'the second night is the same hotel');
  assert.equal(d3!.sleep?.label, '今天退房', 'the day you leave');
  assert.deepEqual(d1!.rows.map((r) => r.kind), ['stop', 'leg', 'stop', 'stop', 'stop', 'stop', 'stop']);
  const a = d1!.rows[2]!;
  assert.deepEqual(a.kind === 'stop' && [a.start, a.end, a.status, a.arriveOnly], ['10:00', '12:00', '已確定', false]);
  const c = d1!.rows[4]!;
  assert.equal(c.kind === 'stop' && c.status, '已訂');
  const e = d2!.rows[1]!;
  assert.deepEqual(e.kind === 'stop' && e.tickets, ['門票']);
  assert.equal(d1!.rows[0]!.kind === 'stop' && d1!.rows[0]!.meta.join(), '2 晚');
  // Nothing is invented: a stop with no note has no note field, a trip with no `city` prints none.
  assert.equal('note' in a, false);
});

test('selectDays: all, from today, or the chosen numbers', () => {
  assert.deepEqual(selectDays('all', 4, null), [1, 2, 3, 4]);
  assert.deepEqual(selectDays('from-today', 4, 2), [3, 4]);
  assert.deepEqual(selectDays('from-today', 4, null), [1, 2, 3, 4], 'not travelling yet: everything');
  assert.deepEqual(selectDays([4, 2, 9], 4, null), [2, 4]);
  const doc = buildPrintDocument(t, { ...DEFAULT_OPTIONS, days: [2] }, { now: NOW });
  assert.deepEqual(daysOf(doc).map((s) => s.dayNo), [2]);
});

test('estimateDayMm grows with rows, notes and the QR strip, and with the density', () => {
  const doc = buildPrintDocument(t, DEFAULT_OPTIONS, { now: NOW });
  const base = daysOf(doc)[1]!;
  const more = { ...base, rows: [...base.rows, ...base.rows] };
  assert.ok(estimateDayMm(more, 'normal') > estimateDayMm(base, 'normal'));
  assert.ok(estimateDayMm(base, 'large') > estimateDayMm(base, 'normal'));
  assert.ok(estimateDayMm(base, 'compact') < estimateDayMm(base, 'normal'));
});

test('planBreaks: normal density starts every day on its own sheet; compact lets days flow, keeping short ones whole', () => {
  const sec = (n: number, estMm: number): DaySection => ({ ...daysOf(buildPrintDocument(t, DEFAULT_OPTIONS, { now: NOW }))[0]!, dayNo: n, estMm });
  const days = [sec(1, 90), sec(2, 100), sec(3, 60), sec(4, 200), sec(5, 80)];
  assert.ok(planBreaks(days, 'normal').every((d) => d.breakBefore && !d.keepTogether));
  const compact = planBreaks(days, 'compact');
  assert.deepEqual(compact.map((d) => d.breakBefore), [true, false, false, false, false]);
  assert.deepEqual(compact.map((d) => d.keepTogether), [true, true, true, false, true]);
  assert.ok(SHEET_MM >= 250);
});

test('document: cover first, then the days, then bookings and notes; each part can be left out', () => {
  const kinds = (o: Partial<PrintOptions>) => buildPrintDocument(t, { ...DEFAULT_OPTIONS, ...o }, { now: NOW }).sections.map((x) => x.kind);
  assert.deepEqual(kinds({}).slice(0, 4), ['cover', 'day', 'day', 'day']);
  assert.equal(kinds({}).at(-1), 'notes');
  assert.deepEqual(kinds({ cover: false, notes: false, bookings: false }), ['day', 'day', 'day']);
  assert.equal(kinds({ days: [2] }).filter((k) => k === 'day').length, 1);
});

test('cover: the whole trip at a glance, the stays with check-out dates, flights; nothing made up', () => {
  const withFlight: Trip = trip([
    { ...day1, items: [...day1.items, item('fl', { kind: 'flight', title: '台北 → 羅馬', flightNo: 'BR85', from: 'TPE', to: 'FCO', start: '23:30' })] },
    day2,
    day3,
  ]);
  const cover = buildPrintDocument(withFlight, DEFAULT_OPTIONS, { now: NOW }).sections[0] as CoverSection;
  assert.equal(cover.dateLine, '2026-11-20 → 2026-11-22 · 3 天 2 晚 · 2 位成人 · Europe/Rome');
  assert.deepEqual(cover.glance.map((g) => [g.dayNo, g.sleep ?? null]), [[1, '羅馬飯店'], [2, '羅馬飯店'], [3, null]]);
  assert.deepEqual(cover.glance[0]!.fixed, [{ time: '10:00', title: '競技場' }], 'only fixed stops that have a time (競技場 is locked; the booked 真理之口 has no time)');
  assert.equal(cover.stays.length, 1);
  assert.deepEqual([cover.stays[0]!.checkIn, cover.stays[0]!.checkOut, cover.stays[0]!.nights], ['2026-11-20', '2026-11-22', 2]);
  assert.equal('bookingRef' in cover.stays[0]!, false, 'no reference in the data: none printed (the page leaves a blank line to write on)');
  assert.deepEqual(cover.transport.map((x) => [x.title, x.code, x.time]), [['台北 → 羅馬', 'BR85', '23:30']]);
  // A subset of days still gets the overview of every day.
  const some = buildPrintDocument(t, { ...DEFAULT_OPTIONS, days: [3] }, { now: NOW }).sections[0] as CoverSection;
  assert.equal(some.glance.length, 3);
  // No place codes anywhere: a place QR only opens a map, which the person holding the phone can search themselves.
  assert.equal(JSON.stringify(buildPrintDocument(t, DEFAULT_OPTIONS, { now: NOW, tripId: 'rome' })).includes('maps.google.com'), false);
});

test('bookings: only items the trip itself says are booked or to buy; notes: labels only', () => {
  const booking = (status: 'booked' | 'todo') => ({ need: 'required', status, title: '預約', category: 'entry' });
  const bt = trip([{ date: '2026-12-01', items: [item('x', { title: '梵蒂岡博物館', booking: booking('todo') }), item('y', { title: '競技場', booking: { ...booking('booked'), boughtVia: '官網' } }), item('z', { title: '路邊攤' })] }]);
  const doc = buildPrintDocument(bt, DEFAULT_OPTIONS, { now: NOW });
  const b = doc.sections.find((x) => x.kind === 'bookings');
  assert.ok(b && b.kind === 'bookings');
  assert.deepEqual(b.rows.map((r) => [r.title, r.status, r.via ?? null]), [['梵蒂岡博物館', '待訂', null], ['競技場', '已訂', '官網']]);
  const notes = doc.sections.at(-1);
  assert.ok(notes && notes.kind === 'notes' && notes.writeIns.length === 4 && notes.lines > 0);
  // No booking data at all: no bookings page.
  assert.equal(buildPrintDocument(trip([day3]), DEFAULT_OPTIONS, { now: NOW }).sections.some((x) => x.kind === 'bookings'), false);
});

test('candidates: an optional page of the places still under discussion, never the rejected ones', () => {
  const ct: Trip = { ...t, candidates: [
    { id: 'c1', title: '鬥獸場夜遊', status: 'discuss', why: '晚上人少', loc: far(2) },
    { id: 'c2', title: '已加入的景點', status: 'accepted', day: 2 },
    { id: 'c3', title: '不去的', status: 'rejected' },
  ] as Trip['candidates'] };
  assert.equal(buildPrintDocument(ct, DEFAULT_OPTIONS, { now: NOW }).sections.some((s) => s.kind === 'candidates'), false, 'off by default');
  const doc = buildPrintDocument(ct, { ...DEFAULT_OPTIONS, candidates: true }, { now: NOW });
  const c = doc.sections.find((s) => s.kind === 'candidates');
  assert.ok(c && c.kind === 'candidates');
  assert.deepEqual(c.items.map((i) => [i.title, i.status, i.day ?? null]), [['鬥獸場夜遊', '待討論', null], ['已加入的景點', '已加入', 2]]);
  assert.equal(buildPrintDocument(t, { ...DEFAULT_OPTIONS, candidates: true }, { now: NOW }).sections.some((s) => s.kind === 'candidates'), false, 'no candidates, no page');
});

// ---------- tickets: the only QR codes on paper are the ones on the files the user attached ----------

const ticketTrip = (): Trip =>
  trip([
    { date: '2026-11-20', items: [item('colosseum', { title: '競技場', attachments: [{ label: '門票 2 張', file: 'tickets/colosseum.pdf' }] })] },
    {
      date: '2026-11-21',
      items: [
        item('vatican', { title: '梵蒂岡', attachments: [{ label: '入場券', file: 'tickets/vatican.png' }, { label: '同一張', file: 'tickets/colosseum.pdf' }] }),
        item('train', { title: '火車', attachments: [{ label: '電子票', file: 'tickets/train.pkpass' }, { label: '怪路徑', file: 'tickets/../../secret.png' }] }),
      ],
    },
    { date: '2026-11-22', items: [item('plain', { title: '路邊攤' })] },
  ]);

test('tickets: attached PDFs and pictures are printed as they are, each file once, in day order', () => {
  const doc = buildPrintDocument(ticketTrip(), DEFAULT_OPTIONS, { now: NOW, tripId: 'rome' });
  const s = doc.sections.find((x): x is TicketsSection => x.kind === 'tickets');
  assert.ok(s);
  assert.equal(s.tripId, 'rome');
  assert.deepEqual(s.items.map((i) => [i.dayNo, i.itemTitle, i.label, i.file, i.how]), [
    [1, '競技場', '門票 2 張', 'tickets/colosseum.pdf', 'convert'],
    [2, '梵蒂岡', '入場券', 'tickets/vatican.png', 'image'],
  ]);
  // Files that cannot be a picture (a wallet pass) or whose path is not a ticket file are named, not printed or fetched.
  assert.deepEqual(s.skipped.map((k) => k.file), ['tickets/train.pkpass', 'tickets/../../secret.png']);
  // They come after the days and before the bookings table.
  const kinds = doc.sections.map((x) => x.kind);
  assert.ok(kinds.indexOf('tickets') > kinds.lastIndexOf('day'));
});

test('tickets: only for the days that are printed, and not at all when off, when there is nothing attached, or without a trip id', () => {
  const only3 = buildPrintDocument(ticketTrip(), { ...DEFAULT_OPTIONS, days: [3] }, { now: NOW, tripId: 'rome' });
  assert.equal(only3.sections.some((x) => x.kind === 'tickets'), false);
  const only1 = buildPrintDocument(ticketTrip(), { ...DEFAULT_OPTIONS, days: [1] }, { now: NOW, tripId: 'rome' }).sections.find((x): x is TicketsSection => x.kind === 'tickets');
  assert.deepEqual(only1?.items.map((i) => i.file), ['tickets/colosseum.pdf']);
  assert.equal(buildPrintDocument(ticketTrip(), { ...DEFAULT_OPTIONS, tickets: false }, { now: NOW, tripId: 'rome' }).sections.some((x) => x.kind === 'tickets'), false);
  assert.equal(buildPrintDocument(ticketTrip(), DEFAULT_OPTIONS, { now: NOW }).sections.some((x) => x.kind === 'tickets'), false);
  assert.equal(buildPrintDocument(trip([day3]), DEFAULT_OPTIONS, { now: NOW, tripId: 'rome' }).sections.some((x) => x.kind === 'tickets'), false);
  assert.equal(ticketsSection(trip([day3]), [1], 'rome'), null);
});

test('a row says which of its tickets are at the back, and no document contains a place QR any more', () => {
  const doc = buildPrintDocument(ticketTrip(), DEFAULT_OPTIONS, { now: NOW, tripId: 'rome' });
  const row = daysOf(doc)[0]!.rows[0]!;
  assert.deepEqual(row.kind === 'stop' && row.tickets, ['門票 2 張']);
  assert.equal(JSON.stringify(doc).includes('"qr'), false);
});
