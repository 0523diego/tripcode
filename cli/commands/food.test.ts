import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { CliContext } from '../context.ts';
import { Throttle } from '../osm.ts';
import { run } from '../tripcode.ts';

const fast = new Throttle({ sleep: async () => undefined });

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tripcode-food-'));
  fs.mkdirSync(path.join(root, 'trips', 'demo'), { recursive: true });
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CliContext = {
    root,
    env: {},
    fetch: async () => new Response('{}'),
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    now: () => new Date('2026-11-07T12:00:00Z'),
    loadCore: async () => ({}) as never,
    loadTrip: async () => ({}) as never,
    ...({ foodThrottle: fast } as object),
  };
  const go = async (...argv: string[]) => {
    out.length = 0;
    err.length = 0;
    const code = await run(['food', ...argv], ctx);
    return { code, out: out.join(''), err: err.join('') };
  };
  return { root, go };
}

const DISH = {
  id: 'carbonara',
  city: '羅馬',
  nameZh: '培根蛋麵',
  nameLocal: 'Spaghetti alla carbonara',
  why: '羅馬人晚餐常點的一道',
  tags: ['pork', 'pasta'],
  match: { names: ['carbonara'] },
  sources: [{ kind: 'wikivoyage', url: 'https://en.wikivoyage.org/wiki/Rome', title: 'Rome', revision: '123', fetchedAt: '2026-11-07T12:00:00Z' }],
};

test('food: dishes, votes and taste go through one validated file; show prints it', async () => {
  const s = setup();
  assert.equal((await s.go('show', 'demo')).code, 0, 'no file yet: an empty guide');
  assert.equal(fs.existsSync(path.join(s.root, 'trips', 'demo', 'food.json')), false, 'reading creates nothing');

  assert.equal((await s.go('dish', 'add', 'demo', '--json', JSON.stringify(DISH))).code, 0);
  assert.equal((await s.go('vote', 'demo', 'carbonara', 'want')).code, 0);
  assert.equal((await s.go('taste', 'demo', '--diet', 'no-pork', '--budget', 'mid', '--kids', 'true')).code, 0);

  const shown = JSON.parse((await s.go('show', 'demo')).out);
  assert.deepEqual([shown.dishes.length, shown.votes, shown.taste.diet, shown.taste.budget, shown.taste.kids], [1, { carbonara: 'want' }, ['no-pork'], 'mid', true]);
  const pretty = (await s.go('show', 'demo', '--pretty')).out;
  assert.match(pretty, /【羅馬】0 道（另有 1 道被你的口味隱藏）/);
  assert.match(pretty, /× carbonara {2}培根蛋麵：不吃（pork）/);

  assert.equal((await s.go('dish', 'rm', 'demo', 'carbonara')).code, 0);
  assert.deepEqual(JSON.parse((await s.go('show', 'demo')).out).votes, {});
});

test('food: a dish without a source, an AI source with a URL, and unknown keys are refused with a reason', async () => {
  const s = setup();
  const bad = async (dish: unknown, re: RegExp) => {
    const r = await s.go('dish', 'add', 'demo', '--json', JSON.stringify(dish));
    assert.equal(r.code, 1);
    assert.match(r.err, re);
  };
  await bad({ ...DISH, sources: [] }, /至少要有一個來源/);
  await bad({ ...DISH, sources: [{ kind: 'ai', url: 'https://x.test/', fetchedAt: '2026-11-07T12:00:00Z' }] }, /不能附網址/);
  await bad({ ...DISH, rating: 5 }, /不認得的欄位：rating/);
  assert.equal(fs.existsSync(path.join(s.root, 'trips', 'demo', 'food.json')), false, 'nothing is written on a refusal');
  assert.equal((await s.go('vote', 'demo', 'nope', 'want')).code, 1);
  assert.equal((await s.go('show', 'Bad_Id')).code, 1);
  assert.equal((await s.go('show', 'missing-trip')).code, 0, 'an unknown trip just has no guide yet');
  assert.equal((await s.go('dish', 'add', 'missing-trip', '--json', JSON.stringify(DISH))).code, 1, 'but nothing is created for a trip that does not exist');
});

