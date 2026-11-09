import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Dish, FoodFile } from '../../core/food-types.ts';
import type { NearResult } from './food-view.ts';
import { boardResults, dishBadge, guessWikivoyagePage, photoFromFood, placeBadges, proofLines, reasonText, tagLabels } from './food-view.ts';
import { emptyFood } from '../../core/food.ts';

const dish = (sources: Dish['sources']): Dish => ({ id: 'x', city: '羅馬', nameZh: 'x', nameLocal: 'x', why: 'w', tags: [], match: { names: ['x'] }, sources });
const AT = '2026-11-07T12:00:00Z';

test('a dish says where it came from, and the AI\'s memory is called that', () => {
  assert.deepEqual(dishBadge(dish([{ kind: 'ai', fetchedAt: AT }])), { tone: 'warn', text: 'AI 的印象，尚未查證' });
  assert.equal(dishBadge(dish([{ kind: 'wikivoyage', url: 'https://en.wikivoyage.org/wiki/Rome', revision: '55', fetchedAt: AT }])).text, 'Wikivoyage 指南列的（版本 55）');
  assert.equal(dishBadge(dish([{ kind: 'ai', fetchedAt: AT }, { kind: 'web', url: 'https://x.test/', title: '某美食誌', fetchedAt: AT }])).text, '某美食誌提到', 'a web source next to the memory counts as checked');
  assert.equal(dishBadge(dish([{ kind: 'user', fetchedAt: AT }])).text, '你自己加的');
});

const result = (over: Partial<NearResult> = {}): NearResult => ({
  key: 'osm:node/1', name: '店', loc: { lat: 1, lng: 1 }, distanceM: 300, walkMin: 5, tier: 'likely', score: 2, why: [], flags: [], open: 'open', hours: 'Th-Tu 12:00-24:00', matches: [], mapsUrl: 'https://www.google.com/maps/search/?api=1&query=x', evidence: [], ...over,
});

test('place badges: existence, hours at the meal, the match, and always the line that there is no rating', () => {
  const texts = (r: NearResult, general = false) => placeBadges(r, general).map((b) => b.text);
  const named = texts(result({ matches: [{ dishId: 'x', how: 'name' }] }));
  assert.deepEqual(named.slice(0, 3), ['已在地圖確認存在（OpenStreetMap）', '用餐時間有營業（OSM：Th-Tu 12:00-24:00）', '店名就是這道菜']);
  assert.equal(named.at(-1), '沒有評分資料：到 Google 地圖看');
  assert.ok(texts(result({ open: 'unknown', hours: undefined })).includes('營業時間沒寫，先查再去'));
  assert.ok(texts(result(), true).includes('無法確認有沒有這道菜'));
  assert.ok(texts(result({ matches: [{ dishId: 'x', how: 'venue-word' }] })).includes('只是這類傳統餐館，不確定有這道菜'));
  assert.ok(texts(result({ flags: ['chain', 'near-landmark'] })).includes('連鎖店'));
  const checked = texts(result({ evidence: [{ kind: 'map-osm', claim: 'exists', detail: 'OSM 資料檢查日 2026-09-23' }] }));
  assert.ok(checked.includes('OSM 資料檢查日 2026-09-23'));
  assert.ok(placeBadges(result(), false).every((b) => !/評分\s*\d|★|星/.test(b.text)), 'no badge ever shows a rating');
});

test('the Wikivoyage page for a city is only offered for well-known names, never guessed', () => {
  assert.equal(guessWikivoyagePage('羅馬'), 'Rome');
  assert.equal(guessWikivoyagePage('大阪'), 'Osaka');
  assert.equal(guessWikivoyagePage('某個小鎮'), '');
  assert.equal(guessWikivoyagePage(undefined), '');
});

test('dish cards: the stock sentence of a Wikivoyage seed is not repeated on every card, tags speak instead', () => {
  const seed = { ...dish([{ kind: 'wikivoyage', url: 'https://en.wikivoyage.org/wiki/Rome', fetchedAt: AT }]), why: '羅馬的 Wikivoyage 指南把它列為值得吃的在地料理', tags: ['pork', 'pasta', 'unknown-tag'] };
  assert.equal(reasonText(seed), undefined);
  assert.deepEqual(tagLabels(seed), ['豬肉', '麵食']);
  assert.equal(reasonText({ ...seed, why: '羅馬人晚餐常點的一道' }), '羅馬人晚餐常點的一道');
});

