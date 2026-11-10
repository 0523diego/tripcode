import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { suggestForTrip } from './food-suggest.ts';
import type { FoodDeps } from './food-service.ts';
import { readFood, updateFood } from './food-store.ts';
import { Throttle } from './osm.ts';
import { foldName, pageMentions, parseSuggestions } from '../src/core/food-suggest.ts';
import { mealFromPlace, putDish, rejectPlace } from '../src/core/food.ts';
import type { Trip } from '../src/core/types.ts';

const NOW = new Date('2026-11-21T10:00:00Z');
const SCALA = { lat: 45.4674, lng: 9.1896 };

const TRIP = {
  id: 'italy',
  title: 'Italy',
  days: [
    {
      date: '2026-11-21',
      city: '米蘭',
      items: [
        { id: 'scala', kind: 'poi', title: 'Teatro alla Scala', start: '10:00', end: '11:30', loc: { ...SCALA, fetchedAt: '2026-11-01T00:00:00Z' } },
        { id: 'dinner', kind: 'meal', title: '晚餐：待選', start: '19:00', end: '20:30' },
      ],
    },
  ],
  candidates: [],
} as unknown as Trip;

const HTML = (body: string) => `<html><head><title>x</title><script>var a="Trattoria Fake";</script></head><body>${body}</body></html>`;

interface Net {
  pages: Record<string, { status?: number; body?: string }>;
  geo: Record<string, { lat: number; lng: number }[]>;
  calls: string[];
}

function setup(net: Net) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tripcode-suggest-'));
  fs.mkdirSync(path.join(root, 'trips', 'italy'), { recursive: true });
  const fetchFake = async (url: string) => {
    net.calls.push(url);
    const u = new URL(url);
    if (u.hostname === 'nominatim.openstreetmap.org') {
      const q = u.searchParams.get('q') ?? '';
      const hits = Object.entries(net.geo).find(([k]) => q.includes(k))?.[1] ?? [];
      return new Response(JSON.stringify(hits.map((h, i) => ({ place_id: i + 1, osm_type: 'node', osm_id: 100 + i, name: q.split(',')[0], display_name: q, lat: String(h.lat), lon: String(h.lng) }))));
    }
    const page = net.pages[url];
    if (!page) throw new Error('offline');
    return new Response(page.body ?? '', { status: page.status ?? 200, headers: { 'content-type': 'text/html' } });
  };
  const deps: FoodDeps = {
    root,
    fetch: fetchFake as never,
    now: () => NOW,
    loadTrip: async () => TRIP,
    throttle: new Throttle({ sleep: async () => undefined }),
    safe: { fetch: fetchFake as never, lookup: async () => ['93.184.216.34'] },
  };
  return { root, deps };
}

const PLACE = {
  name: 'Trattoria Milanese',
  address: 'Via Santa Marta 11, Milano',
  dishes: ['risotto'],
  summary: '老派米蘭小館，招牌是番紅花燉飯和炸小牛排，晚餐客人多是當地人。',
  order: ['Risotto alla milanese', 'Cotoletta'],
  watch: '週日公休',
  sources: ['https://guide.example.com/trattoria-milanese'],
};

test('parseSuggestions: the fixed shape — 1 to 3 places, each with an address, a reason and a page; unknown fields and ratings are refused', () => {
  assert.equal(parseSuggestions([PLACE]).length, 1);
  assert.throws(() => parseSuggestions([]), /至少要有一家/);
  assert.throws(() => parseSuggestions([PLACE, PLACE, PLACE, PLACE]), /最多 3 家/);
  assert.throws(() => parseSuggestions([{ ...PLACE, sources: [] }]), /sources.*至少/);
  assert.throws(() => parseSuggestions([{ ...PLACE, sources: ['http://x.example.com'] }]), /https/);
  assert.throws(() => parseSuggestions([{ ...PLACE, address: undefined }]), /address/);
  assert.throws(() => parseSuggestions([{ ...PLACE, rating: 4.5 }]), /不認得的欄位：rating/);
  assert.throws(() => parseSuggestions([{ ...PLACE, summary: 'Google 4.6 分，很多人推薦' }]), /評分/);
  assert.throws(() => parseSuggestions([{ ...PLACE, summary: '評分很高的老店' }]), /評分/);
  assert.throws(() => parseSuggestions({ ...PLACE }), /陣列/);
});

test('pageMentions: accents, case, punctuation and tags do not matter; a different name does', () => {
  assert.equal(foldName('Trattoria Milanese'), 'trattoriamilanese');
  assert.equal(pageMentions('Welcome to TRATTORIA  MILANESE — since 1933', 'Trattoria Milanese'), true);
  assert.equal(pageMentions('Osteria dell’Oca e Café', 'Osteria dell Oca e Cafe'), true);
  assert.equal(pageMentions('Welcome to Trattoria Romana', 'Trattoria Milanese'), false);
  assert.equal(pageMentions('anything', 'ab'), false, 'a name too short to mean anything proves nothing');
});

