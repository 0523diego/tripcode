import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { parseDish } from './food.ts';
import { CLOSING_MARGIN_MIN, matchDishes, matchListings, mergeDuplicates, openStatus, rankVenues, venuesFrom, walkMinutes } from './food-find.ts';
import type { OsmElement, Venue } from './food-find.ts';
import { dishSeeds, parseEatDishes, parseEatListings } from './wikivoyage-food.ts';
import { parseOpeningHours } from './opening-hours-osm.ts';

const load = (name: string): OsmElement[] => (JSON.parse(fs.readFileSync(new URL(`./fixtures/overpass/${name}.json`, import.meta.url), 'utf8')) as { elements: OsmElement[] }).elements;
const wikivoyage = (name: string, city: string) =>
  dishSeeds(parseEatDishes((JSON.parse(fs.readFileSync(new URL(`./fixtures/wikivoyage/${name}-eat.json`, import.meta.url), 'utf8')) as { wikitext: string }).wikitext), city, { url: 'https://en.wikivoyage.org/wiki/X', title: 'X', fetchedAt: '2026-11-07T12:00:00Z' });
const NOW = new Date('2026-11-07T12:00:00Z');
const COLOSSEO = { lat: 41.8902, lng: 12.4922 };
const DOTONBORI = { lat: 34.6687, lng: 135.5013 };

test('opening hours text: simple forms, a rule without days means every day, anything else is unknown', () => {
  assert.equal(openStatus('Th-Tu 12:00-24:00', 2, 19 * 60 + 30), 'open', 'Tuesday evening');
  assert.equal(openStatus('Th-Tu 12:00-24:00', 3, 12 * 60), 'closed', 'Wednesday is the day off');
  assert.equal(openStatus('Mo-Su 11:00-00:00', 5, 22 * 60), 'open');
  assert.equal(openStatus('Mo-Su 12:00-01:00', 6, 23 * 60 + 30), 'open', 'past midnight');
  assert.equal(openStatus('11:00-24:00', 1, 12 * 60), 'open', 'no days: every day');
  assert.equal(openStatus('Mo-Fr 12:00-15:00', 1, 14 * 60 + 30), 'closed', `${CLOSING_MARGIN_MIN} minutes before closing is too late to start a meal`);
  for (const odd of ['Mo-Fr 12:00-15:00; PH off', 'sunrise-sunset', 'by appointment', 'Mo-Su 12:00-14:00 open "kitchen"']) assert.equal(openStatus(odd, 1, 13 * 60), 'unknown', odd);
  assert.equal(openStatus(undefined, 1, 13 * 60), 'unknown');
  assert.equal(parseOpeningHours('24/7')?.periods.length, 7);
});

test('venues: only named food places with coordinates; a place whose tags say it closed is never offered', () => {
  const venues = venuesFrom(load('dotonbori'));
  assert.ok(venues.length > 15);
  assert.ok(venues.every((v) => v.name && Number.isFinite(v.loc.lat)));
  // The Starbucks with `disused:amenity` is gone; the working ones are cafes (kept here, filtered by kind when ranking).
  assert.equal(venues.some((v) => v.key === 'osm:node/697381329'), false);
  assert.ok(venues.some((v) => v.key === 'osm:way/222477943'), 'a building (way) uses its centre');
  const bad = venuesFrom([{ type: 'node', id: 1, lat: 1, lon: 1, tags: { amenity: 'restaurant' } }, { type: 'node', id: 2, tags: { amenity: 'restaurant', name: 'No place' } }, { type: 'node', id: 3, lat: 1, lon: 1, tags: { amenity: 'bank', name: 'Bank' } }, { type: 'node', id: 4, lat: 1, lon: 1, tags: { amenity: 'restaurant', name: 'Old', 'abandoned:amenity': 'restaurant' } }]);
  assert.deepEqual(bad, []);
});

