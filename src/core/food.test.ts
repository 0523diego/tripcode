import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FoodError, putListings, addAttribution, addEvidence, aiOnly, dishSearchUrl, emptyFood, parseDish, parseFood, putDish, putPlace, rejectPlace, removeDish, setTaste, visibleDishes, voteDish } from './food.ts';

const AT = '2026-11-07T12:00:00Z';
const wv = { kind: 'wikivoyage', url: 'https://en.wikivoyage.org/wiki/Rome', title: 'Rome', revision: '4567', fetchedAt: AT };
const dish = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  city: '羅馬',
  nameZh: id,
  nameLocal: id.toUpperCase(),
  why: '羅馬人會點的一道',
  tags: [],
  match: { names: [id] },
  sources: [wv],
  ...over,
});
const place = (key: string, over: Record<string, unknown> = {}) => ({ key, name: `店 ${key}`, loc: { lat: 41.89, lng: 12.49, fetchedAt: AT }, city: '羅馬', dishes: [], evidence: [], ...over });

test('an empty file is valid and parseFood rejects unknown keys and a wrong version', () => {
  assert.deepEqual(parseFood(emptyFood()), emptyFood());
  assert.throws(() => parseFood({ ...emptyFood(), typo: 1 }), /不認得的欄位：typo/);
  assert.throws(() => parseFood({ ...emptyFood(), version: 2 }), /version/);
  assert.throws(() => parseFood(null), FoodError);
});

test('a dish needs a source; the AI\'s own memory has no URL; every other source has an https one', () => {
  assert.throws(() => parseDish(dish('x', { sources: [] })), /至少要有一個來源/);
  assert.throws(() => parseDish(dish('x', { sources: [{ kind: 'ai', url: 'https://x.test/', fetchedAt: AT }] })), /不能附網址/);
  assert.throws(() => parseDish(dish('x', { sources: [{ kind: 'web', fetchedAt: AT }] })), /一定要有網址/);
  assert.throws(() => parseDish(dish('x', { sources: [{ kind: 'web', url: 'http://x.test/', fetchedAt: AT }] })), /只接受 https/);
  assert.throws(() => parseDish(dish('x', { sources: [{ kind: 'web', url: 'javascript:alert(1)', fetchedAt: AT }] })), FoodError);
  assert.throws(() => parseDish(dish('X Y')), /小寫英數/);
  assert.throws(() => parseDish(dish('x', { tags: ['Pork'] })), /標籤/);
  assert.throws(() => parseDish(dish('x', { why: '' })), /要有內容/);
  assert.doesNotThrow(() => parseDish(dish('x', { sources: [{ kind: 'ai', fetchedAt: AT }] })));
  assert.equal(aiOnly(parseDish(dish('x', { sources: [{ kind: 'ai', fetchedAt: AT }] }))), true);
  assert.equal(aiOnly(parseDish(dish('x'))), false);
});

test('operations return new files, replace by id, and keep everything consistent', () => {
  const a = emptyFood();
  const b = putDish(putDish(a, dish('carbonara', { tags: ['pork'] })), dish('amatriciana'));
  assert.equal(a.dishes.length, 0, 'the input is never changed');
  assert.deepEqual(b.dishes.map((d) => d.id), ['carbonara', 'amatriciana']);
  assert.equal(putDish(b, dish('carbonara', { why: '改過的理由' })).dishes[0]!.why, '改過的理由');
  assert.equal(putDish(b, dish('carbonara', { why: '改過的理由' })).dishes.length, 2);
  const voted = voteDish(b, 'carbonara', 'want');
  assert.deepEqual(voted.votes, { carbonara: 'want' });
  assert.deepEqual(voteDish(voted, 'carbonara', 'clear').votes, {});
  assert.throws(() => voteDish(b, 'nope', 'want'), /找不到菜/);
  // Removing a dish removes what refers to it.
  const withPlace = putPlace(voteDish(b, 'amatriciana', 'no'), place('osm:node/1', { dishes: ['amatriciana', 'carbonara'] }));
  const without = removeDish(setTaste(withPlace, { avoidDishes: ['amatriciana'] }), 'amatriciana');
  assert.deepEqual([without.votes, without.places[0]!.dishes, without.taste.avoidDishes], [{}, ['carbonara'], []]);
  assert.throws(() => putPlace(b, place('osm:node/2', { dishes: ['unknown-dish'] })), /不存在的菜/);
});

