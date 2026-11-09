import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fetchPlacePhoto, photoCandidates, pickShareImage } from './food-photo.ts';

// Big enough to count as a photo (an icon or a logo is small).
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20_000, 7)]);
const publicLookup = async () => ['93.184.216.34'];

test('the share picture of a page: og:image first, secure variant preferred, relative addresses resolved, http refused', () => {
  const html = `<html><head>
    <meta property="og:title" content="Chez X">
    <meta content="/img/hero.jpg?a=1&amp;b=2" property="og:image">
    <meta name="twitter:image" content="https://cdn.example.com/t.jpg"></head>`;
  assert.equal(pickShareImage(html, 'https://chezx.example.com/menu'), 'https://chezx.example.com/img/hero.jpg?a=1&b=2');
  assert.equal(pickShareImage('<meta property="og:image" content="http://a.example.com/x.jpg">', 'https://a.example.com/'), undefined);
  assert.equal(pickShareImage('<meta property="og:image" content="http://a.example.com/x.jpg"><meta property="og:image:secure_url" content="https://a.example.com/x.jpg">', 'https://a.example.com/'), 'https://a.example.com/x.jpg');
  assert.equal(pickShareImage('<meta name="twitter:image" content="https://cdn.example.com/t.jpg">', 'https://a.example.com/'), 'https://cdn.example.com/t.jpg');
  assert.equal(pickShareImage('<html>nothing</html>', 'https://a.example.com/'), undefined);
});

test('the photo is saved under the trip, named by its content, only when the bytes really are a picture', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tripcode-photo-'));
  try {
    const fetch = async (u: string) => {
      if (u === 'https://chezx.example.com/') return new Response('<meta property="og:image" content="/hero.jpg">', { status: 200 });
      if (u === 'https://chezx.example.com/hero.jpg') return new Response(JPEG, { status: 200 });
      if (u === 'https://chezx.example.com/fake.jpg') return new Response('<html>not an image</html>', { status: 200 });
      return new Response('nope', { status: 404 });
    };
    const deps = { root, userAgent: 'test', fetch, lookup: publicLookup };
    const r = await fetchPlacePhoto(deps, 'rome', { pageUrl: 'https://chezx.example.com/' });
    assert.match(r.file, /^attachments\/food-[a-f0-9]{10}\.jpg$/);
    assert.equal(r.pageUrl, 'https://chezx.example.com/');
    assert.equal((await readFile(path.join(root, 'trips', 'rome', r.file))).equals(JPEG), true);
    // The same picture again is the same file.
    assert.equal((await fetchPlacePhoto(deps, 'rome', { pageUrl: 'https://chezx.example.com/' })).file, r.file);
    // A page with no picture, or an address that serves HTML instead of a picture, is a plain error.
    await assert.rejects(fetchPlacePhoto({ ...deps, fetch: async () => new Response('<p>hi</p>') }, 'rome', { pageUrl: 'https://chezx.example.com/' }), /找不到可用的照片/);
    await assert.rejects(fetchPlacePhoto(deps, 'rome', { pageUrl: 'https://chezx.example.com/', imageUrl: 'https://chezx.example.com/fake.jpg' }), /不是 PNG、JPEG 或 WebP/);
    // An internal address is refused before anything is fetched.
    await assert.rejects(fetchPlacePhoto(deps, 'rome', { pageUrl: 'https://127.0.0.1/' }), /內部網路/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a page without og:image still offers photos: structured data first, then its own pictures, never logos or icons', () => {
  const html = `<html><head><script type="application/ld+json">{"@type":"Restaurant","image":["https://cdn.example.com/a.jpg","/b.jpg"]}</script></head><body>
    <img src="/img/logo.png" width="400" height="200">
    <img src="/img/tiny.jpg" width="40" height="40">
    <img src="/img/facebook-badge.jpg">
    <img data-src="/lazy/dish.jpg" alt="Notre plat">
    <img src="/small.jpg" srcset="/w400.jpg 400w, /w1600.jpg 1600w">
    <img src="data:image/png;base64,AAAA"><img src="/sprite.svg"><img src="http://insecure.example.com/x.jpg"></body></html>`;
  assert.deepEqual(photoCandidates(html, 'https://r.example.com/fr'), [
    'https://cdn.example.com/a.jpg',
    'https://r.example.com/b.jpg',
    'https://r.example.com/lazy/dish.jpg',
    'https://r.example.com/w1600.jpg',
  ]);
  assert.equal(pickShareImage('<meta property="og:image" content="/og.jpg">' + html, 'https://r.example.com/'), 'https://r.example.com/og.jpg', 'the shared picture comes first');
  assert.deepEqual(photoCandidates('<html></html>', 'https://r.example.com/'), []);
  // A cover set as a CSS background counts too (last), a favicon does not.
  assert.deepEqual(photoCandidates('<style>.hero{background-image:url(https://cdn.example.com/cover.jpg?v=2)} .i{background:url(/favicon-32.jpg)}</style>', 'https://r.example.com/'), ['https://cdn.example.com/cover.jpg']);
});

test('the first candidate that is really a photo is kept: a dead address or a tiny icon is skipped', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tripcode-photo2-'));
  try {
    const small = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(500, 1)]);
    const fetch = async (u: string) => {
      if (u === 'https://r.example.com/') return new Response('<img src="/gone.jpg"><img src="/icon-ish.jpg"><img src="/hero.jpg">', { status: 200 });
      if (u === 'https://r.example.com/icon-ish.jpg') return new Response(small, { status: 200 });
      if (u === 'https://r.example.com/hero.jpg') return new Response(JPEG, { status: 200 });
      return new Response('nope', { status: 404 });
    };
    const r = await fetchPlacePhoto({ root, userAgent: 'test', fetch, lookup: publicLookup }, 'rome', { pageUrl: 'https://r.example.com/' });
    assert.equal(r.imageUrl, 'https://r.example.com/hero.jpg');
    const allTiny = async (u: string) => (u === 'https://r.example.com/' ? new Response('<img src="/a.jpg">', { status: 200 }) : new Response(small, { status: 200 }));
    await assert.rejects(fetchPlacePhoto({ root, userAgent: 'test', fetch: allTiny, lookup: publicLookup }, 'rome', { pageUrl: 'https://r.example.com/' }), /太小/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a JPEG photo beats a PNG logo, and a PNG is used only when there is nothing better (and written only then)', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tripcode-photo3-'));
  try {
    const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(20_000, 3)]);
    const page = '<meta property="og:image" content="/logo-ish.png"><img src="/dish.jpg">';
    const fetch = async (u: string) => (u === 'https://r.example.com/' ? new Response(page) : u.endsWith('.png') ? new Response(PNG) : new Response(JPEG));
    const r = await fetchPlacePhoto({ root, userAgent: 'test', fetch, lookup: publicLookup }, 'rome', { pageUrl: 'https://r.example.com/' });
    assert.match(r.file, /\.jpg$/);
    const onlyPng = async (u: string) => (u === 'https://r.example.com/' ? new Response('<meta property="og:image" content="/a.png">') : new Response(PNG));
    const p = await fetchPlacePhoto({ root, userAgent: 'test', fetch: onlyPng, lookup: publicLookup }, 'rome', { pageUrl: 'https://r.example.com/' });
    assert.match(p.file, /\.png$/);
    const { readdir } = await import('node:fs/promises');
    assert.equal((await readdir(path.join(root, 'trips', 'rome', 'attachments'))).length, 2, 'one file per answer, no leftovers');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