test('duplicates: the same shop twice becomes one entry that remembers the other key; neighbours with other names stay', () => {
  const v = (key: string, name: string, lat: number, extra: Partial<Venue> = {}): Venue => ({ key, name, names: [name], loc: { lat, lng: 135.5 }, cuisines: [], amenity: 'restaurant', alsoKeys: [], ...extra });
  const merged = mergeDuplicates([v('osm:node/1', '味乃家', 34.668), v('osm:way/2', '味乃家', 34.66805, { hours: 'Mo-Su 11:00-22:00', checkDate: '2026-01-01' }), v('osm:node/3', '別の店', 34.66802), v('osm:node/4', '味乃家', 34.6700)]);
  assert.equal(merged.length, 3);
  const aji = merged.find((x) => x.name === '味乃家' && x.key !== 'osm:node/4')!;
  assert.equal(aji.key, 'osm:way/2', 'the richer entry stays');
  assert.deepEqual(aji.alsoKeys, ['osm:node/1']);
  assert.ok(merged.some((x) => x.key === 'osm:node/4'), 'the same name 200 m away is another shop');
  const en = mergeDuplicates([v('a', 'Mizuno', 34.668, { names: ['水の', 'Mizuno'] }), v('b', '水の', 34.66803, { names: ['水の'] })]);
  assert.equal(en.length, 1, 'name and name:en of the same shop');
});

test('Osaka lunch near Dotonbori: dishes named in the shop, the closed day, and what is dropped and why', () => {
  const dishes = [...wikivoyage('osaka', '大阪').filter((d) => ['okonomiyaki', 'takoyaki'].includes(d.id))];
  assert.equal(dishes.length, 2);
  const venues = mergeDuplicates(venuesFrom(load('dotonbori')));
  const r = rankVenues({ venues, dishes, anchor: DOTONBORI, weekday: 3, startMin: 12 * 60, maxWalkMin: 10, now: NOW });
  assert.equal(r.generalMode, false);
  const names = r.ranked.map((x) => x.venue.name);
  for (const expected of ['味乃家', 'お好み焼三平', 'お好み焼 おかる', 'たこ焼き赤鬼']) assert.ok(names.includes(expected), expected);
  assert.ok(!r.ranked.some((x) => x.venue.key === 'osm:node/2321863222'), 'that わなか is open Thursday to Tuesday: on Wednesday it is closed');
  assert.ok(r.dropped.closed >= 1);
  assert.ok(!names.some((n) => n.includes('スターバックス')), 'a coffee shop is not a lunch');
  assert.ok(r.ranked.every((x) => x.walkMin <= 10 && x.distanceM === Math.round(x.distanceM)));
  const aji = r.ranked.find((x) => x.venue.name === '味乃家')!;
  assert.deepEqual(aji.matches, [{ dishId: 'okonomiyaki', how: 'cuisine' }], 'the cuisine tag says okonomiyaki, the name does not');
  const sanpei = r.ranked.find((x) => x.venue.name === 'お好み焼三平')!;
  assert.deepEqual(sanpei.matches, [{ dishId: 'okonomiyaki', how: 'name' }], 'the name carries the dish (without the final き)');
  assert.ok(sanpei.score > aji.score, 'a shop named for the dish outranks one only tagged for it');
  assert.equal(sanpei.open, 'unknown');
  assert.ok(sanpei.flags.includes('hours-unknown'));
  assert.ok(r.ranked.length > 0 && r.ranked.every((x) => x.evidence.some((e) => e.claim === 'exists' && e.kind === 'map-osm')));
  assert.ok(r.ranked.every((x) => x.evidence.every((e) => !('rating' in e))), 'no ratings anywhere');
  // Sorted: score, then nearer.
  for (let i = 1; i < r.ranked.length; i++) assert.ok(r.ranked[i - 1]!.score >= r.ranked[i]!.score);
});

test('Osaka: the same lunch on Friday finds the shop that was closed on Wednesday (it is open Thursday to Tuesday)', () => {
  const dishes = wikivoyage('osaka', '大阪').filter((d) => d.id === 'takoyaki').map((d) => ({ ...d, match: { ...d.match, names: [...d.match.names, 'わなか'] } }));
  const venues = mergeDuplicates(venuesFrom(load('dotonbori')));
  const wed = rankVenues({ venues, dishes, anchor: { lat: 34.6663, lng: 135.5012 }, weekday: 3, startMin: 12 * 60, maxWalkMin: 10, now: NOW });
  const fri = rankVenues({ venues, dishes, anchor: { lat: 34.6663, lng: 135.5012 }, weekday: 5, startMin: 12 * 60, maxWalkMin: 10, now: NOW });
  assert.ok(!wed.ranked.some((x) => x.venue.key === 'osm:node/2321863222'));
  const wanaka = fri.ranked.find((x) => x.venue.key === 'osm:node/2321863222');
  assert.ok(wanaka);
  assert.equal(wanaka.open, 'open');
  assert.ok(wanaka.why.includes('用餐時間有營業'));
  assert.ok(wanaka.evidence.some((e) => e.claim === 'open-at-slot' && /Th-Tu 10:00-22:00/.test(e.detail ?? '')));
  assert.equal(wanaka.evidence[0]!.confidence, 'recent', 'checked 2026-07-06: within 18 months');
});