test('evidence: an address is required for the kinds a reader must be able to check; the same claim from the same source is replaced', () => {
  const base = putPlace(emptyFood(), place('osm:node/1'));
  const osm = { kind: 'map-osm', claim: 'exists', source: 'osm:node/1', fetchedAt: AT, confidence: 'recent', detail: 'OSM 資料檢查日 2026-09-23' };
  const once = addEvidence(base, 'osm:node/1', osm);
  assert.equal(once.places[0]!.evidence.length, 1);
  assert.equal(addEvidence(once, 'osm:node/1', { ...osm, detail: '更新' }).places[0]!.evidence.length, 1);
  assert.throws(() => addEvidence(base, 'osm:node/1', { kind: 'web', claim: 'recommended', source: 'a blog I read', fetchedAt: AT, confidence: 'recent' }), /https 網址/);
  assert.throws(() => addEvidence(base, 'osm:node/1', { kind: 'michelin', claim: 'recommended', source: 'michelin', fetchedAt: AT, confidence: 'recent' }), /https 網址/);
  assert.doesNotThrow(() => addEvidence(base, 'osm:node/1', { kind: 'web', claim: 'recommended', source: 'https://example.com/guide', fetchedAt: AT, confidence: 'recent', detail: '文章推薦' }));
  assert.throws(() => addEvidence(base, 'osm:node/404', osm), /找不到店/);
  assert.throws(() => addEvidence(base, 'osm:node/1', { ...osm, detail: 'x'.repeat(81) }), /不超過 80/);
  assert.throws(() => addEvidence(base, 'osm:node/1', { ...osm, rating: 4.7 }), /不認得的欄位：rating/, 'there is no field for a rating');
});

test('visibleDishes: voted-no, avoided dishes and tags, and diets are hidden with a reason; wanted first; slot filter', () => {
  let f = emptyFood();
  for (const [id, over] of [
    ['carbonara', { tags: ['pork', 'pasta'], slots: ['lunch', 'dinner'] }],
    ['carciofi', { tags: ['vegetarian-ok'], slots: ['dinner'] }],
    ['coda', { tags: ['offal', 'beef'] }],
    ['gelato', { tags: ['dessert', 'vegetarian-ok'], slots: ['snack'] }],
    ['pizza-al-taglio', { tags: ['street-food', 'vegetarian-ok'] }],
  ] as const) f = putDish(f, dish(id, over));
  const ids = (v: { shown: { id: string }[] }) => v.shown.map((d) => d.id);
  assert.deepEqual(ids(visibleDishes(f, '羅馬')), ['carbonara', 'carciofi', 'coda', 'gelato', 'pizza-al-taglio']);
  assert.deepEqual(ids(visibleDishes(f, '羅馬', 'dinner')), ['carbonara', 'carciofi', 'coda', 'pizza-al-taglio'], 'gelato is a snack; dishes with no slots fit any');
  assert.deepEqual(ids(visibleDishes(f, '大阪')), []);
  f = setTaste(f, { avoidTags: ['offal'], diet: ['no-pork'] });
  f = voteDish(voteDish(f, 'pizza-al-taglio', 'want'), 'gelato', 'no');
  const v = visibleDishes(f, '羅馬');
  assert.deepEqual(ids(v), ['pizza-al-taglio', 'carciofi'], 'wanted first');
  assert.deepEqual(v.hidden.map((h) => [h.dish.id, h.why]), [['carbonara', '不吃（pork）'], ['coda', '不吃（offal）'], ['gelato', '你說不要']]);
  const veg = visibleDishes(setTaste(f, { diet: ['vegetarian'], avoidTags: [] }), '羅馬');
  assert.deepEqual(ids(veg), ['pizza-al-taglio', 'carciofi'], 'vegetarian: only dishes that say so');
  assert.equal(visibleDishes(f, '羅馬').hidden.length, 3, 'nothing disappears silently');
});