test('food: evidence needs a place that was looked at, and an address for the kinds a reader must check', async () => {
  const s = setup();
  const food = { version: 1, taste: { avoidDishes: [], avoidTags: [], likeTags: [], diet: [] }, dishes: [], votes: {}, rejected: [], attribution: [],
    places: [{ key: 'osm:node/1', name: '某某小館', loc: { lat: 41.89, lng: 12.49, fetchedAt: '2026-11-07T12:00:00Z' }, city: '羅馬', dishes: [], evidence: [] }] };
  fs.writeFileSync(path.join(s.root, 'trips', 'demo', 'food.json'), JSON.stringify(food));
  const add = (...extra: string[]) => s.go('evidence', 'add', 'demo', '--place', 'osm:node/1', '--claim', 'recommended', '--confidence', 'recent', ...extra);
  assert.equal((await add('--kind', 'web', '--source', 'something I remember')).code, 1);
  const ok = await add('--kind', 'web', '--source', 'https://example.com/rome-guide', '--detail', '文章提到這家的烤肉');
  assert.equal(ok.code, 0);
  assert.equal(JSON.parse(ok.out).place.evidence[0].fetchedAt, '2026-11-07T12:00:00Z');
  assert.equal((await s.go('evidence', 'add', 'demo', '--place', 'osm:node/404', '--kind', 'map-osm', '--claim', 'exists', '--source', 'osm:node/404', '--confidence', 'recent')).code, 1);
  assert.equal((await s.go('reject', 'demo', '--place', 'osm:node/1', '--reason', 'touristy')).code, 0);
});

test('food guide: reads the Eat section of a Wikivoyage page (two polite requests), lists the dishes, and --save keeps what is already there', async () => {
  const s = setup();
  const requests: { url: string; ua: string | undefined }[] = [];
  const rome = JSON.parse(fs.readFileSync(new URL('../../src/core/fixtures/wikivoyage/rome-eat.json', import.meta.url), 'utf8')) as { wikitext: string };
  const root = s.root;
  const out: string[] = [];
  const err: string[] = [];
  const fakeCtx: CliContext = {
    root,
    env: {},
    fetch: async (url, init) => {
      requests.push({ url, ua: (init?.headers as Record<string, string> | undefined)?.['user-agent'] });
      const u = new URL(url);
      if (u.searchParams.get('prop') === 'sections') return new Response(JSON.stringify({ parse: { title: 'Rome', sections: [{ toclevel: 1, level: '2', line: 'Get in', index: '3' }, { toclevel: 1, level: '2', line: 'Eat', index: '9' }, { toclevel: 2, level: '3', line: 'Pizza', index: '10' }] } }));
      if (u.searchParams.get('page') === 'Nowhere') return new Response(JSON.stringify({ error: { code: 'missingtitle' } }));
      return new Response(JSON.stringify({ parse: { title: 'Rome', revid: 4567890, wikitext: rome.wikitext } }));
    },
    stdout: (x) => out.push(x),
    stderr: (x) => err.push(x),
    now: () => new Date('2026-11-07T12:00:00Z'),
    loadCore: async () => ({}) as never,
    loadTrip: async () => ({}) as never,
    ...({ foodThrottle: fast } as object),
  };
  const go = async (...argv: string[]) => {
    out.length = 0;
    err.length = 0;
    return { code: await run(['food', ...argv], fakeCtx), out: out.join(''), err: err.join('') };
  };

  const preview = await go('guide', 'demo', '--city', '羅馬', '--page', 'Rome');
  assert.equal(preview.code, 0);
  const shown = JSON.parse(preview.out);
  assert.deepEqual([shown.found, shown.saved, shown.revision, shown.url], [13, false, '4567890', 'https://en.wikivoyage.org/wiki/Rome']);
  assert.equal(fs.existsSync(path.join(root, 'trips', 'demo', 'food.json')), false, 'without --save nothing is written');
  assert.equal(requests.length, 2);
  assert.ok(requests.every((r) => new URL(r.url).hostname === 'en.wikivoyage.org' && /TripCode/i.test(r.ua ?? '')), 'only Wikivoyage, with a descriptive user agent');
  assert.equal(new URL(requests[1]!.url).searchParams.get('section'), '9', 'the Eat section, found by name');

  const saved = JSON.parse((await go('guide', 'demo', '--city', '羅馬', '--page', 'Rome', '--save')).out);
  assert.equal(saved.added.length, 13);
  const file = JSON.parse(fs.readFileSync(path.join(root, 'trips', 'demo', 'food.json'), 'utf8'));
  assert.equal(file.dishes.length, 13);
  assert.deepEqual(file.attribution, ['Wikivoyage contributors (CC BY-SA 4.0)']);
  assert.equal(file.dishes[0].sources[0].revision, '4567890');

  // Improve a dish by hand; reading the page again must not undo it.
  file.dishes[0].why = '我自己寫的更好的理由';
  fs.writeFileSync(path.join(root, 'trips', 'demo', 'food.json'), JSON.stringify(file));
  assert.deepEqual(JSON.parse((await go('guide', 'demo', '--city', '羅馬', '--page', 'Rome', '--save')).out).added, []);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'trips', 'demo', 'food.json'), 'utf8')).dishes[0].why, '我自己寫的更好的理由');

  assert.equal((await go('guide', 'demo', '--city', 'x', '--page', 'Nowhere')).code, 1);
  assert.equal((await go('guide', 'demo', '--city', 'x', '--page', '../etc/passwd?x=1')).code, 1);
  assert.equal((await go('guide', 'demo', '--city', 'x')).code, 1);
});

