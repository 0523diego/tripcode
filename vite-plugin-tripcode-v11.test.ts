import assert from 'node:assert/strict';
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, test } from 'node:test';
import { bodyLimitFor, handleTripcodeRequest, sanitizeFilename, slugify } from './vite-plugin-tripcode.ts';
import type { SourceEdits } from './vite-plugin-tripcode.ts';
import * as realEdits from './src/core/source-edit.ts';
import { Throttle } from './cli/osm.ts';
import type { FetchLike } from './cli/google.ts';

const edits = realEdits as unknown as SourceEdits;
const now = () => new Date('2026-05-01T10:00:00.000Z');

function evalTrip(src: string): any {
  const body = src.replace(/^import .*$/m, '').replace(/export default defineTrip\(/, 'return (');
  return new Function(body)();
}

let root: string;
let fetchCalls: { url: string; init: RequestInit }[];
let sleeps: number[];
let clock: number;
let throttle: Throttle;
let env: Record<string, string | undefined>;

const NOMINATIM = [
  { osm_type: 'node', osm_id: 42, lat: '47.0502', lon: '8.3093', name: 'Kapellbrücke', display_name: 'Kapellbrücke, Luzern, Schweiz' },
  { osm_type: 'way', osm_id: 7, lat: '47.1', lon: '8.2', display_name: 'Somewhere, Luzern' },
];
let fetchImpl: FetchLike;

const call = (ep: string, body: unknown) =>
  handleTripcodeRequest(ep, body, { root, edits, now, fetch: (u, i) => fetchImpl(u, i), env, throttle });
const tripPath = () => path.join(root, 'trips', 'tokyo-sample', 'trip.ts');
const read = () => readFile(tripPath(), 'utf8');
const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');

let firstItem: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'tripcode-v11-'));
  await mkdir(path.join(root, 'trips', 'tokyo-sample'), { recursive: true });
  await copyFile(path.join(import.meta.dirname, 'trips', 'tokyo-sample', 'trip.ts'), tripPath());
  const t = evalTrip(await read());
  firstItem = t.days[0].items[0].id;
  fetchCalls = [];
  sleeps = [];
  clock = 1_000_000;
  throttle = new Throttle({ clock: () => clock, sleep: async (ms) => void sleeps.push(ms) });
  env = {};
  fetchImpl = async (url, init) => {
    fetchCalls.push({ url, init: init ?? {} });
    return new Response(JSON.stringify(NOMINATIM), { status: 200 });
  };
});