test('Rome dinner near the Colosseum: no place names the dish, so the list is general and says so; open Tuesday evening is checked', () => {
  const dishes = wikivoyage('rome', '羅馬').filter((d) => ['bucatini-all-amatriciana', 'spaghetti-alla-carbonara'].includes(d.id));
  assert.equal(dishes.length, 2);
  const venues = mergeDuplicates(venuesFrom(load('colosseo')));
  const r = rankVenues({ venues, dishes, anchor: COLOSSEO, weekday: 2, startMin: 19 * 60 + 30, maxWalkMin: 10, now: NOW });
  assert.equal(r.generalMode, true);
  const luzzi = r.ranked.find((x) => x.venue.key === 'osm:node/7082306423');
  assert.ok(luzzi, 'Luzzi is open Th-Tu, so on a Tuesday evening');
  assert.equal(luzzi.open, 'open');
  assert.ok(luzzi.why.includes('無法確認有沒有這道菜'));
  assert.equal(luzzi.matches.length, 0);
  assert.ok(luzzi.venue.website);
  const wed = rankVenues({ venues, dishes, anchor: COLOSSEO, weekday: 3, startMin: 19 * 60 + 30, maxWalkMin: 10, now: NOW });
  assert.ok(!wed.ranked.some((x) => x.venue.key === 'osm:node/7082306423'), 'closed on Wednesday: not offered');
  const taverna = r.ranked.find((x) => x.venue.name === 'Taverna Romana');
  assert.equal(taverna?.evidence[0]?.confidence, 'recent', 'checked 2026-09-23');
});

test('a dish that one place carries is matched and the rest are dropped, not listed as maybes', () => {
  const dishes = [parseDish({ id: 'pizza-al-taglio', city: '羅馬', nameZh: '切片披薩', nameLocal: 'Pizza al taglio', why: 'x', tags: [], match: { names: ['pizza'], cuisines: ['pizza'] }, sources: [{ kind: 'ai', fetchedAt: '2026-11-07T12:00:00Z' }] })];
  const venues = mergeDuplicates(venuesFrom(load('colosseo')));
  const r = rankVenues({ venues, dishes, anchor: COLOSSEO, weekday: 2, startMin: 19 * 60 + 30, maxWalkMin: 15, now: NOW });
  assert.equal(r.generalMode, false);
  assert.ok(r.ranked.length > 0 && r.ranked.every((x) => x.matches.length > 0));
  assert.ok(r.ranked.some((x) => x.venue.cuisines.includes('pizza')));
  assert.ok(r.dropped.noMatch > 0);
});

test('rejected places and far places are left out and counted; the walk limit uses a detour factor', () => {
  const venues = mergeDuplicates(venuesFrom(load('colosseo')));
  const base = { venues, dishes: [], anchor: COLOSSEO, weekday: 2, startMin: 19 * 60 + 30, now: NOW };
  const all = rankVenues({ ...base, maxWalkMin: 10 });
  assert.ok(all.ranked.length > 3);
  const first = all.ranked[0]!;
  const without = rankVenues({ ...base, maxWalkMin: 10, rejected: new Set([first.venue.key]) });
  assert.equal(without.dropped.rejected, 1);
  assert.ok(!without.ranked.some((x) => x.venue.key === first.venue.key));
  const near = rankVenues({ ...base, maxWalkMin: 4 });
  assert.ok(near.dropped.far > 0 && near.ranked.every((x) => x.walkMin <= 4));
  assert.equal(walkMinutes(615), 10);
  assert.equal(walkMinutes(10), 1);
});

test('a chain with several branches is flagged and loses a point; a place beside another stop of the trip is flagged', () => {
  const v = (key: string, lat: number, over: Partial<Venue> = {}): Venue => ({ key, name: `Pizza ${key}`, names: [`Pizza ${key}`], loc: { lat, lng: 12.49 }, cuisines: ['pizza'], amenity: 'restaurant', alsoKeys: [], ...over });
  const venues = [v('a', 41.8902, { brand: 'PizzaCo' }), v('b', 41.8903, { brand: 'PizzaCo' }), v('c', 41.8904)];
  const r = rankVenues({ venues, dishes: [], anchor: { lat: 41.8902, lng: 12.49 }, weekday: 1, startMin: 12 * 60, maxWalkMin: 10, landmarks: [{ lat: 41.8904, lng: 12.4901 }], now: NOW });
  const by = Object.fromEntries(r.ranked.map((x) => [x.venue.key, x]));
  assert.ok(by.a!.flags.includes('chain') && by.b!.flags.includes('chain') && !by.c!.flags.includes('chain'));
  assert.equal(r.ranked[0]!.venue.key, 'c', 'the independent place first');
  assert.ok(by.c!.flags.includes('near-landmark'));
});

