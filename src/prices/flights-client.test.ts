import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createFlightsClient, dateRange, firstPass, MAX_DATES, neighbours } from './flights-client.ts';
import type { DatePrice } from './flights-client.ts';
import { fetchPage, FlightsFetchError, MAX_BODY_BYTES, USER_AGENT } from './flights-fetch.ts';
import type { FetchFn } from './flights-fetch.ts';
import { FlightsShapeError } from './flights-parse.ts';
import { readSnapshots, readState, saveSnapshots, SNAPSHOT_LABEL, snapshotFrom } from './flights-store.ts';
import { FlightsInputError, normalizeQuery } from './flights-url.ts';

const FIXTURE = fs.readFileSync(new URL('./fixtures/ds1-tpe-bcn.json', import.meta.url), 'utf8');
const PAGE = `<html><script>AF_initDataCallback({key: 'ds:1', hash: '2', data:${FIXTURE}, sideChannel: {}});</script></html>`;
const NO_DATA = '<html><script>AF_initDataCallback({key: \'ds:0\', hash: \'1\', data:[1], sideChannel: {}});</script></html>';
const START = Date.parse('2026-11-07T10:00:00Z');
const QUERY = { from: 'TPE', to: 'BCN', date: '2027-03-10' };

const ok = (body: string) => new Response(body, { status: 200 });

/** The fixture page, as if it had been fetched for another departure day (arrival moves with it). */
function pageForDay(day: number): string {
  return PAGE.replace(/\[2027,3,(10|11)\]/g, (_, d: string) => `[2027,3,${day + (d === '11' ? 1 : 0)}]`);
}
/** The departure date a request asks for, read back out of its tfs token. */
function dayOfUrl(url: string): number {
  const tfs = new URL(url).searchParams.get('tfs')!;
  return Number(/2027-03-(\d\d)/.exec(Buffer.from(tfs.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('latin1'))![1]);
}
const pageFor = (url: string) => ok(pageForDay(dayOfUrl(url)));
const redirect = (location: string, status = 302) => new Response(null, { status, headers: { location } });

function harness(handler: (url: string, n: number) => Response | Promise<Response>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tripcode-flights-'));
  const calls: { url: string; headers: Record<string, string> }[] = [];
  let clock = START;
  const sleeps: number[] = [];
  const fetch: FetchFn = async (url, init) => {
    calls.push({ url, headers: init.headers });
    return handler(url, calls.length);
  };
  const client = createFlightsClient({
    root,
    fetch,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
  });
  return { root, calls, sleeps, client, advance: (ms: number) => (clock += ms), now: () => clock };
}

// ---------- fetchPage ----------

test('fetchPage sends a browser-style user agent, no cookies, and follows Google\'s own consent hop', async () => {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    seen.push({ url, headers: init.headers });
    if (seen.length === 1) return redirect('https://consent.google.com/m?continue=x');
    if (seen.length === 2) return redirect('https://www.google.com/travel/flights?tfs=abc&ucbcb=1', 303);
    return ok('<html>page</html>');
  };
  assert.equal(await fetchPage('https://www.google.com/travel/flights?tfs=abc', fetchFn), '<html>page</html>');
  assert.equal(seen.length, 3);
  for (const call of seen) {
    assert.equal(call.headers['user-agent'], USER_AGENT);
    assert.ok(USER_AGENT.startsWith('Mozilla/5.0') && USER_AGENT.endsWith('tripcode/0.1'));
    assert.equal(call.headers.cookie, undefined, 'no cookie is ever sent');
  }
});

test('fetchPage stops on a redirect to any other host, scheme or port', async () => {
  for (const target of ['https://evil.example/x', 'http://www.google.com/x', 'https://www.google.com:8443/x', 'https://www.google.com.evil.example/x', 'https://accounts.google.com/x']) {
    let n = 0;
    const fetchFn: FetchFn = async () => (++n === 1 ? redirect(target) : ok('should not be reached'));
    await assert.rejects(fetchPage('https://www.google.com/travel/flights', fetchFn), (e) => e instanceof FlightsFetchError && e.code === 'redirect-offsite', target);
    assert.equal(n, 1, `no second request to ${target}`);
  }
  await assert.rejects(fetchPage('https://example.com/', async () => ok('x')), (e) => e instanceof FlightsFetchError && e.code === 'redirect-offsite');
});

