import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addPhoto, removePhoto } from './source-edit.ts';

/** Evaluate a trip source (strip the import, turn the default export into a return). */
function evalTrip(src: string): any {
  const body = src.replace(/^import .*$/m, '').replace(/export default defineTrip\(/, 'return (');
  return new Function(body)();
}

const BASE = `import { defineTrip } from '../../src/core/types.ts';

export default defineTrip({
  title: 'Trip',
  start: '2026-06-14',
  end: '2026-06-14',
  tz: 'Europe/Rome',
  party: { adults: 2, childrenAges: [] },
  days: [
    {
      date: '2026-06-14',
      items: [
        {
          id: 'hike',
          kind: 'poi',
          title: 'Latemar 健行',
        },
        { id: 'lake', kind: 'poi', title: '湖', photos: [{ file: 'photos/lake-0000000000.jpg' }] },
        {
          id: 'pass',
          kind: 'poi',
          title: '山口',
          photos: [
            { file: 'photos/pass-1111111111.jpg', caption: '一' },
            { file: 'photos/pass-2222222222.png', source: { url: 'https://example.com/a', label: '官網 {' } }, // second
            { file: 'photos/pass-3333333333.webp' },
          ],
        },
      ],
    },
  ],
  candidates: [],
});
`;

const WEB = { file: 'photos/hike-abcdef0123.jpg', caption: "步道 'Latemar' 終點（冬季照片）", source: { url: 'https://www.eggental.com/latemar?x=1&y=2', label: 'Eggental 官方路線頁' } };

test('addPhoto creates photos on an item without one, with caption and source, touching nothing else', () => {
  const out = addPhoto(BASE, 'hike', WEB);
  assert.deepEqual(evalTrip(out).days[0].items[0].photos, [WEB]);
  assert.ok(out.includes("id: 'hike',\n          photos: [{ file: 'photos/hike-abcdef0123.jpg', caption: "));
  assert.equal(out.replace(/\n {10}photos: \[.*\],/, ''), BASE);
});

test('addPhoto appends to an inline and to a multi-line array', () => {
  const o1 = addPhoto(BASE, 'lake', { file: 'photos/lake-9999999999.png' });
  assert.deepEqual(evalTrip(o1).days[0].items[1].photos.map((x: any) => x.file), ['photos/lake-0000000000.jpg', 'photos/lake-9999999999.png']);
  assert.ok(o1.includes("photos: [{ file: 'photos/lake-0000000000.jpg' }, { file: 'photos/lake-9999999999.png' }] }"), 'a one-line array stays one tidy line');
  const o2 = addPhoto(BASE, 'pass', { file: 'photos/pass-4444444444.jpg', caption: '四' });
  const list = evalTrip(o2).days[0].items[2].photos;
  assert.equal(list.length, 4);
  assert.deepEqual(list[3], { file: 'photos/pass-4444444444.jpg', caption: '四' });
  assert.ok(o2.includes("{ file: 'photos/pass-3333333333.webp' },\n            { file: 'photos/pass-4444444444.jpg'"));
});

test('addPhoto refuses unknown items, duplicates and anything that is not a valid Photo', () => {
  assert.throws(() => addPhoto(BASE, 'nope', { file: 'photos/a.jpg' }), /nope/);
  assert.throws(() => addPhoto(BASE, 'lake', { file: 'photos/lake-0000000000.jpg' }), /已在這個項目/);
  assert.throws(() => addPhoto(BASE, 'hike', { file: 'photos/../trip.ts' }), /檔名/);
  assert.throws(() => addPhoto(BASE, 'hike', { file: 'photos/a.jpg', caption: 'a\nb' }), /一行/);
  assert.throws(() => addPhoto(BASE, 'hike', { file: 'photos/a.jpg', source: { url: 'http://x.example/', label: 'x' } }), /https/);
  assert.throws(() => addPhoto(BASE, 'hike', { file: 'photos/a.jpg', rating: 5 } as never), /rating/);
});

test('removePhoto removes one entry and keeps the others byte for byte', () => {
  const out = removePhoto(BASE, 'pass', 'photos/pass-2222222222.png');
  assert.deepEqual(evalTrip(out).days[0].items[2].photos.map((x: any) => x.file), ['photos/pass-1111111111.jpg', 'photos/pass-3333333333.webp']);
  assert.equal(out, BASE.replace("            { file: 'photos/pass-2222222222.png', source: { url: 'https://example.com/a', label: '官網 {' } }, // second\n", ''));
  assert.equal(evalTrip(removePhoto(BASE, 'pass', 'photos/pass-1111111111.jpg')).days[0].items[2].photos.length, 2);
  assert.equal(evalTrip(removePhoto(BASE, 'pass', 'photos/pass-3333333333.webp')).days[0].items[2].photos.length, 2);
});

test('removePhoto drops photos when it was the last one, errors on what is not there, and round-trips with addPhoto', () => {
  const out = removePhoto(BASE, 'lake', 'photos/lake-0000000000.jpg');
  assert.equal(evalTrip(out).days[0].items[1].photos, undefined);
  assert.ok(out.includes("{ id: 'lake', kind: 'poi', title: '湖' }"));
  assert.throws(() => removePhoto(BASE, 'nope', 'photos/x.jpg'), /nope/);
  assert.throws(() => removePhoto(BASE, 'hike', 'photos/x.jpg'), /沒有照片/);
  assert.throws(() => removePhoto(BASE, 'pass', 'photos/zzz.jpg'), /沒有照片「photos\/zzz.jpg」/);
  assert.equal(removePhoto(addPhoto(BASE, 'hike', WEB), 'hike', WEB.file), BASE);
});