test('taste: validated, merged, and the walking limit is bounded', () => {
  const f = setTaste(emptyFood(), { diet: ['no-raw', 'no-raw'], budget: 'mid', kids: true, maxWalkMin: 15, allergies: '花生' });
  assert.deepEqual(f.taste, { avoidDishes: [], avoidTags: [], likeTags: [], diet: ['no-raw'], allergies: '花生', budget: 'mid', kids: true, maxWalkMin: 15 });
  assert.equal(setTaste(f, { budget: 'high' }).taste.kids, true, 'a patch keeps what it does not mention');
  for (const bad of [{ maxWalkMin: 2 }, { maxWalkMin: 90 }, { budget: 'lots' }, { diet: ['keto'] }, { queue: 'forever' }, { kids: 'yes' }, { mystery: 1 }]) {
    assert.throws(() => setTaste(emptyFood(), bad), FoodError, JSON.stringify(bad));
  }
});

test('rejections and attribution are recorded once', () => {
  let f = rejectPlace(emptyFood(), 'osm:node/9', 'touristy', AT);
  f = rejectPlace(f, 'osm:node/9', 'pricey', AT);
  assert.deepEqual(f.rejected, [{ key: 'osm:node/9', reason: 'pricey', at: AT }]);
  assert.throws(() => rejectPlace(f, 'osm:node/9', 'rude' as never, AT), FoodError);
  assert.deepEqual(addAttribution(addAttribution(f, '© OpenStreetMap contributors (ODbL)'), '© OpenStreetMap contributors (ODbL)').attribution, ['© OpenStreetMap contributors (ODbL)']);
});

test('dishSearchUrl searches the dish by its local name near the stop, not "restaurants"', () => {
  const url = dishSearchUrl({ nameLocal: "Bucatini all'amatriciana", nameZh: '阿瑪翠斯麵', city: '羅馬' }, '競技場（Colosseo）');
  assert.equal(new URL(url).searchParams.get('query'), "Bucatini all'amatriciana 競技場 羅馬");
  assert.equal(new URL(url).hostname, 'www.google.com');
  assert.equal(new URL(dishSearchUrl({ nameLocal: 'お好み焼き', nameZh: '大阪燒', city: '大阪' }, undefined)).searchParams.get('query'), 'お好み焼き 大阪');
});


test('listings: validated, deduplicated by name and place, never overwritten by a different place', () => {
  const l = (name: string, lat: number, over: Record<string, unknown> = {}) => ({ name, loc: { lat, lng: 12.49 }, city: '羅馬', source: { url: 'https://en.wikivoyage.org/wiki/Rome/Colosseo', title: 'Rome/Colosseo', fetchedAt: AT }, ...over });
  const a = putListings(emptyFood(), [l('Luzzi', 41.889), l('Pasqualino', 41.8893)]);
  assert.equal(a.listings.length, 2);
  const b = putListings(a, [l('Luzzi', 41.88901, { lastedit: '2024-01-01' }), l('Luzzi', 41.9)]);
  assert.deepEqual(b.listings.map((x) => [x.name, x.lastedit ?? null]), [['Luzzi', '2024-01-01'], ['Pasqualino', null], ['Luzzi', null]], 'the same name 1 km away is another place');
  for (const bad of [l('x', 99), l('x', 1, { lastedit: '2024' }), l('x', 1, { source: { url: 'http://x.test/', title: 't', fetchedAt: AT } }), l('x', 1, { rating: 4 }), l('', 1)]) assert.throws(() => putListings(emptyFood(), [bad]), FoodError);
});