test('fetchPage names every way Google can say no', async () => {
  const code = async (fetchFn: FetchFn) => {
    try {
      await fetchPage('https://www.google.com/travel/flights', fetchFn);
      return 'none';
    } catch (e) {
      return e instanceof FlightsFetchError ? e.code : `other:${e}`;
    }
  };
  assert.equal(await code(async () => redirect('/travel/flights/unsupported?x=1')), 'unsupported-client');
  assert.equal(await code(async () => redirect('https://www.google.com/sorry/index?continue=x')), 'blocked');
  assert.equal(await code(async () => new Response('slow down', { status: 429 })), 'blocked');
  assert.equal(await code(async () => new Response('err', { status: 503 })), 'http');
  assert.equal(await code(async () => new Response(null, { status: 302 })), 'http');
  assert.equal(
    await code(async (url) => (url.includes('consent') ? ok('<html>please agree</html>') : redirect('https://consent.google.com/m'))),
    'consent-required',
    'the consent page itself is never clicked through',
  );
  assert.equal(await code(async () => { throw new TypeError('fetch failed'); }), 'network');
  assert.equal(await code(async () => { throw new DOMException('timed out', 'TimeoutError'); }), 'timeout');
  assert.equal(await code(async () => new Response(new Uint8Array(MAX_BODY_BYTES + 10), { status: 200 })), 'too-large');
  let hops = 0;
  assert.equal(await code(async () => redirect(`/travel/flights?n=${++hops}`)), 'http', 'a redirect loop ends');
});

// ---------- the client ----------

test('quote: parses the page, then answers the same question from the cache without another request', async () => {
  const h = harness(() => ok(PAGE));
  const first = await h.client.quote(QUERY);
  assert.equal(first.fromCache, false);
  assert.equal(first.offers[0]?.price, 28769);
  assert.equal(first.queriedAt, new Date(START).toISOString());
  assert.match(first.link, /^https:\/\/www\.google\.com\/travel\/flights\?tfs=.+&hl=zh-TW&curr=TWD$/);
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0]!.url, /&hl=en&curr=TWD$/);

  h.advance(60 * 60 * 1000);
  const again = await h.client.quote(QUERY);
  assert.equal(again.fromCache, true);
  assert.deepEqual(again.offers, first.offers);
  assert.equal(h.calls.length, 1, 'nothing was fetched');

  const forced = await h.client.quote(QUERY, { fresh: true });
  assert.equal(forced.fromCache, false);
  assert.equal(h.calls.length, 2);

  h.advance(25 * 60 * 60 * 1000);
  assert.equal((await h.client.quote(QUERY)).fromCache, false, 'older than 24 h is asked again');
});

test('quote: waits so that two requests are never closer than 2 s, even across runs', async () => {
  const h = harness((url) => pageFor(url));
  await h.client.quote(QUERY);
  await h.client.quote({ ...QUERY, date: '2027-03-11' });
  assert.deepEqual(h.sleeps, [2000]);
});

test('quote: a page without its data block is retried once, then reported as no-data', async () => {
  const flaky = harness((_, n) => ok(n === 1 ? NO_DATA : PAGE));
  assert.equal((await flaky.client.quote(QUERY)).offers.length, 7);
  assert.equal(flaky.calls.length, 2);

  const dead = harness(() => ok(NO_DATA));
  await assert.rejects(dead.client.quote(QUERY), (e) => e instanceof FlightsFetchError && e.code === 'no-data');
  assert.equal(dead.calls.length, 2, 'one retry, not more');
});

test('circuit breaker: three failures in a row pause for an hour; a block pauses for a day', async () => {
  const soft = harness(() => new Response('err', { status: 500 }));
  for (let i = 0; i < 3; i++) await assert.rejects(soft.client.quote({ ...QUERY, date: `2027-03-1${i}` }), (e) => e instanceof FlightsFetchError && e.code === 'http');
  assert.equal(soft.calls.length, 3);
  await assert.rejects(soft.client.quote({ ...QUERY, date: '2027-03-15' }), (e) => e instanceof FlightsFetchError && e.code === 'breaker-open');
  assert.equal(soft.calls.length, 3, 'the fourth asks nobody');
  soft.advance(61 * 60 * 1000);
  await assert.rejects(soft.client.quote({ ...QUERY, date: '2027-03-15' }), (e) => e instanceof FlightsFetchError && e.code === 'http');
  assert.equal(soft.calls.length, 4, 'after the pause it tries again');

  const hard = harness(() => redirect('https://www.google.com/sorry/index'));
  await assert.rejects(hard.client.quote(QUERY), (e) => e instanceof FlightsFetchError && e.code === 'blocked');
  hard.advance(23 * 60 * 60 * 1000);
  await assert.rejects(hard.client.quote({ ...QUERY, date: '2027-03-11' }), (e) => e instanceof FlightsFetchError && e.code === 'breaker-open');
  hard.advance(2 * 60 * 60 * 1000);
  await assert.rejects(hard.client.quote({ ...QUERY, date: '2027-03-11' }), (e) => e instanceof FlightsFetchError && e.code === 'blocked');
  assert.equal(hard.calls.length, 2);
});

