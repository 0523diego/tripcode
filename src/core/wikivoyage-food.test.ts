import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { parseDish } from './food.ts';
import { dishSeeds, inferTags, parseEatDishes, parseEatListings } from './wikivoyage-food.ts';

const fixture = (name: string): string => (JSON.parse(fs.readFileSync(new URL(`./fixtures/wikivoyage/${name}-eat.json`, import.meta.url), 'utf8')) as { wikitext: string }).wikitext;

test('Rome: the "Eat like a Roman" box gives thirteen dishes, with their tags derived from the wording', () => {
  const dishes = parseEatDishes(fixture('rome'));
  assert.equal(dishes.length, 13);
  assert.deepEqual(dishes.map((d) => d.name).slice(0, 6), ['Carciofi alla romana', 'Carciofi alla giudia', 'Puntarelle', "Bucatini all'amatriciana", 'Spaghetti alla carbonara', 'Abbacchio a "scottadito"']);
  const byName = Object.fromEntries(dishes.map((d) => [d.name, d]));
  assert.ok(byName["Bucatini all'amatriciana"]!.tags.includes('pork') && byName["Bucatini all'amatriciana"]!.tags.includes('pasta'));
  assert.ok(byName['Coda alla vaccinara']!.tags.includes('offal'));
  assert.ok(byName['Trippa alla romana']!.tags.includes('offal'));
  assert.ok(byName['Carciofi alla giudia']!.tags.includes('vegetarian-ok'), 'artichokes and no meat word');
  assert.ok(!byName['Spaghetti alla carbonara']!.tags.includes('vegetarian-ok'));
  assert.ok(byName['Pizza a taglio']!.tags.includes('street-food'));
  assert.ok(dishes.every((d) => d.how === 'list'));
});

test('Osaka: the specialities list names five dishes with their Japanese spelling; bold place names in the prose are not dishes', () => {
  const dishes = parseEatDishes(fixture('osaka'));
  assert.deepEqual(dishes.map((d) => [d.name, d.local]), [['Battera', 'バッテラ'], ['Okonomiyaki', 'お好み焼き'], ['Takoyaki', 'たこ焼き'], ['Kushikatsu', '串かつ'], ['Doteyaki', 'どて焼き']]);
  assert.ok(!dishes.some((d) => /Dōtonbori|Hōzenji/i.test(d.name)));
  assert.ok(dishes.find((d) => d.name === 'Battera')!.tags.includes('seafood'));
});

test('Tainan: with no list, the bold dish names in the opening prose and the local-specialties part are used', () => {
  const dishes = parseEatDishes(fixture('tainan'));
  const names = dishes.map((d) => d.name.toLowerCase());
  for (const expected of ['oyster omelette', 'oysters and thin noodles', 'danzai noodles']) assert.ok(names.includes(expected), expected);
  const omelette = dishes.find((d) => d.name.toLowerCase() === 'oyster omelette')!;
  assert.equal(omelette.local, '蚵仔煎');
  assert.ok(dishes.every((d) => d.how === 'prose'));
  assert.ok(!names.some((n) => /night market/.test(n)), 'listings and places are not dishes');
});

test('nothing recognisable gives nothing, and templates do not leak into names', () => {
  assert.deepEqual(parseEatDishes('==Eat==\nThere are restaurants.\n* {{eat | name=Foo | content=bar}}\n'), []);
  assert.deepEqual(parseEatDishes(''), []);
  const names = parseEatDishes("==Eat==\n{{infobox|Try these|\n* '''Tonkatsu''' - Breaded [[pork]] cutlet\n}}").map((d) => d.name);
  assert.deepEqual(names, ['Tonkatsu']);
});

test('inferTags: only what the wording says', () => {
  assert.deepEqual(inferTags('Oxtail stew'), ['beef', 'offal']);
  assert.ok(inferTags('Deep-fried zucchini flowers').includes('vegetarian-ok'));
  assert.deepEqual(inferTags('A thing'), []);
});