test('food near: finds places around the stop before the meal, open then, says when no dish can be tied to a place, and --save keeps the evidence', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tripcode-food-near-'));
  fs.mkdirSync(path.join(root, 'trips', 'demo'), { recursive: true });
  const overpass = fs.readFileSync(new URL('../../src/core/fixtures/overpass/colosseo.json', import.meta.url), 'utf8');
  const fetched: { url: string; method?: string; body?: string; ua?: string }[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const at = (lat: number, lng: number) => ({ lat, lng, fetchedAt: '2026-11-01T00:00:00Z' });
  const trip = {
    title: '羅馬', start: '2026-11-24', end: '2026-11-24', tz: 'Europe/Rome', party: { adults: 2, childrenAges: [] }, candidates: [],
    days: [{ date: '2026-11-24', city: '羅馬', items: [
      { id: 'colosseo', kind: 'poi', title: '競技場', start: '09:00', end: '12:00', loc: at(41.8902, 12.4922) },
      { id: 'forum', kind: 'poi', title: '古羅馬廣場', start: '14:00', end: '17:00', loc: at(41.8925, 12.4853) },
    ] }],
  };
  const ctx: CliContext = {
    root,
    env: {},
    fetch: async (url, init) => {
      fetched.push({ url, method: init?.method, body: String(init?.body ?? ''), ua: (init?.headers as Record<string, string>)?.['user-agent'] });
      return new Response(overpass);
    },
    stdout: (x) => out.push(x),
    stderr: (x) => err.push(x),
    now: () => new Date('2026-11-07T12:00:00Z'),
    loadCore: async () => ({}) as never,
    loadTrip: async () => trip as never,
    ...({ foodThrottle: fast } as object),
  };
  const go = async (...argv: string[]) => {
    out.length = 0;
    err.length = 0;
    return { code: await run(['food', ...argv], ctx), out: out.join(''), err: err.join('') };
  };
  const romeDishes = JSON.parse(fs.readFileSync(new URL('../../src/core/fixtures/wikivoyage/rome-eat.json', import.meta.url), 'utf8')) as { wikitext: string };
  const { dishSeeds, parseEatDishes } = await import('../../src/core/wikivoyage-food.ts');
  const seeds = dishSeeds(parseEatDishes(romeDishes.wikitext), '羅馬', { url: 'https://en.wikivoyage.org/wiki/Rome', title: 'Rome', revision: '1', fetchedAt: '2026-11-07T12:00:00Z' });
  for (const d of seeds.slice(0, 3)) assert.equal((await go('dish', 'add', 'demo', '--json', JSON.stringify(d))).code, 0);

  const r = await go('near', 'demo', '--date', '2026-11-24', '--slot', 'dinner');
  assert.equal(r.code, 0, r.err);
  const json = JSON.parse(r.out);
  assert.equal(fetched.length, 1);
  assert.equal(new URL(fetched[0]!.url).hostname, 'overpass-api.de');
  assert.equal(fetched[0]!.method, 'POST');
  assert.match(decodeURIComponent(fetched[0]!.body!), /around:\d+,41\.8\d+,12\.4\d+/);
  assert.match(fetched[0]!.ua ?? '', /TripCode/i);
  assert.deepEqual([json.anchor.title, json.city, json.generalMode], ['古羅馬廣場', '羅馬', true], 'dinner is after the last stop; no place names a dish');
  assert.ok(json.results.length > 0);
  assert.ok(json.results.every((x: { mapsUrl: string; evidence: { claim: string }[] }) => /^https:\/\/www\.google\.com\/maps\/search/.test(x.mapsUrl) && x.evidence.some((e) => e.claim === 'exists')));
  assert.match(json.note, /沒有評分/);
  assert.equal(fs.existsSync(path.join(root, 'trips', 'demo', 'food.json')) && JSON.parse(fs.readFileSync(path.join(root, 'trips', 'demo', 'food.json'), 'utf8')).places.length, 0, 'without --save nothing is remembered');

  const pretty = await go('near', 'demo', '--date', '2026-11-24', '--slot', 'dinner', '--anchor', 'colosseo', '--pretty');
  assert.match(pretty.out, /在「競技場」附近/);
  assert.match(pretty.out, /無法確認有沒有這道菜/);
  assert.match(pretty.out, /© OpenStreetMap contributors \(ODbL\)/);

  const saved = JSON.parse((await go('near', 'demo', '--date', '2026-11-24', '--slot', 'dinner', '--anchor', 'colosseo', '--limit', '3', '--save')).out);
  assert.equal(saved.saved, true);
  const file = JSON.parse(fs.readFileSync(path.join(root, 'trips', 'demo', 'food.json'), 'utf8'));
  assert.equal(file.places.length, 3);
  assert.ok(file.places.every((p: { evidence: { kind: string; claim: string }[] }) => p.evidence.some((e) => e.kind === 'map-osm' && e.claim === 'exists')));
  assert.ok(file.attribution.includes('© OpenStreetMap contributors (ODbL)'));

  // The search is on the shortlist for the board, and a later search keeps what was learned about a place meanwhile.
  assert.equal(file.shortlist.length, 1);
  assert.deepEqual(file.shortlist[0].items.map((i: { key: string }) => i.key), file.places.map((p: { key: string }) => p.key));
  const kept = file.places[1].key;
  const profile = { summary: '測試：是一家小酒館', sources: ['https://example.com/guide'] };
  assert.equal((await go('profile', 'demo', '--place', kept, '--json', JSON.stringify(profile))).code, 0);
  await go('near', 'demo', '--date', '2026-11-24', '--slot', 'dinner', '--anchor', 'colosseo', '--limit', '3', '--save');
  const after = JSON.parse(fs.readFileSync(path.join(root, 'trips', 'demo', 'food.json'), 'utf8'));
  assert.equal(after.places.find((p: { key: string }) => p.key === kept).profile.summary, '測試：是一家小酒館', 'a new search keeps the introduction');
  assert.equal(after.shortlist.length, 1, 'the same meal replaces its own entry');

  // A rejected place does not come back.
  const gone = file.places[0].key;
  assert.equal((await go('reject', 'demo', '--place', gone, '--reason', 'meh')).code, 0);
  const again = JSON.parse((await go('near', 'demo', '--date', '2026-11-24', '--slot', 'dinner', '--anchor', 'colosseo')).out);
  assert.ok(!again.results.some((x: { key: string }) => x.key === gone));
  assert.equal(again.dropped.rejected, 1);

  assert.equal((await go('near', 'demo', '--date', '2026-11-25', '--slot', 'dinner')).code, 1, 'a day the trip does not have');
  assert.equal((await go('near', 'demo', '--date', '2026-11-24', '--slot', 'brunch')).code, 1);
  assert.equal((await go('near', 'demo', '--date', '2026-11-24', '--slot', 'dinner', '--anchor', 'nope')).code, 1);
});

