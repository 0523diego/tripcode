import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { bodyLimitFor, handleTripcodeRequest, photoRequest } from './vite-plugin-tripcode.ts';
import type { SourceEdits } from './vite-plugin-tripcode.ts';
import * as realEdits from './src/core/source-edit.ts';

const edits = realEdits as unknown as SourceEdits;
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20_000, 7)]);
const HEIC = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(64, 0)]);
const TRIP = `import { defineTrip } from '../../src/core/types.ts';

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
        {
          id: 'latemar',
          kind: 'poi',
          title: 'Latemar 健行',
        },
      ],
    },
  ],
  candidates: [],
});
`;

async function withTrip<T>(fn: (root: string, dir: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'tripcode-photo-ep-'));
  try {
    const dir = path.join(root, 'trips', 'dolo');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'trip.ts'), TRIP);
    return await fn(root, dir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const b64 = (b: Buffer) => b.toString('base64');

test('photo-add stores the upload by its bytes, adds it to the item, and the same picture twice is stored once', async () => {
  await withTrip(async (root, dir) => {
    const r = await handleTripcodeRequest('photo-add', { tripId: 'dolo', itemId: 'latemar', filename: '../../evil name.HEIC', dataBase64: b64(PNG_1X1), caption: '  起點  ' }, { root, edits });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const photo = (r.json as { photo: { file: string; caption: string } }).photo;
    assert.match(photo.file, /^photos\/latemar-[a-f0-9]{10}\.png$/, 'the browser file name is ignored');
    assert.equal(photo.caption, '起點');
    assert.equal(fs.readFileSync(path.join(dir, photo.file)).equals(PNG_1X1), true);
    const src = await readFile(path.join(dir, 'trip.ts'), 'utf8');
    assert.equal(src, TRIP.replace("id: 'latemar',\n", `id: 'latemar',\n          photos: [{ file: '${photo.file}', caption: '起點' }],\n`));
    const again = await handleTripcodeRequest('photo-add', { tripId: 'dolo', itemId: 'latemar', dataBase64: b64(PNG_1X1) }, { root, edits });
    assert.equal((again.json as { added: boolean }).added, false);
    assert.equal(await readFile(path.join(dir, 'trip.ts'), 'utf8'), src);
  });
});

test('photo-add refuses what is not a JPEG/PNG/WebP photo, bad fields and unknown items, and writes nothing', async () => {
  await withTrip(async (root, dir) => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ itemId: 'latemar', dataBase64: b64(HEIC) }, /HEIC/],
      [{ itemId: 'latemar', dataBase64: b64(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')) }, /不是 JPEG、PNG 或 WebP/],
      [{ itemId: 'latemar', dataBase64: 'not base64!' }, /base64/],
      [{ itemId: 'latemar' }, /dataBase64/],
      [{ itemId: 'nope', dataBase64: b64(PNG_1X1) }, /找不到 id/],
      [{ itemId: "x', evil: '", dataBase64: b64(PNG_1X1) }, /無效的 itemId/],
      [{ itemId: 'latemar', dataBase64: b64(PNG_1X1), caption: 'a\nb' }, /換行/],
      [{ itemId: 'latemar', dataBase64: b64(PNG_1X1), caption: 'x'.repeat(121) }, /過長/],
      [{ itemId: 'latemar', dataBase64: b64(PNG_1X1), file: '../trip.ts' }, /無效的 file/],
    ];
    for (const [body, re] of cases) {
      const r = await handleTripcodeRequest('photo-add', { tripId: 'dolo', ...body }, { root, edits });
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match((r.json as { error: string }).error, re, JSON.stringify(body));
    }
    assert.equal((await handleTripcodeRequest('photo-add', { tripId: '../x', itemId: 'latemar', dataBase64: b64(PNG_1X1) }, { root, edits })).status, 400);
    assert.equal(fs.existsSync(path.join(dir, 'photos')), false);
    assert.equal(await readFile(path.join(dir, 'trip.ts'), 'utf8'), TRIP);
    assert.ok(bodyLimitFor('photo-add') > 8 * 1024 * 1024 * 1.33 && bodyLimitFor('photo-fetch') === bodyLimitFor('comment'));
  });
});

