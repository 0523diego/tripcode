import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, test } from 'node:test';
import { isDue, scanTrip } from './scan.ts';
import { loadAlerts, loadSamples, saveWatches, validateWatch } from './store.ts';
import type { Watch } from './types.ts';

let dir: string;
let clock: Date;
let pages: Record<string, { status?: number; body: string }>;
let hits: string[];

const deps = () => ({
  now: () => clock,
  fetch: async (url: string) => {
    hits.push(url);
    const p = pages[url];
    if (!p) throw new Error('network down');
    return new Response(p.body, { status: p.status ?? 200 });
  },
});

const offer = (price: number, currency = 'EUR') => `<script type="application/ld+json">${JSON.stringify({ '@type': 'Offer', price, priceCurrency: currency })}</script>`;
const URL1 = 'https://example.com/hotel';

function watch(over: Partial<Watch> = {}): Watch {
  return validateWatch({ id: 'hotel', title: '羅馬飯店', url: URL1, kind: 'price', everyMinutes: 60, targetPrice: 100, currency: 'EUR', ...over }, clock);
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'tc-scan-'));
  clock = new Date('2026-11-01T10:00:00Z');
  pages = {};
  hits = [];
});

describe('validateWatch', () => {
  test('refuses what could be abused', () => {
    assert.throws(() => watch({ url: 'http://example.com/x' }), /https/);
    assert.throws(() => watch({ url: 'https://localhost/x' }), /本機/);
    assert.throws(() => watch({ url: 'https://192.168.1.1/x' }), /內網/);
    assert.throws(() => watch({ url: 'https://u:p@example.com/x' }), /帳號/);
    assert.throws(() => watch({ everyMinutes: 5 }), /60/);
    assert.throws(() => watch({ targetPrice: undefined }), /targetPrice/);
    assert.throws(() => watch({ regex: '(' }), /regex/);
    assert.throws(() => watch({ id: 'Bad Id' }), /id/);
  });
});

describe('isDue', () => {
  test('respects the interval, active and until', () => {
    const w = watch();
    assert.equal(isDue(w, undefined, clock), true);
    assert.equal(isDue(w, '2026-11-01T09:30:00Z', clock), false);
    assert.equal(isDue(w, '2026-11-01T08:59:00Z', clock), true);
    assert.equal(isDue({ ...w, active: false }, undefined, clock), false);
    assert.equal(isDue({ ...w, until: '2026-10-31' }, undefined, clock), false);
    assert.equal(isDue(w, '2026-11-01T09:59:00Z', clock, true), true);
  });
});