test('food near: Overpass being busy is a plain message with a way forward, not a stack trace', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tripcode-food-busy-'));
  fs.mkdirSync(path.join(root, 'trips', 'demo'), { recursive: true });
  const err: string[] = [];
  const trip = { title: 'x', start: '2026-11-24', end: '2026-11-24', tz: 'Europe/Rome', party: { adults: 1, childrenAges: [] }, candidates: [], days: [{ date: '2026-11-24', items: [{ id: 'a', kind: 'poi', title: 'A', start: '09:00', end: '11:00', loc: { lat: 41.89, lng: 12.49, fetchedAt: '2026-11-01T00:00:00Z' } }] }] };
  const ctx: CliContext = { root, env: {}, fetch: async () => new Response('busy', { status: 429 }), stdout: () => undefined, stderr: (x) => err.push(x), now: () => new Date('2026-11-07T12:00:00Z'), loadCore: async () => ({}) as never, loadTrip: async () => trip as never, ...({ foodThrottle: fast } as object) };
  assert.equal(await run(['food', 'near', 'demo', '--date', '2026-11-24', '--slot', 'lunch', '--anchor', 'a'], ctx), 1);
  assert.match(err.join(''), /太忙（429／5xx）.*Google 地圖/);
});

test('overpass: a busy first server falls over to the second once; both busy is one plain message', async () => {
  const { fetchFoodElements } = await import('../overpass.ts');
  const { Throttle } = await import('../osm.ts');
  const calls: string[] = [];
  const ok = JSON.stringify({ elements: [{ type: 'node', id: 1, lat: 1, lon: 1, tags: { amenity: 'restaurant', name: 'A' } }] });
  const fast = new Throttle({ sleep: async () => undefined });
  const base = { userAgent: 'x', lat: 41.89, lng: 12.49, radiusM: 500, throttle: fast, endpoints: ['https://one.test/api', 'https://two.test/api'] } as const;
  const failover = await fetchFoodElements({ ...base, fetch: async (url) => { calls.push(url); return url.startsWith('https://one') ? new Response('bad gateway', { status: 502 }) : new Response(ok); } });
  assert.equal(failover.length, 1);
  assert.deepEqual(calls, ['https://one.test/api', 'https://two.test/api']);
  await assert.rejects(fetchFoodElements({ ...base, fetch: async () => new Response('busy', { status: 429 }) }), /太忙/);
  await assert.rejects(fetchFoodElements({ ...base, fetch: async () => { throw new TypeError('fetch failed'); } }), /連不上/);
  await assert.rejects(fetchFoodElements({ ...base, fetch: async () => new Response('<html>busy</html>') }), /太忙/);
  await assert.rejects(fetchFoodElements({ ...base, fetch: async () => new Response('nope', { status: 403 }) }), /HTTP 403/);
});


