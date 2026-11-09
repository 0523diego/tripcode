import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { extractDs1, FlightsShapeError, parseFlights } from './flights-parse.ts';
import { buildTfs, deepLink, FlightsInputError, normalizeQuery, searchUrl } from './flights-url.ts';

const NOW = new Date('2026-11-07T10:00:00Z');
const q = (over: Record<string, unknown> = {}) => normalizeQuery({ from: 'tpe', to: 'bcn', date: '2027-03-10', ...over }, NOW);

// A trimmed copy of the `data:` array of a real ds:1 block (TPE→BCN, 2027-03-10). Session tokens are removed. The page
// it came from priced a round trip, so the prices are only data for the parser, not quotes to read anything into.
const FIXTURE = fs.readFileSync(new URL('./fixtures/ds1-tpe-bcn.json', import.meta.url), 'utf8');
const page = (json: string) => `<html><script>AF_initDataCallback({key: 'ds:0', hash: '1', data:[1], sideChannel: {}});</script><script>AF_initDataCallback({key: 'ds:1', hash: '2', data:${json}, sideChannel: {}});</script></html>`;

test('tfs: a one-way economy search for one adult is the exact token Google accepted', () => {
  assert.equal(buildTfs(q()), 'CBwQAhoeEgoyMDI3LTAzLTEwagcIARIDVFBFcgcIARIDQkNOQAFIAXABmAEC');
});