describe('scanTrip', () => {
  test('alerts when the price reaches the target, once per price', async () => {
    await saveWatches(dir, [watch()]);
    pages[URL1] = { body: offer(120) };
    let r = await scanTrip(dir, deps());
    assert.equal(r.alerts.length, 0);

    clock = new Date('2026-11-01T12:00:00Z');
    pages[URL1] = { body: offer(95) };
    r = await scanTrip(dir, deps());
    assert.equal(r.alerts.length, 1);
    assert.equal(r.alerts[0]!.kind, 'target');
    assert.match(r.alerts[0]!.message, /EUR 95/);

    clock = new Date('2026-11-01T14:00:00Z');
    r = await scanTrip(dir, deps());
    assert.equal(r.alerts.length, 0, 'same price again is not news');
    assert.equal((await loadSamples(dir)).length, 3);
    assert.equal((await loadAlerts(dir)).length, 1);
  });

  test('alerts on a drop since the last reading', async () => {
    await saveWatches(dir, [watch({ targetPrice: undefined, dropPercent: 10 })]);
    pages[URL1] = { body: offer(200) };
    await scanTrip(dir, deps());
    clock = new Date('2026-11-01T12:00:00Z');
    pages[URL1] = { body: offer(170) };
    const r = await scanTrip(dir, deps());
    assert.deepEqual(r.alerts.map((a) => a.kind), ['drop']);
    assert.match(r.alerts[0]!.message, /−15%/);
  });

  test('does not look again before the interval', async () => {
    await saveWatches(dir, [watch()]);
    pages[URL1] = { body: offer(120) };
    await scanTrip(dir, deps());
    clock = new Date('2026-11-01T10:30:00Z');
    const r = await scanTrip(dir, deps());
    assert.equal(r.results.length, 0);
    assert.equal(hits.length, 1);
    assert.equal((await scanTrip(dir, deps(), { force: true })).results.length, 1);
  });

  test('a page that cannot be read is reported after three failures, once', async () => {
    await saveWatches(dir, [watch()]);
    pages[URL1] = { body: '<p>nothing structured</p>' };
    const kinds: string[] = [];
    for (let i = 0; i < 5; i++) {
      clock = new Date(clock.getTime() + 2 * 3_600_000);
      kinds.push(...(await scanTrip(dir, deps())).alerts.map((a) => a.kind));
    }
    assert.deepEqual(kinds, ['unreadable']);
  });

  test('HTTP errors and network errors are samples, not crashes', async () => {
    await saveWatches(dir, [watch(), watch({ id: 'other', url: 'https://example.com/other' })]);
    pages[URL1] = { status: 429, body: 'slow down' };
    const r = await scanTrip(dir, deps());
    assert.deepEqual(r.results.map((x) => x.sample.error), ['HTTP 429', 'network down']);
  });

  test('a price in another currency is unreadable, not compared', async () => {
    await saveWatches(dir, [watch()]);
    pages[URL1] = { body: offer(50, 'USD') };
    const r = await scanTrip(dir, deps());
    assert.match(r.results[0]!.sample.error!, /幣別不符/);
  });

  test('availability watch alerts when the page starts selling', async () => {
    await saveWatches(dir, [validateWatch({ id: 'rome-pass', title: '梵蒂岡門票', url: URL1, kind: 'availability', everyMinutes: 60, regex: 'add to cart' }, clock)]);
    pages[URL1] = { body: '<p>Coming soon</p>' };
    assert.equal((await scanTrip(dir, deps())).alerts.length, 0);
    clock = new Date('2026-11-01T12:00:00Z');
    pages[URL1] = { body: '<button>Add to cart</button>' };
    assert.deepEqual((await scanTrip(dir, deps())).alerts.map((a) => a.kind), ['available']);
    clock = new Date('2026-11-01T14:00:00Z');
    assert.equal((await scanTrip(dir, deps())).alerts.length, 0);
  });

  test('sale-date reminders need no page', async () => {
    await saveWatches(dir, [validateWatch({ id: 'sagrada', title: '聖家堂開賣', url: URL1, kind: 'availability', everyMinutes: 10080, regex: 'x', opensAt: '2026-11-02T08:00:00Z', until: '2026-10-31' }, clock)]);
    assert.deepEqual((await scanTrip(dir, deps())).alerts.map((a) => a.kind), ['opens-soon']);
    assert.equal(hits.length, 0, 'until has passed, so no page was read');
    assert.equal((await scanTrip(dir, deps())).alerts.length, 0);
    clock = new Date('2026-11-02T08:30:00Z');
    assert.deepEqual((await scanTrip(dir, deps())).alerts.map((a) => a.kind), ['opens']);
  });
});

describe('watches read with Chrome (--render)', () => {
  test('a price that only exists after JavaScript ran is found through render, not through a plain fetch', async () => {
    const shell = '<html><body><div id="app"></div><script>/* price is injected later */</script></body></html>';
    pages[URL1] = { body: shell };
    await saveWatches(dir, [watch({ render: true }), watch({ id: 'plain', render: undefined })]);
    const rendered: string[] = [];
    const r = await scanTrip(dir, { ...deps(), render: async (url) => (rendered.push(url), `<html>${offer(95)}</html>`) }, { force: true });
    const by = (id: string) => r.results.find((x) => x.watchId === id)!.sample;
    assert.equal(by('hotel').ok, true);
    assert.equal(by('hotel').amount, 95);
    assert.equal(by('plain').ok, false, 'the plain fetch still sees only the empty shell');
    assert.deepEqual(rendered, [URL1], 'only the render watch goes through Chrome');
    assert.deepEqual(hits, [URL1], 'and it was not downloaded a second time');
  });

  test('says what to do when there is no browser, or when the page is stuck on a consent wall', async () => {
    await saveWatches(dir, [watch({ render: true })]);
    let r = await scanTrip(dir, deps(), { force: true });
    assert.match(r.results[0]!.sample.error!, /Chrome/);
    r = await scanTrip(dir, { ...deps(), render: async () => '<html><body>We use cookies. Accept?</body></html>' }, { force: true });
    assert.match(r.results[0]!.sample.error!, /同意/);
  });

  test('a plain watch that cannot be read suggests --render', async () => {
    pages[URL1] = { body: '<html><body>loading…</body></html>' };
    await saveWatches(dir, [watch()]);
    const r = await scanTrip(dir, deps(), { force: true });
    assert.match(r.results[0]!.sample.error!, /--render/);
  });
});