test('review fixes: quick votes both land; the same dish id in another city gets a suffix; near can read a variant file', async () => {
  const { updateFood, readFood } = await import('../food-store.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tripcode-food-race-'));
  fs.mkdirSync(path.join(root, 'trips', 'demo'), { recursive: true });
  const { putDish, voteDish } = await import('../../src/core/food.ts');
  const dish = (id: string, city: string) => ({ ...DISH, id, city });
  await updateFood(root, 'demo', (f) => putDish(putDish(f, dish('a', '羅馬')), dish('b', '羅馬')));
  await Promise.all([updateFood(root, 'demo', (f) => voteDish(f, 'a', 'want')), updateFood(root, 'demo', (f) => voteDish(f, 'b', 'no'))]);
  assert.deepEqual((await readFood(root, 'demo')).votes, { a: 'want', b: 'no' }, 'neither vote was lost');
  assert.deepEqual(fs.readdirSync(path.join(root, 'trips', 'demo')).filter((f) => f.endsWith('.tmp')), []);

  const { guideForTrip } = await import('../food-service.ts');
  const rome = JSON.parse(fs.readFileSync(new URL('../../src/core/fixtures/wikivoyage/rome-eat.json', import.meta.url), 'utf8')) as { wikitext: string };
  const fetchRome = async (url: string) => (new URL(url).searchParams.get('prop') === 'sections' ? new Response(JSON.stringify({ parse: { title: 'Naples', sections: [{ level: '2', line: 'Eat', index: '2' }] } })) : new Response(JSON.stringify({ parse: { title: 'Naples', revid: 7, wikitext: rome.wikitext } })));
  const deps = { root, fetch: fetchRome, now: () => new Date('2026-11-07T12:00:00Z'), loadTrip: async () => ({}) as never, throttle: fast };
  await updateFood(root, 'demo', (f) => putDish(f, dish('puntarelle', '羅馬')));
  const res = await guideForTrip(deps, 'demo', { city: '拿坡里', page: 'Naples', save: true });
  assert.ok(res.added.includes('puntarelle-naples'), 'same id, other city: kept under a suffix');
  assert.equal((await readFood(root, 'demo')).dishes.filter((d) => d.id === 'puntarelle').length, 1);
  const again = await guideForTrip(deps, 'demo', { city: '拿坡里', page: 'Naples', save: true });
  assert.deepEqual(again.added, [], 'the second read adds nothing');
  assert.ok(again.skipped.length > 0, 'and says what it left alone');
});


