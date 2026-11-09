import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { GLOBAL_ATTACHMENTS, isUploadRef, MAX_IMAGE_BYTES, saveUpload, servedImage, sniffImage } from './attachments.ts';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const GIF = new TextEncoder().encode('GIF89a\u0001\u0000');
const WEBP = new TextEncoder().encode('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ');

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tripcode-att-'));
  fs.mkdirSync(path.join(root, 'trips', 'rome'), { recursive: true });
  return root;
}

test('sniffImage goes by the bytes, not by any name or claimed type', () => {
  assert.equal(sniffImage(PNG)?.ext, 'png');
  assert.equal(sniffImage(JPG)?.ext, 'jpg');
  assert.equal(sniffImage(GIF)?.ext, 'gif');
  assert.equal(sniffImage(WEBP)?.ext, 'webp');
  assert.equal(sniffImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')), null, 'uploads are never SVG');
  assert.equal(sniffImage(new TextEncoder().encode('<?php echo 1;')), null);
  assert.equal(sniffImage(new Uint8Array()), null);
});

test('saveUpload stores the file under the trip, or the global folder when the trip has no folder', () => {
  const root = tmpRoot();
  const ref = saveUpload(root, 'rome', PNG);
  assert.match(ref, /^trips\/rome\/attachments\/img-[a-z0-9]+-[a-f0-9]{8}\.png$/);
  assert.ok(fs.existsSync(path.join(root, ref)));
  assert.ok(isUploadRef(root, ref));

  const loose = saveUpload(root, 'not-a-trip-yet', JPG);
  assert.ok(loose.startsWith(`${GLOBAL_ATTACHMENTS}/`) && loose.endsWith('.jpg'));
  assert.ok(isUploadRef(root, loose));
  assert.match(saveUpload(root, null, GIF), /\.gif$/);
});

test('saveUpload refuses empty, oversized and non-image bytes', () => {
  const root = tmpRoot();
  assert.throws(() => saveUpload(root, 'rome', new Uint8Array()), /空/);
  assert.throws(() => saveUpload(root, 'rome', new TextEncoder().encode('hello')), /不支援/);
  const big = new Uint8Array(MAX_IMAGE_BYTES + 1);
  big.set(PNG);
  assert.throws(() => saveUpload(root, 'rome', big), /太大/);
  assert.equal(fs.existsSync(path.join(root, 'trips', 'rome', 'attachments')), false, 'nothing was written');
});

test('isUploadRef accepts only paths an upload could have produced, that still exist', () => {
  const root = tmpRoot();
  const ref = saveUpload(root, 'rome', PNG);
  assert.equal(isUploadRef(root, ref), true);
  assert.equal(isUploadRef(root, 'trips/rome/attachments/img-abc-12345678.png'), false, 'well-formed but missing');
  assert.equal(isUploadRef(root, 'trips/rome/trip.ts'), false);
  assert.equal(isUploadRef(root, '/etc/passwd'), false);
  assert.equal(isUploadRef(root, `trips/rome/attachments/../../../${ref}`), false);
  assert.equal(isUploadRef(root, 42), false);
});

test('servedImage: images under trips/<id>/ and the upload folder, nothing else', () => {
  const root = tmpRoot();
  const upload = saveUpload(root, 'rome', PNG);
  fs.writeFileSync(path.join(root, 'trips', 'rome', 'cover.jpg'), JPG);
  fs.mkdirSync(path.join(root, 'trips', 'rome', 'attachments'), { recursive: true });
  fs.writeFileSync(path.join(root, 'trips', 'rome', 'attachments', 'chart.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.writeFileSync(path.join(root, 'trips', 'rome', 'trip.ts'), 'export default {}');
  fs.writeFileSync(path.join(root, 'secret.png'), PNG);
  fs.mkdirSync(path.join(root, 'trips', 'rome', '.hidden'));
  fs.writeFileSync(path.join(root, 'trips', 'rome', '.hidden', 'a.png'), PNG);

  assert.equal(servedImage(root, upload)?.mime, 'image/png');
  assert.equal(servedImage(root, 'trips/rome/cover.jpg')?.mime, 'image/jpeg');
  assert.equal(servedImage(root, 'trips/rome/attachments/chart.svg')?.mime, 'image/svg+xml');
  assert.equal(servedImage(root, 'trips/rome/trip.ts'), null, 'not an image extension');
  assert.equal(servedImage(root, 'secret.png'), null, 'outside trips/');
  assert.equal(servedImage(root, 'trips/rome/../../secret.png'), null);
  assert.equal(servedImage(root, 'trips/rome/.hidden/a.png'), null);
  assert.equal(servedImage(root, 'trips/Rome/cover.jpg'), null, 'trip ids are lower-case');
  assert.equal(servedImage(root, 'trips/rome/attachments\\chart.svg'), null);
  assert.equal(servedImage(root, 'trips/rome/missing.png'), null);
  assert.equal(servedImage(root, 'trips/rome'), null);
  assert.equal(servedImage(root, undefined), null);
  assert.equal(servedImage(root, `${GLOBAL_ATTACHMENTS}/../../../secret.png`), null);
});

test('servedImage does not follow a symlink out of the trip folder', () => {
  const root = tmpRoot();
  const outside = path.join(root, 'outside.png');
  fs.writeFileSync(outside, PNG);
  fs.symlinkSync(outside, path.join(root, 'trips', 'rome', 'link.png'));
  assert.equal(servedImage(root, 'trips/rome/link.png'), null);
});
