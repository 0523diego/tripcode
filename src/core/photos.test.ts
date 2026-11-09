import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkTrip } from './check.ts';
import { isPhotoFile, parsePhoto, photoProblem } from './photos.ts';
import type { Item, Trip } from './types.ts';

test('photo file names: photos/<lowercase>.jpg|png|webp only, never a folder, `..` or another extension', () => {
  for (const ok of ['photos/latemar-0123456789.jpg', 'photos/a.png', 'photos/x_y.z-1.webp']) assert.equal(isPhotoFile(ok), true, ok);
  for (const bad of ['photos/../trip.ts', 'photos/a..b.jpg', 'photos/A.jpg', 'photos/.hidden.jpg', 'photos/x.jpeg', 'photos/x.heic', 'photos/x.svg', 'photos/sub/x.jpg', 'tickets/x.jpg', '/etc/passwd', 'photos/', 'photos/x.jpg ', 3]) {
    assert.equal(isPhotoFile(bad), false, String(bad));
  }
});

test('a photo: optional one-line caption up to 120 characters, an https source with a label, nothing else (no rating)', () => {
  assert.deepEqual(parsePhoto({ file: 'photos/a.jpg' }), { file: 'photos/a.jpg' });
  const full = { file: 'photos/a.jpg', caption: '步道終點的湖（冬季照片）', source: { url: 'https://www.eggental.com/latemar', label: 'Eggental 官方路線頁' } };
  assert.deepEqual(parsePhoto(full), full);
  const cases: [unknown, RegExp][] = [
    [null, /物件/],
    [{ file: 'photos/a.jpg', rating: 5 }, /不認得的欄位：rating/],
    [{ file: 'tickets/a.jpg' }, /檔名/],
    [{ file: 'photos/a.jpg', caption: 'a\nb' }, /一行/],
    [{ file: 'photos/a.jpg', caption: '' }, /非空/],
    [{ file: 'photos/a.jpg', caption: 'x'.repeat(121) }, /120/],
    [{ file: 'photos/a.jpg', source: { url: 'http://example.com/', label: 'x' } }, /https/],
    [{ file: 'photos/a.jpg', source: { url: 'javascript:alert(1)', label: 'x' } }, /https/],
    [{ file: 'photos/a.jpg', source: { url: 'https://example.com/', label: ' ' } }, /名稱/],
    [{ file: 'photos/a.jpg', source: { url: 'https://example.com/', label: 'a\tb' } }, /一行/],
    [{ file: 'photos/a.jpg', source: { url: 'https://example.com/', label: 'x', stars: 4 } }, /stars/],
    [{ file: 'photos/a.jpg', source: 'https://example.com/' }, /url, label/],
  ];
  for (const [p, re] of cases) {
    assert.match(photoProblem(p) ?? '', re, JSON.stringify(p));
    assert.throws(() => parsePhoto(p), re);
  }
});

test('check reports a broken photo as an error on its item, and is quiet about good ones', () => {
  const trip = (photos: unknown): Trip => ({
    title: 'T', start: '2026-06-14', end: '2026-06-14', tz: 'Europe/Zurich', party: { adults: 1, childrenAges: [] }, candidates: [],
    days: [{ date: '2026-06-14', items: [{ id: 'hike', kind: 'poi', title: '健行', photos } as unknown as Item] }],
  });
  assert.deepEqual(checkTrip(trip([{ file: 'photos/a.jpg', caption: '湖', source: { url: 'https://example.com/', label: '官網' } }])), []);
  const bad = checkTrip(trip([{ file: 'photos/a.jpg' }, { file: '../x.jpg' }]));
  assert.deepEqual(bad.map((i) => [i.level, i.code, i.itemId]), [['error', 'photo', 'hike']]);
  assert.match(bad[0]!.message, /健行：照片檔名/);
  assert.deepEqual(checkTrip(trip('photos/a.jpg')).map((i) => i.message), ['健行：photos 必須是陣列']);
});
