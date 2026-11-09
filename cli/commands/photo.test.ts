import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { CliContext } from '../context.ts';
import { run } from '../tripcode.ts';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20_000, 7)]);
const TRIP = `import { defineTrip } from '../../../src/core/types.ts';

export default defineTrip({
  title: 'T',
  start: '2026-06-14',
  end: '2026-06-14',
  tz: 'Europe/Rome',
  party: { adults: 1, childrenAges: [] },
  days: [
    {
      date: '2026-06-14',
      items: [
        { id: 'latemar', kind: 'poi', title: 'Latemar 健行' },
        { id: 'lunch', kind: 'meal', title: '午餐' },
      ],
    },
  ],
  candidates: [],
});
`;

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tripcode-photo-cli-'));
  const dir = path.join(root, 'trips', 'dolo');
  fs.mkdirSync(dir, { recursive: true });
  // loadTrip below evaluates the file without its import line, so the relative types path does not need to exist here.
  fs.writeFileSync(path.join(dir, 'trip.ts'), TRIP);
  const fetched: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CliContext = {
    root,
    env: {},
    fetch: async () => {
      throw new Error('the plain fetch is never used for photos');
    },
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    now: () => new Date('2026-11-09T12:00:00Z'),
    loadCore: async () => ({}) as never,
    loadTrip: async (file) => {
      const src = fs.readFileSync(file, 'utf8').replace(/^import .*$/m, '').replace(/export default defineTrip\(/, 'return (');
      return new Function(src)();
    },
    ...({
      photoFetch: {
        lookup: async () => ['93.184.216.34'],
        fetch: async (u: string) => {
          fetched.push(u);
          if (u === 'https://www.latemar.example/route') return new Response('<meta property="og:image" content="/r.jpg">');
          if (u === 'https://www.latemar.example/r.jpg') return new Response(JPEG);
          return new Response('nope', { status: 404 });
        },
      },
    } as object),
  };
  const go = async (...argv: string[]) => {
    out.length = 0;
    err.length = 0;
    const code = await run(['photo', ...argv], ctx);
    return { code, out: out.join(''), err: err.join('') };
  };
  return { root, dir, go, fetched };
}

test('photo add saves the page picture with its source; list and remove see it; JSON by default', async () => {
  const { root, dir, go, fetched } = setup();
  try {
    const add = await go('add', 'dolo', 'latemar', '--page', 'https://www.latemar.example/route', '--label', 'Latemar 官方路線頁', '--caption', '湖邊（冬季照片）');
    assert.equal(add.code, 0, add.err);
    const r = JSON.parse(add.out);
    assert.equal(r.added, true);
    assert.deepEqual(r.photo.source, { url: 'https://www.latemar.example/route', label: 'Latemar 官方路線頁' });
    assert.equal(r.imageUrl, 'https://www.latemar.example/r.jpg');
    assert.equal(fs.existsSync(path.join(dir, r.photo.file)), true);
    assert.deepEqual(fetched, ['https://www.latemar.example/route', 'https://www.latemar.example/r.jpg']);

    const list = JSON.parse((await go('list', 'dolo')).out);
    assert.deepEqual(list.items.map((i: { itemId: string; photos: unknown[] }) => [i.itemId, i.photos.length]), [['latemar', 1]]);
    assert.deepEqual(JSON.parse((await go('list', 'dolo', '--item', 'lunch')).out).items[0].photos, []);
    assert.match((await go('list', 'dolo', '--pretty')).out, /Latemar 健行（latemar）\n {2}photos\/latemar-[a-f0-9]{10}\.jpg {2}湖邊（冬季照片） {2}來源：Latemar 官方路線頁/);

    const rm = await go('remove', 'dolo', 'latemar', r.photo.file);
    assert.equal(rm.code, 0, rm.err);
    assert.equal(JSON.parse(rm.out).deleted, true);
    assert.equal(fs.readFileSync(path.join(dir, 'trip.ts'), 'utf8'), TRIP);
    assert.equal(fs.existsSync(path.join(dir, r.photo.file)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('photo errors are plain messages with exit code 1, and nothing is written', async () => {
  const { root, dir, go } = setup();
  try {
    const cases: [string[], RegExp][] = [
      [['add', 'dolo', 'latemar', '--page', 'https://www.latemar.example/route'], /用法/],
      [['add', 'dolo', 'latemar', '--label', 'x'], /用法/],
      [['add', 'dolo', 'nope', '--page', 'https://www.latemar.example/route', '--label', 'x'], /找不到 id/],
      [['add', 'dolo', 'latemar', '--page', 'http://www.latemar.example/route', '--label', 'x'], /https/],
      [['add', 'dolo', 'latemar', '--page', 'https://www.latemar.example/gone', '--label', 'x'], /抓不到照片/],
      [['add', 'dolo', 'latemar', '--image', 'https://127.0.0.1/x.jpg', '--label', 'x'], /內部網路/],
      [['remove', 'dolo', 'latemar', 'photos/../trip.ts'], /無效的照片檔名/],
      [['list', 'dolo', '--item', 'nope'], /找不到 id/],
      [['add', '../x', 'latemar'], /無效的 tripId/],
      [['frobnicate'], /未知的子指令/],
      [['add', 'dolo', 'latemar', '--stars', '5'], /未知的選項/],
    ];
    for (const [argv, re] of cases) {
      const r = await go(...argv);
      assert.equal(r.code, 1, argv.join(' '));
      assert.match(r.err, re, argv.join(' '));
    }
    assert.equal(fs.readFileSync(path.join(dir, 'trip.ts'), 'utf8'), TRIP);
    assert.equal(fs.existsSync(path.join(dir, 'photos')), false);
    assert.equal((await go('--help')).code, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