test('suggest: a place whose page names it and whose address is on the map becomes a card, with proof and no rating', async () => {
  const net: Net = {
    pages: { 'https://guide.example.com/trattoria-milanese': { body: HTML('<h1>Trattoria <b>Milanese</b></h1><p>Via Santa Marta 11</p>') } },
    geo: { 'Via Santa Marta': [{ lat: 45.4625, lng: 9.1807 }] },
    calls: [],
  };
  const { root, deps } = setup(net);
  await updateFood(root, 'italy', (f) => putDish(f, { id: 'risotto', city: '米蘭', nameZh: '米蘭燉飯', nameLocal: 'Risotto alla milanese', why: '番紅花燉飯', tags: ['pasta'], match: { names: ['risotto'] }, sources: [{ kind: 'ai', fetchedAt: '2026-11-21T10:00:00Z' }] }));
  const out = await suggestForTrip(deps, 'italy', { date: '2026-11-21', slot: 'dinner', places: [PLACE], photos: 'none' });
  assert.equal(out.saved.length, 1);
  assert.equal(out.saved[0]!.tier, 'likely');
  assert.match(out.saved[0]!.checked, /1\/1/);
  assert.equal(out.refused.length, 0);
  const food = await readFood(root, 'italy');
  const place = food.places[0]!;
  assert.match(place.key, /^web-[0-9a-f]{12}$/);
  assert.equal(place.city, '米蘭');
  assert.deepEqual(place.dishes, ['risotto']);
  assert.equal(place.evidence[0]!.kind, 'web');
  assert.equal(place.evidence[0]!.claim, 'exists');
  assert.equal(place.evidence[0]!.source, 'https://guide.example.com/trattoria-milanese');
  assert.match(place.profile!.summary, /番紅花/);
  assert.equal(food.shortlist.length, 1);
  assert.deepEqual([food.shortlist[0]!.date, food.shortlist[0]!.slot, food.shortlist[0]!.anchor], ['2026-11-21', 'dinner', 'Teatro alla Scala']);
  assert.equal(food.shortlist[0]!.items[0]!.open, 'unknown');
  assert.match(food.shortlist[0]!.items[0]!.mapsUrl, /^https:\/\/www\.google\.com\/maps\/search/);
  assert.equal(JSON.stringify(food).includes('rating'), false);
});

test('suggest: the same place suggested again keeps its photo and is not duplicated', async () => {
  const net: Net = { pages: { 'https://guide.example.com/trattoria-milanese': { body: HTML('Trattoria Milanese') } }, geo: { 'Via Santa Marta': [{ lat: 45.4625, lng: 9.1807 }] }, calls: [] };
  const { root, deps } = setup(net);
  await suggestForTrip(deps, 'italy', { date: '2026-11-21', slot: 'dinner', places: [{ ...PLACE, dishes: [] }], photos: 'none' });
  await updateFood(root, 'italy', (f) => ({ ...f, places: f.places.map((p) => ({ ...p, photo: { file: 'attachments/food-0123456789.jpg', pageUrl: 'https://guide.example.com/x', fetchedAt: '2026-11-21T10:00:00Z' } })) }));
  await suggestForTrip(deps, 'italy', { date: '2026-11-21', slot: 'dinner', places: [{ ...PLACE, dishes: [], summary: '改寫過的介紹' }], photos: 'none' });
  const food = await readFood(root, 'italy');
  assert.equal(food.places.length, 1);
  assert.equal(food.places[0]!.profile!.summary, '改寫過的介紹');
  assert.equal(food.places[0]!.photo?.file, 'attachments/food-0123456789.jpg');
});

test('suggest: a restaurant that only the AI remembers is refused — the page is read but the name is not on it', async () => {
  const net: Net = { pages: { 'https://guide.example.com/trattoria-milanese': { body: HTML('<p>Best places in Rome: Trattoria Romana, Da Enzo</p>') } }, geo: { 'Via Santa Marta': [{ lat: 45.4625, lng: 9.1807 }] }, calls: [] };
  const { root, deps } = setup(net);
  await assert.rejects(suggestForTrip(deps, 'italy', { date: '2026-11-21', slot: 'dinner', places: [{ ...PLACE, dishes: [] }], photos: 'none' }), /找不到店名「Trattoria Milanese」/);
  const food = await readFood(root, 'italy');
  assert.deepEqual([food.places.length, food.shortlist.length], [0, 0], 'nothing was written');
});

test('suggest: pages that cannot be read at all still give a card, marked "check it yourself"; one good page makes it likely', async () => {
  const net: Net = { pages: {}, geo: { 'Via Santa Marta': [{ lat: 45.4625, lng: 9.1807 }] }, calls: [] };
  const { deps, root } = setup(net);
  const out = await suggestForTrip(deps, 'italy', { date: '2026-11-21', slot: 'dinner', places: [{ ...PLACE, dishes: [] }], photos: 'none' });
  assert.equal(out.saved[0]!.tier, 'check');
  assert.match(out.saved[0]!.checked, /自己確認/);
  const place = (await readFood(root, 'italy')).places[0]!;
  assert.equal(place.evidence[0]!.confidence, 'reference');

  net.pages['https://other.example.com/a'] = { body: HTML('Trattoria Milanese, Milano') };
  const out2 = await suggestForTrip(deps, 'italy', { date: '2026-11-21', slot: 'dinner', places: [{ ...PLACE, dishes: [], sources: ['https://guide.example.com/trattoria-milanese', 'https://other.example.com/a'] }], photos: 'none' });
  assert.equal(out2.saved[0]!.tier, 'likely');
  assert.match(out2.saved[0]!.checked, /1\/2/);
});