test('a success clears the failure count; bad input and a changed layout are told apart', async () => {
  let mode: 'err' | 'ok' | 'shape' = 'err';
  const shaped = PAGE.replace('"TPE"', '"Taipei"');
  const h = harness((url) => (mode === 'err' ? new Response('x', { status: 500 }) : mode === 'ok' ? pageFor(url) : ok(shaped)));
  await assert.rejects(h.client.quote(QUERY));
  await assert.rejects(h.client.quote({ ...QUERY, date: '2027-03-11' }));
  assert.equal(readState(h.root).failures, 2);
  mode = 'ok';
  await h.client.quote({ ...QUERY, date: '2027-03-12' });
  assert.equal(readState(h.root).failures, 0);

  // Invalid input is the caller's mistake: no request, and the breaker is not touched.
  const before = h.calls.length;
  await assert.rejects(h.client.quote({ ...QUERY, from: 'TP' }), FlightsInputError);
  assert.equal(h.calls.length, before);
  assert.equal(readState(h.root).failures, 0);

  mode = 'shape';
  await assert.rejects(h.client.quote({ ...QUERY, date: '2027-03-13' }), (e) => e instanceof FlightsShapeError);
  assert.equal(readState(h.root).failures, 1, 'a changed layout counts as a failure');
});

test('pricesFor: one request per date, a failure ends the sweep', async () => {
  const h = harness((url, n) => (n === 3 ? new Response('x', { status: 500 }) : pageFor(url)));
  const out = await h.client.pricesFor({ from: 'TPE', to: 'BCN' }, ['2027-03-10', '2027-03-11', '2027-03-12', '2027-03-13']);
  assert.equal(out.length, 3, 'stopped after the HTTP failure');
  assert.equal(out[0]?.cheapest?.price, 28769);
  assert.equal(out[1]?.cheapest?.price, 28769);
  assert.ok(out[2]?.error);
});

// ---------- finding the cheapest day ----------

test('dateRange is inclusive and capped; firstPass samples long ranges; neighbours refines around the cheapest', () => {
  assert.deepEqual(dateRange('2027-03-30', '2027-04-02'), ['2027-03-30', '2027-03-31', '2027-04-01', '2027-04-02']);
  assert.throws(() => dateRange('2027-03-10', '2027-03-09'), /不能早於/);
  assert.throws(() => dateRange('2027-03-01', '2027-03-31'), new RegExp(`最多比較 ${MAX_DATES}`));

  const week = dateRange('2027-03-10', '2027-03-16');
  assert.deepEqual(firstPass(week), week, 'a week or less: every day');
  const fortnight = dateRange('2027-03-10', '2027-03-23');
  assert.deepEqual(firstPass(fortnight), ['2027-03-10', '2027-03-13', '2027-03-16', '2027-03-19', '2027-03-22']);

  const price = (date: string, p: number | null): DatePrice => ({ date, cheapest: p === null ? null : ({ price: p } as DatePrice['cheapest']) });
  const priced = [price('2027-03-10', 500), price('2027-03-13', 300), price('2027-03-16', 450)];
  assert.deepEqual(neighbours(fortnight, priced), ['2027-03-12', '2027-03-14']);
  assert.deepEqual(neighbours(fortnight, [price('2027-03-10', 100), price('2027-03-13', 300)]), ['2027-03-11'], 'at the edge only the inner side');
  assert.deepEqual(neighbours(fortnight, [price('2027-03-10', null)]), []);
  assert.ok(firstPass(fortnight).length + 2 <= 7, 'a fortnight costs at most 7 requests');
});

// ---------- snapshots ----------

test('snapshots: dated, labelled, one search keeps its newest five', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tripcode-snap-'));
  const q = normalizeQuery({ ...QUERY, adults: 2 }, new Date(START));
  const offer = {
    price: 28769, airlines: ['Emirates'], flightNos: ['EK367', 'EK187'], from: 'TPE', to: 'BCN', departDate: '2027-03-10', depart: '23:00', arrive: '18:55',
    arriveDayOffset: 1, durationMin: 1615, stops: 1, layovers: [{ airport: 'DXB', minutes: 575 }],
  };
  for (let i = 0; i < 7; i++) {
    saveSnapshots(root, 'rome', [snapshotFrom({ ...offer, price: 28769 + i }, q, { queriedAt: new Date(START + i * 60_000).toISOString(), link: 'https://www.google.com/travel/flights?tfs=x', match: 'cheapest' })]);
  }
  saveSnapshots(root, 'rome', [snapshotFrom(offer, q, { queriedAt: new Date(START).toISOString(), link: 'l', match: 'same-flight', itemId: 'flight-out' })]);
  const all = readSnapshots(root, 'rome');
  assert.equal(all.length, 6, 'five for the plain search, one for the item');
  const plain = all.filter((s) => !s.itemId);
  assert.deepEqual(plain.map((s) => s.price), [28771, 28772, 28773, 28774, 28775].map((n) => n + 1).slice(0, 4).concat([28775]).slice(0, 5).map((_, i) => 28771 + i));
  assert.equal(all[0]?.label, SNAPSHOT_LABEL);
  assert.deepEqual(all.find((s) => s.itemId)?.layovers, ['DXB']);
  assert.deepEqual(all[0]?.passengers, { adults: 2, children: 0 });
});
