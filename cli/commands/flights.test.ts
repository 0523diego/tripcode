import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { CliContext } from '../context.ts';
import { run } from '../tripcode.ts';
import { tripFlights } from './flights.ts';
import type { FlightsContext } from './flights.ts';
import type { FetchFn } from '../../src/prices/flights-fetch.ts';
import type { Trip } from '../../src/core/types.ts';

const FIXTURE = fs.readFileSync(new URL('../../src/prices/fixtures/ds1-tpe-bcn.json', import.meta.url), 'utf8');
const PAGE = `<html><script>AF_initDataCallback({key: 'ds:1', hash: '2', data:${FIXTURE}, sideChannel: {}});</script></html>`;

/** The fixture page, moved to the departure day the request asks for (arrival moves with it). */
function pageFor(url: string): string {
  const tfs = new URL(url).searchParams.get('tfs')!;
  const text = Buffer.from(tfs.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('latin1');
  const day = Number(/2027-03-(\d\d)/.exec(text)![1]);
  return PAGE.replace(/\[2027,3,(10|11)\]/g, (_, d: string) => `[2027,3,${day + (d === '11' ? 1 : 0)}]`);
}

const trip: Trip = {
  title: '馬德里測試',
  start: '2027-03-09',
  end: '2027-03-14',
  tz: 'Europe/Madrid',
  party: { adults: 2, childrenAges: [7] },
  days: [
    {
      date: '2027-03-10',
      items: [
        { id: 'out', kind: 'flight', title: '台北 → 巴塞隆納', flightNo: 'EY899', from: 'TPE', to: 'BCN', start: '18:40' },
        { id: 'booked', kind: 'flight', title: '已訂', flightNo: 'CX1', from: 'TPE', to: 'HKG', start: '08:00', booking: { need: 'required', status: 'booked', title: 'x' } as never },
        { id: 'no-codes', kind: 'flight', title: '沒有機場代碼', flightNo: 'CI081', start: '09:00' },
        { id: 'no-time', kind: 'flight', title: '只有到達', flightNo: 'CX233', from: 'HKG', to: 'MXP', end: '14:00' },
        { id: 'poi', kind: 'poi', title: '景點' },
      ],
    },
    { date: '2026-01-01', items: [{ id: 'old', kind: 'flight', title: '過去的', flightNo: 'X1', from: 'TPE', to: 'BCN', start: '10:00' }] },
  ],
  candidates: [],
};

function setup(env: Record<string, string | undefined>, handler: (url: string, n: number) => Response = (url) => new Response(pageFor(url), { status: 200 })) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tripcode-flights-cli-'));
  fs.mkdirSync(path.join(root, 'trips', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(root, 'trips', 'demo', 'trip.ts'), 'export default {}');
  const calls: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const flightsFetch: FetchFn = async (url) => {
    calls.push(url);
    return handler(url, calls.length);
  };
  const ctx: FlightsContext & CliContext = {
    root,
    env,
    fetch: async () => new Response('{}'),
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    now: () => new Date('2026-11-07T10:00:00Z'),
    loadCore: async () => ({}) as never,
    loadTrip: async () => trip,
    flights: { fetch: flightsFetch, sleep: async () => undefined },
  };
  return { ctx, calls, out: () => out.join(''), err: () => err.join(''), root };
}

test('off by default: no request, and the message says how to switch it on', async () => {
  const s = setup({});
  assert.equal(await run(['flights', 'quote', 'TPE', 'BCN', '2027-03-10'], s.ctx), 1);
  assert.match(s.err(), /TRIPCODE_FLIGHTS=1/);
  assert.equal(s.calls.length, 0);
  // Help and status never need it.
  assert.equal(await run(['flights', '--help'], s.ctx), 0);
  assert.match(s.out(), /預設關閉/);
  assert.equal(await run(['flights', 'status'], s.ctx), 0);
  assert.equal(JSON.parse(s.out().slice(s.out().lastIndexOf('{'))).enabled, false);
});

test('quote prints dated JSON with the label, the link, and says what the price means', async () => {
  const s = setup({ TRIPCODE_FLIGHTS: '1' });
  assert.equal(await run(['flights', 'quote', 'tpe', 'bcn', '2027-03-10', '--max', '2'], s.ctx), 0);
  const json = JSON.parse(s.out());
  assert.equal(json.offers.length, 2);
  assert.equal(json.offers[0].price, 28769);
  assert.equal(json.priceMeans, '單程');
  assert.equal(json.label, 'Google 顯示價，訂票前以官方為準');
  assert.match(json.link, /^https:\/\/www\.google\.com\/travel\/flights\?tfs=/);
  assert.equal(json.fromCache, false);
  assert.match(s.err(), /非官方/, 'every run reminds that this is an unofficial read');
  // Same question again: from the cache, no second request.
  const again = setup({ TRIPCODE_FLIGHTS: '1' });
  again.ctx.root = s.root;
  await run(['flights', 'quote', 'TPE', 'BCN', '2027-03-10'], again.ctx);
  assert.equal(JSON.parse(again.out()).fromCache, true);
  assert.equal(again.calls.length, 0);
});

test('quote --return says the price is the whole round trip; --pretty reads well', async () => {
  const s = setup({ TRIPCODE_FLIGHTS: '1' });
  await run(['flights', 'quote', 'TPE', 'BCN', '2027-03-10', '--return', '2027-03-14', '--pretty', '--max', '1'], s.ctx);
  assert.match(s.out(), /來回 2027-03-10 ~ 2027-03-14（價格是整趟來回）/);
  assert.match(s.out(), /TWD 28,769\s+Emirates\s+EK367\+EK187\s+23:00 → 18:55 \+1\s+26h55，轉 1 次（DXB 9h35）/);
  assert.match(s.out(), /Google 顯示價，訂票前以官方為準/);
});

test('bad input is one clear error and no request', async () => {
  for (const argv of [['quote', 'TP', 'BCN', '2027-03-10'], ['quote', 'TPE', 'BCN', '2027-02-30'], ['quote', 'TPE', 'BCN', '2027-03-10', '--stops', '5'], ['quote', 'TPE', 'BCN'], ['quote', 'TPE', 'BCN', '2027-03-10', '--cabin', 'cheap'], ['dates', 'TPE', 'BCN', '--from', '2027-03-01', '--to', '2027-03-31']]) {
    const s = setup({ TRIPCODE_FLIGHTS: '1' });
    assert.equal(await run(['flights', ...argv], s.ctx), 1, argv.join(' '));
    assert.match(s.err(), /錯誤：/);
    assert.equal(s.calls.length, 0);
  }
});

test('a block is reported plainly and exits non-zero', async () => {
  const s = setup({ TRIPCODE_FLIGHTS: '1' }, () => new Response('', { status: 302, headers: { location: 'https://www.google.com/sorry/index' } }));
  assert.equal(await run(['flights', 'quote', 'TPE', 'BCN', '2027-03-10'], s.ctx), 1);
  assert.match(s.err(), /驗證你不是機器人/);
  const again = setup({ TRIPCODE_FLIGHTS: '1' });
  again.ctx.root = s.root;
  assert.equal(await run(['flights', 'quote', 'TPE', 'BCN', '2027-03-11'], again.ctx), 1);
  assert.match(again.err(), /查價暫停/);
  assert.equal(again.calls.length, 0, 'paused: nobody is asked');
  await run(['flights', 'status'], again.ctx);
  assert.equal(JSON.parse(again.out().slice(again.out().lastIndexOf('{\n'))).paused, true);
});

test('dates: a fortnight is sampled, then the days next to the cheapest are filled in; unpriced days are never invented', async () => {
  const s = setup({ TRIPCODE_FLIGHTS: '1' });
  assert.equal(await run(['flights', 'dates', 'TPE', 'BCN', '--from', '2027-03-10', '--to', '2027-03-23'], s.ctx), 0);
  const json = JSON.parse(s.out());
  // Every page costs the same in the fixture, so the cheapest sampled day is the first one: its neighbour (03-11) is added.
  assert.deepEqual(json.results.map((r: { date: string }) => r.date), ['2027-03-10', '2027-03-11', '2027-03-13', '2027-03-16', '2027-03-19', '2027-03-22']);
  assert.equal(s.calls.length, 6);
  assert.ok(s.calls.length <= 7);
  assert.equal(json.checkedDates, 6);
  assert.equal(json.cheapest.price, 28769);
  assert.match(json.note, /沒有推算/);
});

test('trip: quotes only unbooked flights with airports and a departure time; --save writes snapshots, never trip.ts', async () => {
  const flights = tripFlights(trip, { all: false, today: '2026-11-07' });
  assert.deepEqual(flights.map((f) => [f.item.id, f.skip]), [['out', null], ['booked', 'already-booked'], ['no-codes', 'no-airports'], ['no-time', 'departure-date-unknown'], ['old', 'past']]);
  assert.equal(tripFlights(trip, { all: true, today: '2026-11-07' }).find((f) => f.item.id === 'booked')?.skip, null);

  const s = setup({ TRIPCODE_FLIGHTS: '1' });
  const before = fs.readFileSync(path.join(s.root, 'trips', 'demo', 'trip.ts'), 'utf8');
  assert.equal(await run(['flights', 'trip', 'demo', '--save'], s.ctx), 0);
  const json = JSON.parse(s.out());
  const byId = Object.fromEntries(json.flights.map((f: { itemId: string }) => [f.itemId, f]));
  assert.equal(byId.out.status, 'quoted');
  assert.equal(byId.out.snapshot.match, 'same-flight', 'EY899 is in the results, so it is the one quoted');
  assert.equal(byId.out.snapshot.price, 29387);
  assert.deepEqual(byId.out.snapshot.passengers, { adults: 2, children: 1 });
  assert.equal(byId.booked.reason, 'already-booked');
  assert.equal(byId['no-time'].reason, 'departure-date-unknown');
  assert.equal(s.calls.length, 1, 'only the one quotable flight was looked up');
  assert.equal(json.saved, 'trips/demo/prices/flights.json');
  const saved = JSON.parse(fs.readFileSync(path.join(s.root, 'trips', 'demo', 'prices', 'flights.json'), 'utf8'));
  assert.equal(saved.snapshots[0].itemId, 'out');
  assert.equal(saved.snapshots[0].label, 'Google 顯示價，訂票前以官方為準');
  assert.equal(fs.readFileSync(path.join(s.root, 'trips', 'demo', 'trip.ts'), 'utf8'), before, 'trip.ts is untouched');
});