test('proof lines: what was checked about the chosen place, each with where and when; nothing without a source', () => {
  const s = <T,>(value: T, source: string) => ({ value, source, fetchedAt: '2026-11-07T11:00:00Z', confidence: 'recent' as const });
  assert.deepEqual(proofLines({ exists: s(true, 'osm:node/1'), openAtSlot: s(true, 'osm:node/1'), recommendedBy: [s('文章推薦', 'https://www.example.com/guide')] }), [
    { text: '已在地圖確認存在（OpenStreetMap，2026-11-07）' },
    { text: '用餐時間有營業（OpenStreetMap，2026-11-07）' },
    { text: '文章推薦（example.com，2026-11-07）', href: 'https://www.example.com/guide' },
  ]);
  assert.deepEqual(proofLines(undefined), []);
  assert.deepEqual(proofLines({ exists: s(true, '') }), [], 'a claim with no source is not shown');
  assert.deepEqual(proofLines({ recommendedBy: [s('x', 'not a url')] }), []);
});

// ---------- the board on the left of the screen ----------

const place = (key: string, extra: Record<string, unknown> = {}) => ({ key, name: key.toUpperCase(), loc: { lat: 48.87, lng: 2.3, fetchedAt: AT }, city: '巴黎', dishes: [], evidence: [{ kind: 'map-osm', claim: 'exists', source: key, fetchedAt: AT, confidence: 'recent' }], ...extra });
const item = (key: string) => ({ key, distanceM: 300, walkMin: 4, tier: 'likely', why: ['用餐時間有營業'], flags: [], open: 'open', mapsUrl: 'https://www.google.com/maps/search/?api=1&query=x' });
const guide = (): FoodFile =>
  ({
    ...emptyFood(),
    places: [place('osm:node/1'), place('osm:node/4'), place('osm:node/2', { photo: { file: 'attachments/food-0123456789.jpg', pageUrl: 'https://b.example.com/', fetchedAt: AT }, profile: { summary: '丹麥風格 brasserie', sources: ['https://b.example.com/'], fetchedAt: AT } }), place('osm:node/3')],
    shortlist: [{ at: AT, date: '2026-10-30', slot: 'dinner', anchor: '凱旋門', items: [item('osm:node/1'), item('osm:node/2'), item('osm:node/3'), item('osm:node/9'), { ...item('osm:node/4'), flags: ['fast-food'] }] }],
    rejected: [{ key: 'osm:node/3', reason: 'meh', at: AT }],
  }) as FoodFile;

test('the board lists the latest search: places the AI wrote about first, rejected or vanished ones left out, photo path under the trip', () => {
  const food = guide();
  const cards = boardResults(food, food.shortlist[0]!, 'paris');
  assert.deepEqual(cards.map((c) => c.key), ['osm:node/2', 'osm:node/1'], 'fast food (node/4) is not on the board');
  assert.equal(cards[0]!.photo?.path, 'trips/paris/attachments/food-0123456789.jpg');
  assert.equal(cards[0]!.profile?.summary, '丹麥風格 brasserie');
  assert.equal(cards[1]!.photo, undefined);
  assert.equal(JSON.stringify(cards).includes('rating'), false);
});

test('a drawer result gets the photo and introduction that arrived after its search; one already complete is untouched', () => {
  const food = guide();
  const bare = { key: 'osm:node/2', name: 'B', matches: [], evidence: [], flags: [] } as unknown as NearResult;
  const filled = photoFromFood(bare, food, 'paris');
  assert.equal(filled.photo?.path, 'trips/paris/attachments/food-0123456789.jpg');
  assert.equal(filled.profile?.summary, '丹麥風格 brasserie');
  assert.equal(photoFromFood(bare, null, 'paris'), bare);
  const own = { ...bare, photo: { path: 'trips/paris/attachments/own.jpg', pageUrl: 'https://x.example.com/' } } as NearResult;
  assert.equal(photoFromFood(own, food, 'paris').photo?.path, 'trips/paris/attachments/own.jpg');
});

test('the board does not claim a dish match it does not have', () => {
  const r = boardResults(guide(), guide().shortlist[0]!, 'paris')[0]!;
  assert.equal(placeBadges(r, false, { skipDishBadge: true }).some((b) => /菜|店名就是|無法確認有沒有這道/.test(b.text)), false);
});
