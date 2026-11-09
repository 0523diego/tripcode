import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Day, Trip } from '../../core/types.ts';
import { PREFS_KEY, estimatePages, formatDays, loadPrefs, mergeOptions, parseDaysSpec, parsePrintQuery, printFileTitle, savePrefs, toPrintQuery } from './print-options.ts';
import { DEFAULT_OPTIONS, buildPrintDocument } from './print-model.ts';

test('days spec: ranges, lists, the two names; nonsense is not a spec', () => {
  assert.deepEqual(parseDaysSpec('1-3,5'), [1, 2, 3, 5]);
  assert.deepEqual(parseDaysSpec('5,1,1-2'), [1, 2, 5]);
  assert.equal(parseDaysSpec('all'), 'all');
  assert.equal(parseDaysSpec('today'), 'from-today');
  for (const bad of ['', '0', '3-1', '1-', 'a', '1,,2', '1-9999', '-2']) assert.equal(parseDaysSpec(bad), null, bad);
  assert.equal(parseDaysSpec(null), null);
  assert.equal(formatDays([5, 1, 2, 3]), '1-3,5');
  assert.equal(formatDays([2]), '2');
});

test('an empty day selection survives a reload (days=none), it does not turn into all days', () => {
  assert.deepEqual(parseDaysSpec('none'), []);
  assert.equal(toPrintQuery(mergeOptions({ days: [] })), 'days=none');
  assert.deepEqual(mergeOptions(parsePrintQuery(toPrintQuery(mergeOptions({ days: [] })))).days, []);
});

test('the query reads what it recognises and ignores the rest', () => {
  assert.deepEqual(parsePrintQuery('?days=2-3&tickets=0&density=large&notes=0&cover=1&paper=Letter'), { days: [2, 3], tickets: false, density: 'large', notes: false, cover: true, paper: 'Letter' });
  assert.deepEqual(parsePrintQuery('qr=lots&tickets=maybe&density=huge&paper=A3&notes=maybe&days=x&unknown=1'), {});
  assert.deepEqual(parsePrintQuery(''), {});
});

test('toPrintQuery lists only what differs from the defaults and round-trips', () => {
  assert.equal(toPrintQuery(DEFAULT_OPTIONS), '');
  const o = mergeOptions({ days: [1, 2, 3, 5], tickets: false, density: 'compact', notes: false, candidates: true, paper: 'Letter' });
  assert.equal(toPrintQuery(o), 'days=1-3,5&density=compact&notes=0&candidates=1&tickets=0&paper=Letter');
  assert.deepEqual(mergeOptions(parsePrintQuery(toPrintQuery(o))), o);
  assert.equal(toPrintQuery(mergeOptions({ days: 'from-today' })), 'days=today');
});

test('remembered choices: everything but the days; a broken store is just empty', () => {
  const mem = new Map<string, string>();
  const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
  savePrefs(mergeOptions({ days: [2], density: 'large', tickets: false, notes: false }), store);
  assert.deepEqual(JSON.parse(mem.get(PREFS_KEY)!).days, undefined);
  assert.deepEqual(loadPrefs(store), { density: 'large', notes: false, cover: true, bookings: true, candidates: false, tickets: false, paper: 'A4' });
  mem.set(PREFS_KEY, '{not json');
  assert.deepEqual(loadPrefs(store), {});
  mem.set(PREFS_KEY, JSON.stringify({ density: 'enormous', qr: 'key', tickets: true, days: [3] }));
  assert.deepEqual(loadPrefs(store), { tickets: true }, 'unknown values (including the old qr choice) and the days are dropped');
  assert.deepEqual(loadPrefs({ getItem: () => { throw new Error('blocked'); }, setItem: () => undefined }), {});
});

test('the PDF is named after the trip and the day', () => {
  assert.equal(printFileTitle({ title: '示範行程 11 天' }, new Date('2026-11-07T10:00:00Z')), '示範行程 11 天 行程 2026-11-07');
  assert.equal(printFileTitle({ title: 'a/b: c' }, new Date('2026-11-07T10:00:00Z')), 'a-b- c 行程 2026-11-07');
});

test('page estimate: cover, one sheet per day, bookings and notes together', () => {
  const day = (n: number): Day => ({ date: `2026-11-${20 + n}`, items: [{ id: `i${n}`, kind: 'poi', title: 'x' }] });
  const t: Trip = { title: 't', start: '2026-11-21', end: '2026-11-23', tz: 'UTC', party: { adults: 1, childrenAges: [] }, days: [day(1), day(2), day(3)], candidates: [] };
  const doc = buildPrintDocument(t, DEFAULT_OPTIONS, { now: new Date('2026-11-07T00:00:00Z') });
  assert.equal(estimatePages(doc), 1 + 3 + 1, 'cover + 3 days + one closing page (the trip has no hotel, so the bookings table lists that gap; notes share its page)');
  assert.equal(estimatePages(buildPrintDocument(t, { ...DEFAULT_OPTIONS, cover: false, notes: false, bookings: false }, { now: new Date('2026-11-07T00:00:00Z') })), 3);
  const compact = buildPrintDocument(t, { ...DEFAULT_OPTIONS, density: 'compact', cover: false, notes: false, bookings: false }, { now: new Date('2026-11-07T00:00:00Z') });
  assert.equal(estimatePages(compact), 1, 'three short days share one sheet in compact density');
  const big = buildPrintDocument(t, { ...DEFAULT_OPTIONS, density: 'compact', cover: false, notes: false, bookings: false }, { now: new Date('2026-11-07T00:00:00Z') });
  assert.equal(estimatePages({ ...big, sections: big.sections.map((s) => (s.kind === 'day' ? { ...s, estMm: 100 } : s)) }), 2, 'three days of 100 mm = 300 mm = two sheets');
});