test('tfs: round trip adds the return segment, stops and cabin and passengers are encoded', () => {
  const round = buildTfs(q({ returnDate: '2027-03-14', stops: 1, cabin: 'business', adults: 2, children: 1 }));
  const bytes = Buffer.from(round.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const asText = bytes.toString('latin1');
  assert.ok(asText.includes('2027-03-10') && asText.includes('2027-03-14'));
  // Return segment flips the airports: the second segment starts at BCN.
  assert.ok(asText.indexOf('BCN') < asText.lastIndexOf('TPE'));
  assert.equal(bytes.at(-1), 1, 'trip type 1 = round trip');
  assert.equal(searchUrl(q()), `https://www.google.com/travel/flights?tfs=${buildTfs(q())}&hl=en&curr=TWD`);
  assert.equal(deepLink(q({ currency: 'eur' })), `https://www.google.com/travel/flights?tfs=${buildTfs(q({ currency: 'eur' }))}&hl=zh-TW&curr=EUR`);
});

test('input is validated before it can become part of a URL', () => {
  const bad = (over: Record<string, unknown>, message: RegExp) => assert.throws(() => q(over), (e) => e instanceof FlightsInputError && message.test(e.message));
  bad({ from: 'TP' }, /機場代碼/);
  bad({ to: 'BCN/../x' }, /機場代碼/);
  bad({ to: 'TPE' }, /同一個/);
  bad({ date: '2027-02-30' }, /不是真的日期/);
  bad({ date: '2027/03/10' }, /YYYY-MM-DD/);
  bad({ date: '2026-11-06' }, /已經過了/);
  bad({ date: '2028-03-10' }, /太遠/);
  bad({ returnDate: '2027-03-09' }, /不能早於/);
  bad({ stops: 3 }, /0、1 或 2/);
  bad({ cabin: 'cheap' }, /艙等/);
  bad({ adults: 0 }, /大人/);
  bad({ adults: 8, children: 2 }, /9 位/);
  bad({ currency: 'NT$' }, /幣別/);
  assert.equal(q({ date: '2026-11-07' }).date, '2026-11-07', 'today is fine');
  assert.deepEqual(q({ from: ' tpe ' }).from, 'TPE');
});

test('extractDs1 cuts out the data array, and reports a page without one as null', () => {
  assert.deepEqual(extractDs1(page('[1,[2]]')), [1, [2]]);
  assert.equal(extractDs1('<html>consent page</html>'), null);
  assert.equal(extractDs1("AF_initDataCallback({key: 'ds:1', data:[1,"), null);
  assert.throws(() => extractDs1(page('[1,')), FlightsShapeError);
  assert.throws(() => extractDs1(`${'x'.repeat(6_000_001)}`), FlightsShapeError);
});

test('parseFlights: the offers in the fixture, cheapest first, with a row that has no price counted not guessed', () => {
  const parsed = parseFlights(extractDs1(page(FIXTURE)), q());
  assert.deepEqual(
    parsed.offers.map((o) => o.price),
    [28769, 29387, 32111, 34069, 35261, 35591, 39211],
  );
  assert.equal(parsed.unpriced, 1);
  assert.equal(parsed.other, 0);
  const etihad = parsed.offers.find((o) => o.price === 29387)!;
  assert.deepEqual(etihad, {
    price: 29387,
    airlines: ['Etihad'],
    flightNos: ['EY899', 'EY111'],
    from: 'TPE',
    to: 'BCN',
    departDate: '2027-03-10',
    depart: '18:40',
    arrive: '06:55',
    arriveDayOffset: 1,
    durationMin: 1155,
    stops: 1,
    layovers: [{ airport: 'AUH', minutes: 125 }],
  });
  const multi = parsed.offers.find((o) => o.price === 35591)!;
  assert.deepEqual(multi.airlines, ['Korean Air', 'Asiana Airlines']);
  assert.equal(multi.flightNos[0], 'KE2030');
  const emirates = parsed.offers.find((o) => o.price === 28769)!;
  assert.equal(emirates.depart, '23:00', 'a time with the minutes left out is on the hour');
});

test('parseFlights: a page for another airport or date is an error, not an answer', () => {
  assert.throws(() => parseFlights(extractDs1(page(FIXTURE)), q({ to: 'MAD' })), (e) => e instanceof FlightsShapeError && e.path === 'query');
  assert.throws(() => parseFlights(extractDs1(page(FIXTURE)), q({ date: '2027-03-11' })), FlightsShapeError);
});

test('parseFlights: a page with no flights is an empty answer; a changed layout names the broken position', () => {
  assert.deepEqual(parseFlights([null, null, null, null], q()), { offers: [], unpriced: 0, other: 0 });
  assert.deepEqual(parseFlights([null, null, [[]], [[]]], q()), { offers: [], unpriced: 0, other: 0 });

  const broken = (mutate: (data: any) => void) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const data = JSON.parse(FIXTURE);
    mutate(data);
    return parseFlights(data, q());
  };
  assert.throws(() => broken((d) => (d[2][0][0][0][3] = 'Taipei')), (e) => e instanceof FlightsShapeError && e.path === 'ds:1[2][0][0][0][3]');
  assert.throws(() => broken((d) => (d[2][0][0][1][0][1] = 'cheap')), (e) => e instanceof FlightsShapeError && /\[1\]\[0\]\[1\]/.test(e.path));
  assert.throws(() => broken((d) => (d[2][0][0][0][2] = [])), (e) => e instanceof FlightsShapeError && /\[0\]\[2\]/.test(e.path));
  assert.throws(() => broken((d) => (d[2][0][0][0][5] = [25, 0])), FlightsShapeError);
  assert.throws(() => broken((d) => (d[2] = 'x')), FlightsShapeError);
  assert.throws(() => parseFlights('nope', q()), FlightsShapeError);
});

test('parseFlights: names from the page are reduced to a safe, short form', () => {
  const data = JSON.parse(FIXTURE);
  data[2][0][0][0][1] = ['<img src=x onerror=alert(1)>Evil Air ' + 'x'.repeat(100)];
  const [first] = parseFlights(data, q()).offers.filter((o) => o.airlines[0]?.startsWith('img'));
  assert.ok(first, 'markup characters are dropped, the letters stay');
  assert.ok(!/[<>=]/.test(first.airlines[0]!) && first.airlines[0]!.length <= 40);
});