describe('search', () => {
  test('uses Nominatim with the CLI user agent and maps results', async () => {
    const r = await call('search', { q: 'Kapellbrücke', near: { lat: 47, lng: 8 }, lang: 'zh-TW' });
    assert.equal(r.status, 200);
    assert.ok(r.json.ok);
    assert.equal((r.json as any).source, 'openstreetmap-nominatim');
    assert.equal((r.json as any).fetchedAt, '2026-05-01T10:00:00.000Z');
    assert.deepEqual((r.json as any).results, [
      { name: 'Kapellbrücke', address: 'Kapellbrücke, Luzern, Schweiz', loc: { lat: 47.0502, lng: 8.3093 }, placeId: 'osm:node/42' },
      { name: 'Somewhere', address: 'Somewhere, Luzern', loc: { lat: 47.1, lng: 8.2 }, placeId: 'osm:way/7' },
    ]);
    assert.equal(fetchCalls.length, 1);
    const u = new URL(fetchCalls[0]!.url);
    assert.equal(u.origin, 'https://nominatim.openstreetmap.org');
    assert.equal(u.searchParams.get('q'), 'Kapellbrücke');
    assert.equal(u.searchParams.get('accept-language'), 'zh-TW');
    assert.match(String((fetchCalls[0]!.init.headers as Record<string, string>)['User-Agent']), /^TripCode\/.* \(open-source travel planner; local CLI\)$/);
  });

  test('needs no tripId and honours the 1 req/s throttle', async () => {
    await call('search', { q: 'a' });
    await call('search', { q: 'b' });
    assert.equal(fetchCalls.length, 2);
    assert.deepEqual(sleeps, [1000]);
  });

  test('uses Google Places only when GOOGLE_MAPS_API_KEY is set', async () => {
    env = { GOOGLE_MAPS_API_KEY: 'test-key' };
    fetchImpl = async (url, init) => {
      fetchCalls.push({ url, init: init ?? {} });
      return new Response(JSON.stringify({ places: [{ id: 'g1', displayName: { text: 'Tokyo Tower' }, formattedAddress: 'Tokyo', location: { latitude: 35.6586, longitude: 139.7454 } }] }), { status: 200 });
    };
    const r = await call('search', { q: 'tower' });
    assert.equal(r.status, 200);
    assert.equal((r.json as any).source, 'google-places');
    assert.deepEqual((r.json as any).results, [{ name: 'Tokyo Tower', address: 'Tokyo', loc: { lat: 35.6586, lng: 139.7454 }, placeId: 'g1' }]);
    assert.equal(fetchCalls.length, 1);
    assert.match(fetchCalls[0]!.url, /^https:\/\/places\.googleapis\.com\//);
  });

  test('validates input without calling the network', async () => {
    for (const body of [{}, { q: '' }, { q: '  ' }, { q: 'a\nb' }, { q: 'x'.repeat(301) }, { q: 'a', near: { lat: 91, lng: 0 } }, { q: 'a', near: { lat: 0, lng: 181 } }, { q: 'a', near: 5 }, { q: 'a', lang: 'x y' }, { q: 'a', lang: 3 }]) {
      assert.equal((await call('search', body)).status, 400, JSON.stringify(body));
    }
    assert.equal(fetchCalls.length, 0);
  });

  test('upstream failure is a 502 with a message', async () => {
    fetchImpl = async () => new Response('slow down', { status: 429 });
    const r = await call('search', { q: 'a' });
    assert.equal(r.status, 502);
    assert.equal(r.json.ok, false);
  });
});

describe('add-candidate', () => {
  const body = { tripId: 'tokyo-sample', title: '築地場外市場', loc: { lat: 35.6655, lng: 139.7707 } };

  test('appends an unconfirmed manual candidate', async () => {
    const r = await call('add-candidate', { ...body, placeId: 'osm:node/9' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal((r.json as any).id, slugify('築地場外市場'));
    assert.equal((r.json as any).scheduled, false);
    const t = evalTrip(await read());
    const c = t.candidates.at(-1);
    assert.deepEqual(c, {
      id: slugify('築地場外市場'), title: '築地場外市場', placeId: 'osm:node/9',
      loc: { lat: 35.6655, lng: 139.7707, fetchedAt: '2026-05-01T10:00:00.000Z' }, status: 'unconfirmed', sources: ['manual'],
    });
  });

  test('de-duplicates the id and accepts a valid day', async () => {
    await call('add-candidate', { ...body, title: 'Zzz Park' });
    const r = await call('add-candidate', { ...body, title: 'Zzz Park', day: 1 });
    assert.equal((r.json as any).id, 'zzz-park-2');
    assert.equal((r.json as any).scheduled, true);
    const t = evalTrip(await read());
    assert.equal(t.days[0].items.at(-1).id, 'zzz-park-2');
    assert.ok(!t.candidates.some((c: any) => c.id === 'zzz-park-2'));
    // collides with an existing item id too
    const r3 = await call('add-candidate', { ...body, title: firstItem });
    assert.notEqual((r3.json as any).id, firstItem);
  });

  test('titles with quotes and braces survive', async () => {
    const title = `It's "a" {place} \\ \${x}`;
    assert.equal((await call('add-candidate', { ...body, title })).status, 200);
    assert.equal(evalTrip(await read()).candidates.at(-1).title, title);
  });

  test('validates title, loc, day, placeId, file and tripId', async () => {
    const days = evalTrip(await read()).days.length;
    const bads: any[] = [
      { ...body, title: '' }, { ...body, title: 'x'.repeat(121) }, { ...body, title: 'a\nb' },
      { ...body, loc: undefined }, { ...body, loc: { lat: 91, lng: 0 } }, { ...body, loc: { lat: 0, lng: -181 } }, { ...body, loc: { lat: 'a', lng: 0 } },
      { ...body, day: 0 }, { ...body, day: days + 1 }, { ...body, day: 1.5 }, { ...body, day: '1' },
      { ...body, placeId: 'a\nb' }, { ...body, file: '../trip.ts' }, { ...body, tripId: '../x' },
    ];
    const before = await read();
    for (const bd of bads) assert.equal((await call('add-candidate', bd)).status, 400, JSON.stringify(bd));
    assert.equal(await read(), before);
  });

  test('unknown trip / file report 400', async () => {
    assert.equal((await call('add-candidate', { ...body, tripId: 'nope' })).status, 400);
    assert.equal((await call('add-candidate', { ...body, file: 'missing.ts' })).status, 400);
  });
});

describe('attach / detach', () => {
  const pdf = b64('%PDF-1.4 fake');
  const att = (over: Record<string, unknown> = {}) => ({
    tripId: 'tokyo-sample', itemId: firstItem, label: 'Day pass', kind: 'entry', filename: 'My Ticket (1).PDF', dataBase64: pdf, ...over,
  });
  const ticket = (n: string) => path.join(root, 'trips', 'tokyo-sample', 'tickets', n);

  test('writes a sanitised file and adds the attachment', async () => {
    const r = await call('attach', att());
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual((r.json as any).attachment, { file: 'tickets/my-ticket-1.pdf', label: 'Day pass', kind: 'entry' });
    assert.equal(await readFile(ticket('my-ticket-1.pdf'), 'utf8'), '%PDF-1.4 fake');
    const item = evalTrip(await read()).days[0].items[0];
    assert.deepEqual(item.attachments, [{ file: 'tickets/my-ticket-1.pdf', label: 'Day pass', kind: 'entry' }]);
  });

  test('adds a unique suffix when the name exists', async () => {
    await call('attach', att());
    const r = await call('attach', att({ label: 'Again', kind: undefined }));
    assert.equal((r.json as any).file, 'tickets/my-ticket-1-2.pdf');
    const r3 = await call('attach', att({ label: 'Third' }));
    assert.equal((r3.json as any).file, 'tickets/my-ticket-1-3.pdf');
    assert.deepEqual((await readdir(ticket(''))).sort(), ['my-ticket-1-2.pdf', 'my-ticket-1-3.pdf', 'my-ticket-1.pdf']);
    assert.equal(evalTrip(await read()).days[0].items[0].attachments.length, 3);
  });

  test('rejects bad extensions, names, size, base64 and unknown items; writes nothing', async () => {
    const before = await read();
    const bads: any[] = [
      att({ filename: 'virus.exe' }), att({ filename: 'noext' }), att({ filename: '.pdf.sh' }), att({ filename: '' }),
      att({ dataBase64: '' }), att({ dataBase64: '!!!!' }), att({ dataBase64: 'abc' }), att({ dataBase64: 5 }),
      att({ dataBase64: 'A'.repeat(20 * 1024 * 1024 + 4) }),
      att({ label: '' }), att({ label: 'x'.repeat(121) }), att({ kind: 'weird' }), att({ itemId: 'nope' }), att({ file: '../trip.ts' }),
      att({ tripId: 'nope' }),
    ];
    for (const bd of bads) assert.equal((await call('attach', bd)).status, 400, JSON.stringify(bd).slice(0, 80));
    assert.equal(await read(), before);
    await assert.rejects(access(ticket('virus.exe')));
    await assert.rejects(readdir(ticket('')).then((l) => (l.length ? Promise.resolve() : Promise.reject(new Error('empty')))));
  });

  test('accepts a file at the 15 MB limit and rejects one byte over', async () => {
    const max = 15 * 1024 * 1024;
    assert.equal((await call('attach', att({ filename: 'big.pdf', dataBase64: b64(Buffer.alloc(max, 1)) }))).status, 200);
    assert.equal((await call('attach', att({ filename: 'big2.pdf', dataBase64: b64(Buffer.alloc(max + 1, 1)) }))).status, 400);
  });

  test('traversal in the filename cannot escape tickets/', async () => {
    const r = await call('attach', att({ filename: '../../../evil/../x.png' }));
    assert.equal(r.status, 200);
    assert.equal((r.json as any).file, 'tickets/x.png');
    assert.deepEqual(await readdir(path.join(root, 'trips', 'tokyo-sample')), ['tickets', 'trip.ts']);
  });

  test('detach removes the entry and deletes the file', async () => {
    const a = await call('attach', att());
    const file = (a.json as any).file as string;
    const r = await call('detach', { tripId: 'tokyo-sample', itemId: firstItem, attachmentFile: file });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal((r.json as any).deleted, true);
    assert.equal(evalTrip(await read()).days[0].items[0].attachments, undefined);
    await assert.rejects(access(path.join(root, 'trips', 'tokyo-sample', file)));
  });

  test('detach validates the path and requires an existing entry', async () => {
    await call('attach', att());
    for (const attachmentFile of ['../trip.ts', 'tickets/../trip.ts', 'trip.ts', '/etc/passwd', 'tickets/', 'tickets/a/b.pdf', 5, undefined]) {
      const r = await call('detach', { tripId: 'tokyo-sample', itemId: firstItem, attachmentFile });
      assert.equal(r.status, 400, String(attachmentFile));
    }
    const r = await call('detach', { tripId: 'tokyo-sample', itemId: firstItem, attachmentFile: 'tickets/other.pdf' });
    assert.equal(r.status, 400);
    await access(ticket('my-ticket-1.pdf'));
  });
});

describe('new-trip', () => {
  const body = { tripId: 'kyoto-2027', title: '京都 3 天', start: '2027-04-01', end: '2027-04-03', tz: 'Asia/Tokyo', adults: 2, childrenAges: [5, 8] };

  test('creates the trip folder through the CLI renderers', async () => {
    const r = await call('new-trip', body);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual((r.json as any).files, ['trips/kyoto-2027/trip.ts', 'trips/kyoto-2027/brief.md', 'trips/kyoto-2027/inbox/.gitkeep']);
    const t = evalTrip(await readFile(path.join(root, 'trips', 'kyoto-2027', 'trip.ts'), 'utf8'));
    assert.equal(t.title, '京都 3 天');
    assert.deepEqual(t.days.map((d: any) => d.date), ['2027-04-01', '2027-04-02', '2027-04-03']);
    assert.deepEqual(t.party, { adults: 2, childrenAges: [5, 8] });
    assert.match(await readFile(path.join(root, 'trips', 'kyoto-2027', 'brief.md'), 'utf8'), /2027-04-01 ~ 2027-04-03（3 天/);
  });

  test('defaults adults and refuses to overwrite', async () => {
    const { adults, childrenAges, ...min } = body;
    assert.equal((await call('new-trip', min)).status, 200);
    assert.equal(evalTrip(await readFile(path.join(root, 'trips', 'kyoto-2027', 'trip.ts'), 'utf8')).party.adults, 2);
    const again = await call('new-trip', body);
    assert.equal(again.status, 400);
    assert.match((again.json as any).error, /已存在/);
    assert.equal((await call('new-trip', { ...body, tripId: 'tokyo-sample' })).status, 400);
  });

  test('validates everything and creates nothing', async () => {
    const bads: any[] = [
      { ...body, tripId: '../x' }, { ...body, tripId: 'A' }, { ...body, title: '' }, { ...body, title: 'x'.repeat(121) }, { ...body, title: 'a\nb' },
      { ...body, start: '2027-13-01' }, { ...body, start: undefined }, { ...body, end: '2027-03-01' }, { ...body, end: '2029-04-03' },
      { ...body, tz: 'Not/AZone' }, { ...body, tz: undefined }, { ...body, adults: 0 }, { ...body, adults: '2' },
      { ...body, childrenAges: [18] }, { ...body, childrenAges: 'x' }, { ...body, childrenAges: [1.5] },
    ];
    for (const bd of bads) assert.equal((await call('new-trip', bd)).status, 400, JSON.stringify(bd));
    assert.deepEqual(await readdir(path.join(root, 'trips')), ['tokyo-sample']);
  });
});

describe('helpers', () => {
  test('sanitizeFilename', () => {
    assert.deepEqual(sanitizeFilename('Rigi Day Pass (2).PDF'), { base: 'rigi-day-pass-2', ext: 'pdf' });
    assert.deepEqual(sanitizeFilename('C:\\Users\\me\\ticket.PNG'), { base: 'ticket', ext: 'png' });
    assert.deepEqual(sanitizeFilename('車票.pkpass'), { base: 'ticket', ext: 'pkpass' });
    assert.deepEqual(sanitizeFilename('a_b-c.d.jpeg'), { base: 'a_b-c-d', ext: 'jpeg' });
    assert.throws(() => sanitizeFilename('x.html'));
    assert.throws(() => sanitizeFilename('pdf'));
  });
  test('slugify', () => {
    assert.equal(slugify('Kapellbrücke Luzern'), 'kapellbrucke-luzern');
    // CJK-only titles: stable "place-<hash>", distinct per title.
    assert.match(slugify('築地'), /^place-[a-z0-9]{1,6}$/);
    assert.equal(slugify('築地'), slugify('築地'));
    assert.notEqual(slugify('築地'), slugify('淺草寺'));
    assert.equal(slugify('  A -- B  '), 'a-b');
  });
  test('only attach gets the large body limit', () => {
    assert.equal(bodyLimitFor('comment'), 1_000_000);
    assert.equal(bodyLimitFor('search'), 1_000_000);
    assert.ok(bodyLimitFor('attach') > 20 * 1024 * 1024);
    assert.ok(bodyLimitFor('attach') < 25 * 1024 * 1024);
  });
});