test('dishSeeds: valid dishes with the source and revision, honest about the generic reason, ids unique', () => {
  const source = { url: 'https://en.wikivoyage.org/wiki/Rome', title: 'Rome', revision: '4567890', fetchedAt: '2026-11-07T12:00:00Z' };
  const seeds = dishSeeds(parseEatDishes(fixture('rome')), '羅馬', source);
  assert.equal(seeds.length, 13);
  for (const s of seeds) assert.doesNotThrow(() => parseDish(s));
  assert.equal(new Set(seeds.map((s) => s.id)).size, 13);
  assert.equal(seeds[3]!.id, 'bucatini-all-amatriciana');
  assert.deepEqual(seeds[0]!.sources, [{ kind: 'wikivoyage', ...source }]);
  assert.match(seeds[0]!.why, /Wikivoyage/);
  const osaka = dishSeeds(parseEatDishes(fixture('osaka')), '大阪', source);
  assert.deepEqual([osaka[1]!.nameLocal, osaka[1]!.nameZh, osaka[1]!.romanized], ['お好み焼き', 'Okonomiyaki', 'Okonomiyaki'], 'Japanese: local spelling kept, English label until a Chinese name is written');
  const tainan = dishSeeds(parseEatDishes(fixture('tainan')), '台南', source);
  assert.equal(tainan.find((s) => s.nameLocal === '蚵仔煎')!.nameZh, '蚵仔煎', 'a Chinese name is its own Chinese label');
});

test('long names and meat words: a long aside after a dish does not break the seeds, and meat or clams are not "vegetarian-ok"', () => {
  const wikitext = "==Eat==\n* '''Okonomiyaki''' (お好み焼き, a savoury pancake, the best ones are found around Dotonbori)\n* '''Pajata''' - calf intestines in a tomato sauce\n* '''Spaghetti alle vongole''' - pasta with clams\n";
  const dishes = parseEatDishes(wikitext);
  assert.equal(dishes[0]!.local, 'お好み焼き');
  for (const s of dishSeeds(dishes, '羅馬', { url: 'https://en.wikivoyage.org/wiki/Rome', title: 'Rome', fetchedAt: '2026-11-07T12:00:00Z' })) assert.doesNotThrow(() => parseDish(s));
  assert.ok(!dishes[1]!.tags.includes('vegetarian-ok') && !dishes[2]!.tags.includes('vegetarian-ok'));
});

test('{{eat}} listings: name, alternative name, coordinates and the editors\' last touch; entries without coordinates are skipped', () => {
  const read = (name: string) => parseEatListings((JSON.parse(fs.readFileSync(new URL(`./fixtures/wikivoyage/${name}-eat.json`, import.meta.url), 'utf8')) as { wikitext: string }).wikitext);
  const rome = read('colosseo');
  assert.equal(rome.length, 12);
  assert.equal(rome.find((l) => l.name === 'Trattoria Pizzeria Luzzi')?.lastedit, '2024-04-10');
  assert.ok(rome.every((l) => Math.abs(l.lat - 41.89) < 0.05));
  assert.equal(rome.filter((l) => l.lastedit).length, 11, 'one entry has no edit date and says so by having none');
  assert.equal(read('tainan').length, 6, 'Tainan: the entries that have coordinates (7 listings, one without)');
  assert.deepEqual(parseEatListings('{{eat | name=No place | lat= | long= }} {{eat | name=Out | lat=99 | long=1}} {{eat | name=Fine | alt=好店 | lat=1.5 | long=2.5 | lastedit=2024-02-03 | content=x }}'), [{ name: 'Fine', alt: '好店', lat: 1.5, lng: 2.5, lastedit: '2024-02-03' }]);
  assert.deepEqual(parseEatListings(''), []);
});

test('parseEatDishes: chains and stray small words from a page are not dishes', () => {
  const wikitext = "== Eat ==\n* McDonald's\n* Burger King\n* and\n* '''Risotto alla milanese''' - saffron rice\n";
  assert.deepEqual(parseEatDishes(wikitext).map((d) => d.name), ['Risotto alla milanese']);
  assert.deepEqual(parseEatDishes("== Eat ==\n* McDonald's\n* Burger King\n"), [], 'nothing left: the caller then asks the AI for a list instead of saving fast food');
});
