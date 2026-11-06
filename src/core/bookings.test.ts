import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { cleanBookingUrl, deriveBookingTodos, isResellerUrl, linksFor, searchLinks } from './bookings.ts';
import type { Booking, Item, Trip } from './types.ts';

const NOW = new Date('2026-11-04T12:00:00Z');
const src = (value: string, source = 'https://example.org/page') => ({ value, source, fetchedAt: '2026-11-04T10:00:00Z', confidence: 'recent' as const });

function trip(days: { date: string; items: Item[] }[], over: Partial<Trip> = {}): Trip {
  return { title: 't', start: days[0]!.date, end: days.at(-1)!.date, tz: 'Europe/Paris', party: { adults: 2, childrenAges: [] }, days, candidates: [], ...over } as Trip;
}
const poi = (id: string, note?: string, extra: Partial<Item> = {}): Item => ({ id, kind: 'poi', title: id, ...(note ? { note } : {}), ...extra }) as Item;
const hotel = (id: string, nights: number, extra: Partial<Item> = {}): Item => ({ id, kind: 'hotel', title: id, nights, ...extra }) as Item;

describe('cleanBookingUrl', () => {
  test('keeps https, drops tracking and affiliate parameters and the fragment', () => {
    assert.equal(
      cleanBookingUrl('https://tickets.louvre.fr/en/buy?date=2026-11-10&utm_source=x&aff_id=9&ref=blog&gclid=1&fbclid=2&irclickid=3&clickref=4&partner=p&aid=5&cid=6#frag'),
      'https://tickets.louvre.fr/en/buy?date=2026-11-10',
    );
  });
  test('refuses anything that is not plain https', () => {
    for (const bad of ['http://x.com/a', 'ftp://x.com', 'javascript:alert(1)', 'not a url', 'https://user:pw@x.com/']) assert.equal(cleanBookingUrl(bad), undefined, bad);
  });
  test('resellers are recognised, subdomains included', () => {
    assert.equal(isResellerUrl('https://www.klook.com/zh-TW/activity/1'), true);
    assert.equal(isResellerUrl('https://tw.trip.com/things-to-do/x'), true);
    assert.equal(isResellerUrl('https://www.louvre.fr/'), false);
    assert.equal(isResellerUrl('https://notklook.com/'), false);
  });
});

describe('linksFor', () => {
  test('with nothing known: three searches, honestly labelled', () => {
    const l = linksFor('羅浮宮 Louvre', undefined, 'Paris');
    assert.deepEqual(l.map((x) => [x.key, x.urlKind]), [['official', 'search'], ['klook', 'search'], ['tripcom', 'search']]);
    assert.match(l[1]!.url, /site%3Aklook\.com/);
    assert.match(l[2]!.url, /site%3Atrip\.com/);
    assert.ok(l.every((x) => !/utm_|aff/.test(x.url)));
  });
  test('a checked official page replaces its search; resellers fill their own slots; a reseller can never take the official slot', () => {
    const booking: Booking = {
      need: 'required',
      status: 'todo',
      bookingUrl: src('https://tickets.louvre.fr/en?utm_source=blog'),
      sellers: [
        { kind: 'reseller', name: 'Klook', urlKind: 'product', link: src('https://www.klook.com/activity/123?aid=7') },
        { kind: 'official', name: 'Louvre', urlKind: 'product', link: src('https://www.getyourguide.com/louvre') },
      ],
    };
    const l = linksFor('Louvre', booking);
    assert.deepEqual(l.find((x) => x.key === 'official'), { key: 'official', label: '官方購票頁', url: 'https://tickets.louvre.fr/en', urlKind: 'product', source: 'https://example.org/page', fetchedAt: '2026-11-04T10:00:00Z' });
    assert.equal(l.find((x) => x.key === 'klook')!.url, 'https://www.klook.com/activity/123');
    assert.equal(l.find((x) => x.key === 'tripcom')!.urlKind, 'search');
    const bad = linksFor('Louvre', { need: 'required', status: 'todo', bookingUrl: src('https://www.klook.com/x') });
    assert.equal(bad.find((x) => x.key === 'official')!.urlKind, 'search', 'a reseller URL in bookingUrl is ignored');
  });
  test('only the home page known: it is offered as the starting point', () => {
    const l = linksFor('Louvre', { need: 'unknown', status: 'todo', officialSite: src('https://www.louvre.fr/') });
    assert.deepEqual([l[0]!.urlKind, l[0]!.label], ['site', '官網（從這裡找購票）']);
  });
  test('search links never contain the sellers own URL guesses', () => {
    assert.ok(searchLinks('x').every((l) => l.url.startsWith('https://www.google.com/search?q=')));
  });
});