test('matchDishes: venue words are the weakest match; a name needs to be four letters to count for Latin script', () => {
  const dish = parseDish({ id: 'x', city: 'c', nameZh: 'x', nameLocal: 'Cacio e pepe', why: 'w', tags: [], match: { names: ['pe', 'cacio e pepe'], venueWords: ['trattoria'] }, sources: [{ kind: 'ai', fetchedAt: '2026-11-07T12:00:00Z' }] });
  const mk = (name: string, cuisines: string[] = []): Venue => ({ key: name, name, names: [name], loc: { lat: 0, lng: 0 }, cuisines, amenity: 'restaurant', alsoKeys: [] });
  assert.deepEqual(matchDishes(mk('Trattoria Da Enzo'), [dish]), [{ dishId: 'x', how: 'venue-word' }]);
  assert.deepEqual(matchDishes(mk('Cacio e Pepe da Mario'), [dish]), [{ dishId: 'x', how: 'name' }]);
  assert.deepEqual(matchDishes(mk('Pepe Verde'), [dish]), [], '"pe" is too short to mean anything');
});

test('review fixes: a later opening-hours rule replaces the earlier one; a place that opens inside the window is open; different shops sharing a word stay apart', () => {
  assert.equal(openStatus('Mo-Su 12:00-23:00; Tu 18:00-23:00', 2, 12 * 60), 'closed', 'Tuesday opens at 18:00');
  assert.equal(openStatus('Mo-Su 12:00-23:00; Tu 18:00-23:00', 3, 12 * 60), 'open');
  assert.equal(openStatus('Mo-Fr 12:00-15:00; Sa 10:00-13:00', 6, 11 * 60), 'open');
  // Lunch 12:00–14:30, kitchen opens 12:30: fine. Dinner 19:00–21:30, opens 19:30: fine. Closes 14:40: too late to start.
  assert.equal(openStatus('Mo-Su 12:30-23:00', 1, 12 * 60, 14 * 60 + 30), 'open');
  assert.equal(openStatus('Mo-Su 19:30-23:00', 1, 19 * 60, 21 * 60 + 30), 'open');
  assert.equal(openStatus('Mo-Su 08:00-14:40', 1, 12 * 60, 14 * 60 + 30), 'open', '2h40 of the window');
  assert.equal(openStatus('Mo-Su 08:00-12:30', 1, 12 * 60, 14 * 60 + 30), 'closed', 'only 30 minutes left');
  const v = (key: string, name: string, lat: number): Venue => ({ key, name, names: [name], loc: { lat, lng: 135.5 }, cuisines: [], amenity: 'restaurant', alsoKeys: [] });
  assert.equal(mergeDuplicates([v('a', 'Pizzeria da Mario', 34.668), v('b', 'Pizzeria Luigi', 34.66802)]).length, 2);
  assert.equal(mergeDuplicates([v('a', 'たこ焼き くくる', 34.668), v('b', 'たこ焼き 十八番', 34.66802)]).length, 2);
  assert.equal(mergeDuplicates([v('a', 'Trattoria Da Enzo', 34.668), v('b', 'Trattoria Moderna', 34.66802)]).length, 2);
  assert.equal(mergeDuplicates([v('a', 'Mizuno', 34.668), v('b', 'Mizuno Okonomiyaki', 34.66802)]).length, 1, 'one name contains the other');
});