test('photo-fetch saves the page picture through the injected safe fetch, records the page as the source, and refuses icons', async () => {
  await withTrip(async (root, dir) => {
    const fetched: string[] = [];
    const safe = {
      lookup: async () => ['93.184.216.34'],
      fetch: async (u: string) => {
        fetched.push(u);
        if (u === 'https://www.latemar.example/route') return new Response('<meta property="og:image" content="https://cdn.latemar.example/route.jpg">');
        if (u === 'https://cdn.latemar.example/route.jpg') return new Response(JPEG);
        if (u === 'https://cdn.latemar.example/icon.png') return new Response(PNG_1X1);
        return new Response('nope', { status: 404 });
      },
    };
    const r = await handleTripcodeRequest('photo-fetch', { tripId: 'dolo', itemId: 'latemar', pageUrl: 'https://www.latemar.example/route', sourceLabel: 'Latemar 官方路線頁', caption: '步道終點（冬季照片）' }, { root, edits, safe });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const photo = (r.json as { photo: { file: string; source: unknown } }).photo;
    assert.deepEqual(photo.source, { url: 'https://www.latemar.example/route', label: 'Latemar 官方路線頁' });
    assert.equal(fs.readFileSync(path.join(dir, photo.file)).equals(JPEG), true);
    assert.match(await readFile(path.join(dir, 'trip.ts'), 'utf8'), /photos: \[\{ file: 'photos\/latemar-[a-f0-9]{10}\.jpg', caption: '步道終點（冬季照片）', source: \{ url: 'https:\/\/www\.latemar\.example\/route', label: 'Latemar 官方路線頁' \} \}\]/);

    const icon = await handleTripcodeRequest('photo-fetch', { tripId: 'dolo', itemId: 'latemar', imageUrl: 'https://cdn.latemar.example/icon.png', sourceLabel: 'x' }, { root, edits, safe });
    assert.equal(icon.status, 422);
    assert.match((icon.json as { error: string }).error, /太小/);
    const before = fetched.length;
    for (const body of [
      { imageUrl: 'https://cdn.latemar.example/route.jpg' },
      { sourceLabel: 'x' },
      { sourceLabel: 'x', pageUrl: 'http://www.latemar.example/route' },
      { sourceLabel: 'x', itemId: 'nope', pageUrl: 'https://www.latemar.example/route' },
    ]) {
      const res = await handleTripcodeRequest('photo-fetch', { tripId: 'dolo', itemId: 'latemar', ...body }, { root, edits, safe });
      assert.ok(res.status === 400 || res.status === 422, JSON.stringify(body));
    }
    assert.equal(fetched.length, before, 'a request that fails its checks never reaches the network');
  });
});

test('photo-remove takes the photo off the item and deletes the file; bad names are refused', async () => {
  await withTrip(async (root, dir) => {
    const add = await handleTripcodeRequest('photo-add', { tripId: 'dolo', itemId: 'latemar', dataBase64: b64(PNG_1X1) }, { root, edits });
    const file = (add.json as { photo: { file: string } }).photo.file;
    for (const photoFile of ['photos/../trip.ts', '../trip.ts', 'tickets/a.pdf', 'photos/x.svg']) {
      const r = await handleTripcodeRequest('photo-remove', { tripId: 'dolo', itemId: 'latemar', photoFile }, { root, edits });
      assert.equal(r.status, 400, photoFile);
    }
    const r = await handleTripcodeRequest('photo-remove', { tripId: 'dolo', itemId: 'latemar', photoFile: file }, { root, edits });
    assert.deepEqual(r.json, { ok: true, deleted: true });
    assert.equal(await readFile(path.join(dir, 'trip.ts'), 'utf8'), TRIP);
    assert.equal(fs.existsSync(path.join(dir, file)), false);
  });
});

test('photoRequest serves only real photo files under trips/<id>/photos/, and 404s everything else under a photos folder', async () => {
  await withTrip(async (root, dir) => {
    await mkdir(path.join(dir, 'photos'), { recursive: true });
    await writeFile(path.join(dir, 'photos', 'latemar-0123456789.jpg'), JPEG);
    await writeFile(path.join(dir, 'secret.jpg'), JPEG);
    await symlink(path.join(dir, 'secret.jpg'), path.join(dir, 'photos', 'link-0123456789.jpg'));
    const ok = photoRequest(root, '/trips/dolo/photos/latemar-0123456789.jpg?v=1');
    assert.deepEqual(ok && { mime: ok.mime, name: path.basename(ok.file) }, { mime: 'image/jpeg', name: 'latemar-0123456789.jpg' });
    for (const url of ['/trips/dolo/photos/', '/trips/dolo/photos', '/trips/dolo/photos/..%2ftrip.ts', '/trips/dolo/photos/missing-0000000000.jpg', '/trips/dolo/photos/x.svg', '/trips/dolo/photos/a/b.jpg', '/trips/Dolo/photos/latemar-0123456789.jpg', '/trips/dolo/photos/link-0123456789.jpg', '/trips/dolo/photos/%6catemar-0123456789.jpg']) {
      assert.equal(photoRequest(root, url), null, url);
    }
    for (const url of ['/trips/dolo/trip.ts', '/trips/dolo/tickets/a.pdf', '/src/main.tsx', '/', undefined]) assert.equal(photoRequest(root, url), undefined, String(url));
  });
});