test("food guide on a district page also keeps the editors' picks (name, place, edit date), and near ranks the matching shop first", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tripcode-food-listings-'));
  fs.mkdirSync(path.join(root, 'trips', 'demo'), { recursive: true });
  const colosseo = JSON.parse(fs.readFileSync(new URL('../../src/core/fixtures/wikivoyage/colosseo-eat.json', import.meta.url), 'utf8')) as { wikitext: string };
  const overpass = fs.readFileSync(new URL('../../src/core/fixtures/overpass/colosseo.json', import.meta.url), 'utf8');
  const out: string[] = [];
  const at = (lat: number, lng: number) => ({ lat, lng, fetchedAt: '2026-11-01T00:00:00Z' });
  const trip = { title: 'x', start: '2026-11-24', end: '2026-11-24', tz: 'Europe/Rome', party: { adults: 2, childrenAges: [] }, candidates: [], days: [{ date: '2026-11-24', city: '羅馬', items: [{ id: 'colosseo', kind: 'poi', title: '競技場', start: '09:00', end: '12:00', loc: at(41.8902, 12.4922) }] }] };
  const ctx: CliContext = {
    root, env: {}, stdout: (x) => out.push(x), stderr: () => undefined, now: () => new Date('2026-11-07T12:00:00Z'), loadCore: async () => ({}) as never, loadTrip: async () => trip as never,
    fetch: async (url) => {
      const u = new URL(url);
      if (u.hostname === 'overpass-api.de') return new Response(overpass);
      if (u.searchParams.get('prop') === 'sections') return new Response(JSON.stringify({ parse: { title: 'Rome/Colosseo', sections: [{ level: '2', line: 'Eat', index: '4' }] } }));
      return new Response(JSON.stringify({ parse: { title: 'Rome/Colosseo', revid: 5, wikitext: colosseo.wikitext } }));
    },
    ...({ foodThrottle: fast } as object),
  };
  const go = async (...argv: string[]) => {
    out.length = 0;
    return { code: await run(['food', ...argv], ctx), out: out.join('') };
  };
  const g = JSON.parse((await go('guide', 'demo', '--city', '羅馬', '--page', 'Rome/Colosseo', '--save')).out);
  assert.equal(g.listings, 12);
  const file = JSON.parse(fs.readFileSync(path.join(root, 'trips', 'demo', 'food.json'), 'utf8'));
  assert.equal(file.listings.length, 12);
  assert.equal(file.listings[0].source.revision, '5');
  assert.equal(JSON.stringify(file).includes('rating'), false);

  const near = JSON.parse((await go('near', 'demo', '--date', '2026-11-24', '--slot', 'dinner', '--anchor', 'colosseo')).out);
  assert.equal(near.results[0].key, 'osm:node/7082306423', 'the shop the guide lists comes first');
  assert.equal(near.results[0].tier, 'safe');
  assert.ok(near.results[0].why[0].startsWith('旅遊指南（Wikivoyage）列為推薦'));
  assert.ok(near.results.slice(1).every((r: { tier: string }) => r.tier !== 'safe'));
});