test('review fixes: general mode is decided among the places that fit; a recommendation survives a merge', () => {
  const dishes = [parseDish({ id: 'tako', city: 'c', nameZh: 'x', nameLocal: 'たこ焼き', why: 'w', tags: [], match: { names: ['たこ焼き'] }, sources: [{ kind: 'ai', fetchedAt: '2026-11-07T12:00:00Z' }] })];
  const mk = (key: string, name: string, lat: number, over: Partial<Venue> = {}): Venue => ({ key, name, names: [name], loc: { lat, lng: 135.5 }, cuisines: [], amenity: 'restaurant', alsoKeys: [], ...over });
  // The only shop named for the dish is too far: the nearby ones are a general list, not "no match" drops.
  const venues = [mk('far', 'たこ焼き遠い店', 34.68), mk('near1', '近い店', 34.6681), mk('near2', '別の店', 34.6682)];
  const r = rankVenues({ venues, dishes, anchor: { lat: 34.668, lng: 135.5 }, weekday: 1, startMin: 12 * 60, maxWalkMin: 10, now: NOW });
  assert.equal(r.generalMode, true);
  assert.equal(r.ranked.length, 2);
  assert.equal(r.dropped.far, 1);
  const merged = rankVenues({ venues: [mk('main', '店', 34.6681, { alsoKeys: ['old'] })], dishes: [], anchor: { lat: 34.668, lng: 135.5 }, weekday: 1, startMin: 12 * 60, maxWalkMin: 10, recommended: new Set(['old']), now: NOW });
  assert.equal(merged.ranked[0]!.tier === 'safe' || merged.ranked[0]!.why.includes('有來源推薦'), true);
});


test("the travel guide's picks: a venue the Wikivoyage editors listed is recommended, ranked first and shown as such; the rest are not", () => {
  const guide = parseEatListings((JSON.parse(fs.readFileSync(new URL('./fixtures/wikivoyage/colosseo-eat.json', import.meta.url), 'utf8')) as { wikitext: string }).wikitext).map((l) => ({
    name: l.name, loc: { lat: l.lat, lng: l.lng }, city: '羅馬', source: { url: 'https://en.wikivoyage.org/wiki/Rome/Colosseo', title: 'Rome/Colosseo', revision: '1', fetchedAt: '2026-11-07T12:00:00Z' }, ...(l.lastedit ? { lastedit: l.lastedit } : {}),
  }));
  const venues = mergeDuplicates(venuesFrom(load('colosseo')));
  const listed = matchListings(venues, guide);
  assert.deepEqual([...listed.keys()], ['osm:node/7082306423'], 'only Luzzi is both on the map here and on the guide list (within 90 m, same name)');
  const r = rankVenues({ venues, dishes: [], anchor: COLOSSEO, weekday: 2, startMin: 19 * 60 + 30, endMin: 21 * 60 + 30, maxWalkMin: 10, listings: guide, now: NOW });
  const top = r.ranked[0]!;
  assert.equal(top.venue.key, 'osm:node/7082306423');
  assert.equal(top.tier, 'safe', 'open then and recommended by a guide');
  assert.ok(top.why.some((w) => w.startsWith('旅遊指南（Wikivoyage）列為推薦')));
  const e = top.evidence.find((x) => x.kind === 'guide-wikivoyage')!;
  assert.deepEqual([e.claim, e.source, e.confidence], ['recommended', 'https://en.wikivoyage.org/wiki/Rome/Colosseo', 'recent'], 'edited 2024-04: within three years');
  assert.match(e.detail ?? '', /編修 2024-04-10/);
  assert.ok(r.ranked.slice(1).every((x) => !x.evidence.some((y) => y.kind === 'guide-wikivoyage')));
  // Same place, a different one 300 m away with the same name: not the guide's pick.
  assert.equal(matchListings([{ ...venues.find((v) => v.key === 'osm:node/7082306423')!, loc: { lat: 41.8921, lng: 12.4966 } }], guide).size, 0);
});

test('fast food and branded chains sink below ordinary restaurants and say so', () => {
  const v = (key: string, name: string, extra: Record<string, unknown> = {}) => ({ key, name, names: [], cuisines: [], loc: { lat: 48.8738, lng: 2.2955 }, amenity: 'restaurant', alsoKeys: [], ...extra }) as Venue;
  const result = rankVenues({
    venues: [v('osm:node/1', 'Burger King', { amenity: 'fast_food', brand: 'Burger King', hours: 'Mo-Su 10:00-23:00' }), v('osm:node/2', 'Chez Paul', { hours: 'Mo-Su 10:00-23:00' }), v('osm:node/3', 'Brasserie Z', { brand: 'Groupe Z', hours: 'Mo-Su 10:00-23:00' })],
    dishes: [],
    anchor: { lat: 48.8738, lng: 2.295 },
    weekday: 1,
    startMin: 19 * 60,
    maxWalkMin: 10,
    now: new Date('2026-11-07T10:00:00Z'),
  });
  assert.deepEqual(result.ranked.map((r) => r.venue.name), ['Chez Paul', 'Brasserie Z', 'Burger King']);
  assert.deepEqual(result.ranked.map((r) => r.flags.filter((f) => f === 'chain' || f === 'fast-food')), [[], ['chain'], ['chain', 'fast-food']]);
});
