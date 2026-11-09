import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, readFile, rm, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import * as edits from '../src/core/source-edit.ts';
import { addPhotoBytes, checkPhotoBytes, detectPhoto, fetchWebPhoto, isHeic, photoFileName, PhotoError, removePhotoEntry } from './photo-service.ts';
import { isPhotoFile } from '../src/core/photos.ts';

// Tiny real images: a 1×1 PNG, and a JPEG header padded to look like a photo (the code only reads the magic bytes).
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]), Buffer.alloc(20_000, 7)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0x00, 0x00, 0x00]), Buffer.from('WEBPVP8 '), Buffer.alloc(20_000, 1)]);
const HEIC = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(100, 0)]);
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1');
const publicLookup = async () => ['93.184.216.34'];

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
        { id: 'ridge-hike', kind: 'poi', title: 'Latemar 健行' },
        { id: 'lake', kind: 'poi', title: '湖' },
      ],
    },
  ],
  candidates: [],
});
`;

async function withTrip<T>(fn: (root: string, dir: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'tripcode-photos-'));
  try {
    const dir = path.join(root, 'trips', 'alps-trip');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'trip.ts'), TRIP);
    return await fn(root, dir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('the type comes from the magic bytes only; HEIC, GIF, HTML, empty and oversized files are refused with a reason', () => {
  assert.equal(detectPhoto(PNG_1X1), 'png');
  assert.equal(detectPhoto(JPEG), 'jpg');
  assert.equal(detectPhoto(WEBP), 'webp');
  assert.equal(detectPhoto(GIF), null);
  assert.equal(isHeic(HEIC), true);
  assert.equal(isHeic(JPEG), false);
  assert.equal(checkPhotoBytes(PNG_1X1), 'png');
  assert.throws(() => checkPhotoBytes(HEIC), /HEIC.*JPEG/);
  assert.throws(() => checkPhotoBytes(GIF), /不是 JPEG、PNG 或 WebP/);
  assert.throws(() => checkPhotoBytes(Buffer.from('<html>')), /不是 JPEG/);
  assert.throws(() => checkPhotoBytes(Buffer.alloc(0)), /空的/);
  assert.throws(() => checkPhotoBytes(Buffer.concat([JPEG, Buffer.alloc(8 * 1024 * 1024)])), /太大/);
  assert.throws(() => checkPhotoBytes(PNG_1X1, { web: true }), /太小/, 'a web picture this small is a logo or an icon');
});

test('names are generated from the item and the bytes, never from user input, and always pass the file rule', () => {
  const a = photoFileName('ridge-hike', JPEG, 'jpg');
  assert.match(a, /^photos\/ridge-hike-[a-f0-9]{10}\.jpg$/);
  assert.equal(photoFileName('ridge-hike', JPEG, 'jpg'), a, 'same bytes, same name');
  assert.notEqual(photoFileName('ridge-hike', WEBP, 'webp'), a);
  for (const id of ['Weird_ID', '../../etc', '---', '湖']) assert.equal(isPhotoFile(photoFileName(id, JPEG, 'jpg')), true, id);
  assert.match(photoFileName('湖', JPEG, 'jpg'), /^photos\/photo-/);
});

test('addPhotoBytes writes trips/<id>/photos/<hash name>, edits the plan once, and keeps one copy of the same picture', async () => {
  await withTrip(async (root, dir) => {
    const r = await addPhotoBytes({ root, edits }, { tripId: 'alps-trip', itemId: 'ridge-hike', bytes: JPEG, caption: '步道起點' });
    assert.equal(r.added, true);
    assert.match(r.photo.file, /^photos\/ridge-hike-[a-f0-9]{10}\.jpg$/);
    assert.equal((await readFile(path.join(dir, r.photo.file))).equals(JPEG), true);
    const after = await readFile(path.join(dir, 'trip.ts'), 'utf8');
    assert.equal(after, TRIP.replace("id: 'ridge-hike', ", `id: 'ridge-hike', photos: [{ file: '${r.photo.file}', caption: '步道起點' }], `), 'only the new property, right after the id');

    const again = await addPhotoBytes({ root, edits }, { tripId: 'alps-trip', itemId: 'ridge-hike', bytes: JPEG });
    assert.deepEqual([again.added, again.photo.file], [false, r.photo.file]);
    assert.equal(await readFile(path.join(dir, 'trip.ts'), 'utf8'), after, 'nothing changed');
    assert.equal((await readdir(path.join(dir, 'photos'))).length, 1);
  });
});

test('addPhotoBytes checks everything before writing: unknown item, bad bytes, bad caption or source leave no file behind', async () => {
  await withTrip(async (root, dir) => {
    const bad: [Parameters<typeof addPhotoBytes>[1], RegExp][] = [
      [{ tripId: 'alps-trip', itemId: 'nope', bytes: JPEG }, /找不到 id/],
      [{ tripId: 'alps-trip', itemId: 'lake', bytes: HEIC }, /HEIC/],
      [{ tripId: 'alps-trip', itemId: 'lake', bytes: JPEG, caption: 'a\nb' }, /一行/],
      [{ tripId: 'alps-trip', itemId: 'lake', bytes: JPEG, source: { url: 'http://x.example/', label: 'x' } }, /https/],
      [{ tripId: 'nowhere', itemId: 'lake', bytes: JPEG }, /找不到這個旅程/],
      [{ tripId: '../x', itemId: 'lake', bytes: JPEG }, /無效的 tripId/],
      [{ tripId: 'alps-trip', file: '../trip.ts', itemId: 'lake', bytes: JPEG }, /無效的檔名/],
    ];
    for (const [args, re] of bad) await assert.rejects(addPhotoBytes({ root, edits }, args), (e: unknown) => e instanceof PhotoError && re.test(e.message));
    assert.equal(fs.existsSync(path.join(dir, 'photos')), false);
    assert.equal(await readFile(path.join(dir, 'trip.ts'), 'utf8'), TRIP);
  });
});

test('removePhotoEntry takes the photo off and deletes the file, unless a variant still shows it', async () => {
  await withTrip(async (root, dir) => {
    const { photo } = await addPhotoBytes({ root, edits }, { tripId: 'alps-trip', itemId: 'lake', bytes: PNG_1X1 });
    await writeFile(path.join(dir, 'variant-b.ts'), await readFile(path.join(dir, 'trip.ts'), 'utf8'));
    const first = await removePhotoEntry({ root, edits }, { tripId: 'alps-trip', itemId: 'lake', photoFile: photo.file });
    assert.deepEqual(first, { deleted: false }, 'variant-b.ts still names it');
    assert.equal(await readFile(path.join(dir, 'trip.ts'), 'utf8'), TRIP);
    assert.equal(fs.existsSync(path.join(dir, photo.file)), true);
    const second = await removePhotoEntry({ root, edits }, { tripId: 'alps-trip', file: 'variant-b.ts', itemId: 'lake', photoFile: photo.file });
    assert.deepEqual(second, { deleted: true });
    assert.equal(fs.existsSync(path.join(dir, photo.file)), false);
    await assert.rejects(removePhotoEntry({ root, edits }, { tripId: 'alps-trip', itemId: 'lake', photoFile: 'photos/../trip.ts' }), /無效的照片檔名/);
    await assert.rejects(removePhotoEntry({ root, edits }, { tripId: 'alps-trip', itemId: 'lake', photoFile: photo.file }), /沒有照片/);
  });
});

test('fetchWebPhoto: an image address must be a real, big enough picture; a page gives its share picture; source is the page', async () => {
  const seen: string[] = [];
  const fetch = async (u: string) => {
    seen.push(u);
    if (u === 'https://www.eggental.com/latemar') return new Response('<meta property="og:image" content="/logo.png"><img src="/img/route.jpg" width="1200" height="800">', { status: 200 });
    if (u === 'https://www.eggental.com/logo.png') return new Response(Buffer.concat([PNG_1X1, Buffer.alloc(20_000)]), { status: 200 });
    if (u === 'https://www.eggental.com/img/route.jpg') return new Response(JPEG, { status: 200 });
    if (u === 'https://www.eggental.com/icon.png') return new Response(PNG_1X1, { status: 200 });
    if (u === 'https://www.eggental.com/page.html') return new Response('<html>not a picture</html>', { status: 200 });
    return new Response('nope', { status: 404 });
  };
  const deps = { userAgent: 'test', fetch, lookup: publicLookup };
  const byPage = await fetchWebPhoto(deps, { pageUrl: 'https://www.eggental.com/latemar' });
  assert.deepEqual([byPage.ext, byPage.imageUrl, byPage.sourceUrl], ['jpg', 'https://www.eggental.com/img/route.jpg', 'https://www.eggental.com/latemar'], 'the JPEG photo wins over the PNG logo');
  const byImage = await fetchWebPhoto(deps, { imageUrl: 'https://www.eggental.com/img/route.jpg' });
  assert.equal(byImage.sourceUrl, 'https://www.eggental.com/img/route.jpg', 'without a page the picture itself is the source');
  const both = await fetchWebPhoto(deps, { imageUrl: 'https://www.eggental.com/img/route.jpg', pageUrl: 'https://www.eggental.com/latemar' });
  assert.equal(both.sourceUrl, 'https://www.eggental.com/latemar');

  await assert.rejects(fetchWebPhoto(deps, { imageUrl: 'https://www.eggental.com/icon.png' }), /太小/);
  await assert.rejects(fetchWebPhoto(deps, { imageUrl: 'https://www.eggental.com/page.html' }), /不是 JPEG/);
  await assert.rejects(fetchWebPhoto(deps, { imageUrl: 'http://www.eggental.com/img/route.jpg' }), /https/);
  await assert.rejects(fetchWebPhoto(deps, {}), /imageUrl/);
  await assert.rejects(fetchWebPhoto(deps, { pageUrl: 'https://www.eggental.com/missing' }), /抓不到照片：對方回應 404/);
  const before = seen.length;
  await assert.rejects(fetchWebPhoto(deps, { imageUrl: 'https://127.0.0.1/x.jpg' }), /內部網路/);
  await assert.rejects(fetchWebPhoto({ ...deps, lookup: async () => ['10.0.0.5'] }, { imageUrl: 'https://intranet.example.com/x.jpg' }), /內部網路/);
  assert.equal(seen.length, before, 'a private address is refused before anything is fetched');
});