// ---------- what a place is like: a profile from pages the AI read, a photo of its own ----------

test('a profile needs pages it came from, has no room for a rating, and a photo must be a file we saved', async () => {
  const { parseProfile, parsePhoto } = await import('./food.ts');
  const ok = { summary: '羅馬老字號小酒館，午餐多是當地人', order: ['carbonara', 'cacio e pepe'], price: '主菜約 €12.50–18', watch: '中午排隊，只收現金', sources: ['https://example.com/guide'], fetchedAt: '2026-11-07T10:00:00Z' };
  assert.equal(parseProfile(ok).summary, ok.summary);
  assert.equal(parseProfile(ok).price, '主菜約 €12.50–18', 'a price with decimals is a price, not a score');
  assert.throws(() => parseProfile({ ...ok, sources: [] }), /附上你讀過的網頁/);
  assert.throws(() => parseProfile({ ...ok, sources: ['http://example.com/x'] }), /https/);
  assert.throws(() => parseProfile({ ...ok, sources: undefined }), FoodError);
  for (const bad of ['Google 4.6 顆星很穩', '★★★★☆ 好吃', '評分很高', '9/10', '4.5 stars']) {
    assert.throws(() => parseProfile({ ...ok, summary: bad }), /不要寫評分/, bad);
  }
  assert.throws(() => parseProfile({ ...ok, watch: '評分 4.8' }), /不要寫評分/);
  assert.throws(() => parseProfile({ ...ok, order: ['a', 'b', 'c', 'd', 'e', 'f'] }), FoodError);
  assert.throws(() => parseProfile({ ...ok, extra: 1 }), FoodError);
  assert.deepEqual(parsePhoto({ file: 'attachments/food-0123456789.jpg', pageUrl: 'https://example.com/', fetchedAt: '2026-11-07T10:00:00Z' }).file, 'attachments/food-0123456789.jpg');
  for (const file of ['attachments/../trip.ts', 'tickets/food-0123456789.jpg', 'attachments/food-0123456789.svg', 'attachments/other.jpg', '/etc/passwd']) {
    assert.throws(() => parsePhoto({ file, pageUrl: 'https://example.com/', fetchedAt: '2026-11-07T10:00:00Z' }), FoodError, file);
  }
});

test('a shortlist keeps the latest three searches, replaces the same meal and start, and refuses what is malformed', async () => {
  const { putShortlist } = await import('./food.ts');
  const batch = (date: string, slot = 'dinner', anchor = '凱旋門') => ({ at: '2026-11-07T12:00:00Z', date, slot, anchor, items: [{ key: 'osm:node/1', distanceM: 300, walkMin: 4, tier: 'likely', why: ['用餐時間有營業'], flags: [], open: 'open', mapsUrl: 'https://www.google.com/maps/search/?api=1&query=x' }] });
  let f = emptyFood();
  for (const d of ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']) f = putShortlist(f, batch(d));
  assert.deepEqual(f.shortlist.map((b) => b.date), ['2026-10-02', '2026-10-03', '2026-10-04']);
  f = putShortlist(f, batch('2026-10-03'));
  assert.deepEqual(f.shortlist.map((b) => b.date), ['2026-10-02', '2026-10-04', '2026-10-03'], 'the same meal and start is replaced and moves to the end');
  assert.throws(() => putShortlist(f, { ...batch('2026-10-05'), slot: 'brunch' }), FoodError);
  assert.throws(() => putShortlist(f, { ...batch('2026-10-05'), items: [{ ...batch('x').items[0]!, rating: 4.5 }] }), FoodError);
  assert.throws(() => putShortlist(f, { ...batch('2026-10-05'), items: [{ ...batch('x').items[0]!, mapsUrl: 'http://x.example.com' }] }), FoodError);
  assert.deepEqual(parseFood({ version: 1, taste: {}, dishes: [], votes: {}, places: [], rejected: [], attribution: [] }).shortlist, [], 'an older file without a shortlist still loads');
});