describe('deriveBookingTodos', () => {
  test('every row says why; keyword guesses are only "recommended"', () => {
    const t = trip([{ date: '2026-11-20', items: [poi('a', '尚未訂票，要預約時段'), poi('b', '免費免預約'), poi('c', '隨便逛逛'), poi('d', '預約時段；已訂 11:00')] }]);
    const { items, unknown } = deriveBookingTodos(t, NOW);
    assert.deepEqual(items.map((i) => [i.itemId, i.need, i.basis]), [['a', 'recommended', 'keyword']]);
    assert.match(items[0]!.reason, /關鍵字推測/);
    assert.deepEqual(unknown, []);
  });
  test('a note that says both reserve and free is listed, with the doubt written out', () => {
    const t = trip([{ date: '2026-11-20', items: [poi('dome', '大教堂免費免預約；登圓頂要預約時段票')] }]);
    assert.match(deriveBookingTodos(t, NOW).items[0]!.reason, /同時寫了免預約/);
  });
  test('a price or weak hint goes to "unknown", not to the list', () => {
    const t = trip([{ date: '2026-11-20', items: [poi('castle', '票價各網站不一致'), poi('free', '門票免費免預約')] }]);
    const r = deriveBookingTodos(t, NOW);
    assert.deepEqual(r.items, []);
    assert.deepEqual(r.unknown.map((u) => u.itemId), ['castle']);
  });
  test('locked with a voucher is booked; flights and hotels without a lock are to buy; a tube ride is not', () => {
    const t = trip([
      {
        date: '2026-11-20',
        items: [
          poi('show', undefined, { locked: true, attachments: [{ file: 'tickets/a.pdf', label: 'a', kind: 'entry' }] }),
          { id: 'fl', kind: 'flight', title: 'f', flightNo: 'X1' } as Item,
          hotel('h', 2),
          { id: 'tube', kind: 'transit', title: 'tube', mode: 'train' } as Item,
          { id: 'long', kind: 'transit', title: 'long', mode: 'train', duration: { value: 120, source: 's', fetchedAt: '2026-11-04T10:00:00Z', confidence: 'recent' } } as Item,
          { id: 'locked-train', kind: 'transit', title: 'tr', mode: 'train', locked: true } as Item,
        ],
      },
    ]);
    const by = Object.fromEntries(deriveBookingTodos(t, NOW).items.map((i) => [i.itemId, `${i.status}/${i.basis}`]));
    assert.deepEqual(by, { show: 'booked/locked', fl: 'todo/kind', h: 'todo/kind', long: 'todo/kind', 'locked-train': 'booked/kind' });
  });
  test('an explicit booking field wins over every guess', () => {
    const t = trip([{ date: '2026-11-20', items: [poi('x', '尚未訂票', { booking: { need: 'none', status: 'not-needed' } })] }]);
    const r = deriveBookingTodos(t, NOW).items;
    assert.deepEqual(r.map((i) => [i.status, i.basis]), [['not-needed', 'explicit']]);
  });
  test('urgency follows the dates; an opens-rule becomes a date from the visit day', () => {
    const mk = (date: string, booking: Booking) => deriveBookingTodos(trip([{ date, items: [poi('p', undefined, { booking })] }]), NOW).items[0]!;
    assert.equal(mk('2026-12-24', { need: 'required', status: 'todo' }).urgency, 'later');
    assert.equal(mk('2026-11-12', { need: 'required', status: 'todo' }).urgency, 'now');
    assert.equal(mk('2026-11-30', { need: 'recommended', status: 'todo' }).urgency, 'soon');
    const rule = mk('2026-11-24', { need: 'required', status: 'todo', opensRule: src('x') as never });
    assert.equal(rule.opensOn, undefined, 'a malformed rule is ignored, not guessed');
    const ok = mk('2026-11-24', { need: 'required', status: 'todo', opensRule: { value: { daysBefore: 10 }, source: 's', fetchedAt: '2026-11-04T00:00:00Z', confidence: 'recent' } });
    assert.equal(ok.opensOn, '2026-11-14');
    assert.equal(mk('2026-12-20', { need: 'required', status: 'todo', deadline: src('2026-11-06T10:00:00Z') as never }).deadlineOn, '2026-11-06');
    assert.equal(mk('2026-12-20', { need: 'required', status: 'todo', deadline: src('2026-11-06T10:00:00Z') as never }).urgency, 'now');
    assert.equal(mk('2026-12-20', { need: 'required', status: 'booked' }).urgency, 'none');
  });
  test('what is already behind us is not listed to buy, but what was bought stays', () => {
    const t = trip([{ date: '2026-10-01', items: [poi('old', '尚未訂票'), poi('done', undefined, { booking: { need: 'required', status: 'booked' } })] }]);
    assert.deepEqual(deriveBookingTodos(t, NOW).items.map((i) => i.itemId), ['done']);
  });
  test('nights without a bed are merged into one row', () => {
    const t = trip(
      [
        { date: '2026-11-12', items: [] },
        { date: '2026-11-13', items: [] },
        { date: '2026-11-14', items: [hotel('late', 1)] },
        { date: '2026-11-15', items: [] },
      ],
      { start: '2026-11-12', end: '2026-11-15' },
    );
    const gaps = deriveBookingTodos(t, NOW).items.filter((i) => i.basis === 'gap');
    assert.equal(gaps.length, 1);
    assert.match(gaps[0]!.title, /11\/12–11\/13（2 晚）/);
  });
  test('sorted: most urgent first', () => {
    const t = trip([{ date: '2026-11-08', items: [poi('late', undefined, { booking: { need: 'required', status: 'todo' } })] }, { date: '2026-12-30', items: [poi('far', undefined, { booking: { need: 'required', status: 'todo' } })] }]);
    assert.deepEqual(deriveBookingTodos(t, NOW).items.filter((i) => i.basis !== 'gap').map((i) => i.itemId), ['late', 'far']);
  });
});