test('suggest: a place that is not on the map near the meal is refused, never pinned somewhere', async () => {
  const net: Net = {
    pages: { 'https://guide.example.com/trattoria-milanese': { body: HTML('Trattoria Milanese') } },
    geo: { 'Via Santa Marta': [{ lat: 41.9, lng: 12.5 }] }, // Rome, 480 km away
    calls: [],
  };
  const { deps } = setup(net);
  await assert.rejects(suggestForTrip(deps, 'italy', { date: '2026-11-21', slot: 'dinner', places: [{ ...PLACE, dishes: [] }], photos: 'none' }), /查不到「Via Santa Marta 11, Milano」/);
  net.geo = {};
  await assert.rejects(suggestForTrip(deps, 'italy', { date: '2026-11-21', slot: 'dinner', places: [{ ...PLACE, dishes: [] }], photos: 'none' }), /查不到/);
});

test('suggest: some places taken, some refused — the answer says which and why', async () => {
  const net: Net = {
    pages: {
      'https://guide.example.com/trattoria-milanese': { body: HTML('Trattoria Milanese') },
      'https://guide.example.com/ghost': { body: HTML('Nothing about it') },
    },
    geo: { 'Via Santa Marta': [{ lat: 45.4625, lng: 9.1807 }], 'Via Fantasma': [{ lat: 45.46, lng: 9.19 }] },
    calls: [],
  };
  const { deps } = setup(net);
  const out = await suggestForTrip(deps, 'italy', {
    date: '2026-11-21',
    slot: 'dinner',
    places: [{ ...PLACE, dishes: [] }, { ...PLACE, name: 'Osteria Fantasma', address: 'Via Fantasma 1, Milano', dishes: [], sources: ['https://guide.example.com/ghost'] }],
    photos: 'none',
  });
  assert.deepEqual(out.saved.map((s) => s.name), ['Trattoria Milanese']);
  assert.equal(out.refused.length, 1);
  assert.match(out.refused[0]!.reason, /Osteria Fantasma/);
});

test('suggest: a place the user said no to is not brought back; dish ids must exist', async () => {
  const net: Net = { pages: { 'https://guide.example.com/trattoria-milanese': { body: HTML('Trattoria Milanese') } }, geo: { 'Via Santa Marta': [{ lat: 45.4625, lng: 9.1807 }] }, calls: [] };
  const { deps, root } = setup(net);
  await assert.rejects(suggestForTrip(deps, 'italy', { date: '2026-11-21', slot: 'dinner', places: [PLACE], photos: 'none' }), /不存在的菜：risotto/);
  await suggestForTrip(deps, 'italy', { date: '2026-11-21', slot: 'dinner', places: [{ ...PLACE, dishes: [] }], photos: 'none' });
  const key = (await readFood(root, 'italy')).places[0]!.key;
  await updateFood(root, 'italy', (f) => rejectPlace(f, key, 'meh', '2026-11-21T10:00:00Z'));
  await assert.rejects(suggestForTrip(deps, 'italy', { date: '2026-11-21', slot: 'dinner', places: [{ ...PLACE, dishes: [] }], photos: 'none' }), /不要這家/);
});

test('mealFromPlace: a web-found place can be chosen by its page proof; a remembered one, or a non-web key with only a page, cannot', async () => {
  const net: Net = { pages: { 'https://guide.example.com/trattoria-milanese': { body: HTML('Trattoria Milanese') } }, geo: { 'Via Santa Marta': [{ lat: 45.4625, lng: 9.1807 }] }, calls: [] };
  const { deps, root } = setup(net);
  await suggestForTrip(deps, 'italy', { date: '2026-11-21', slot: 'dinner', places: [{ ...PLACE, dishes: [] }], photos: 'none' });
  const p = (await readFood(root, 'italy')).places[0]!;
  const chosen = mealFromPlace({ key: p.key, name: p.name, loc: p.loc, dishes: [], evidence: p.evidence }, { slot: 'dinner', now: '2026-11-21T10:05:00Z' });
  assert.equal(chosen.placeId, p.key);
  assert.equal((chosen.checks.exists as { source: string }).source, 'https://guide.example.com/trattoria-milanese');
  assert.equal((chosen.checks.exists as { value: boolean }).value, true);
  assert.throws(() => mealFromPlace({ key: p.key, name: p.name, loc: p.loc, dishes: [], evidence: [{ ...p.evidence[0]!, kind: 'ai-memory' }] }, { now: '2026-11-21T10:05:00Z' }), /證據/);
  assert.throws(() => mealFromPlace({ key: 'osm:node/123', name: p.name, loc: p.loc, dishes: [], evidence: p.evidence }, { now: '2026-11-21T10:05:00Z' }), /證據/);
});
