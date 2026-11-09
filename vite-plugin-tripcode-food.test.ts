import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, test } from 'node:test';
import { foodIdOfPath, handleTripcodeRequest } from './vite-plugin-tripcode.ts';
import type { SourceEdits } from './vite-plugin-tripcode.ts';
import * as realEdits from './src/core/source-edit.ts';

const edits = realEdits as unknown as SourceEdits;
const T = 'food-trip';
let root: string;
const at = (lat: number, lng: number) => ({ lat, lng, fetchedAt: '2026-11-01T00:00:00Z' });
const TRIP = {
  title: '羅馬', start: '2026-11-24', end: '2026-11-24', tz: 'Europe/Rome', party: { adults: 2, childrenAges: [] }, candidates: [],
  days: [{ date: '2026-11-24', city: '羅馬', items: [{ id: 'colosseo', kind: 'poi', title: '競技場', start: '09:00', end: '12:00', loc: at(41.8902, 12.4922) }, { id: 'forum', kind: 'poi', title: '古羅馬廣場', start: '14:00', end: '17:00', loc: at(41.8925, 12.4853) }] }],
};
const rome = JSON.parse(fs.readFileSync(new URL('./src/core/fixtures/wikivoyage/rome-eat.json', import.meta.url), 'utf8')) as { wikitext: string };
const overpass = fs.readFileSync(new URL('./src/core/fixtures/overpass/colosseo.json', import.meta.url), 'utf8');
const fakeFetch = async (url: string): Promise<Response> => {
  const u = new URL(url);
  if (u.hostname === 'overpass-api.de') return new Response(overpass);
  if (u.searchParams.get('prop') === 'sections') return new Response(JSON.stringify({ parse: { title: 'Rome', sections: [{ level: '2', line: 'Eat', index: '5' }] } }));
  return new Response(JSON.stringify({ parse: { title: 'Rome', revid: 99, wikitext: rome.wikitext } }));
};
// Place photos come from the places' own sites; here every site answers 404, so no test touches the network.
const safe = { fetch: async () => new Response('nope', { status: 404 }), lookup: async () => ['93.184.216.34'] };
const call = (body: unknown) => handleTripcodeRequest('food', body, { root, edits, env: {}, now: () => new Date('2026-11-07T12:00:00Z'), fetch: fakeFetch, loadTrip: async () => TRIP as never, safe });
const foodFile = () => path.join(root, 'trips', T, 'food.json');

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'tripcode-foodep-'));
  await mkdir(path.join(root, 'trips', T), { recursive: true });
});

test('get on a trip with no guide yet is an empty guide, and writes nothing', async () => {
  const r = await call({ tripId: T, op: 'get' });
  assert.equal(r.status, 200);
  assert.deepEqual((r.json as { food: { dishes: unknown[] } }).food.dishes, []);
  assert.equal(fs.existsSync(foodFile()), false);
});

test('guide reads the dishes from Wikivoyage into the file; vote, taste and reject change it; a bad request writes nothing', async () => {
  const g = await call({ tripId: T, op: 'guide', city: '羅馬', page: 'Rome' });
  assert.equal(g.status, 200, JSON.stringify(g.json));
  assert.equal((g.json as { found: number }).found, 13);
  const food = JSON.parse(await readFile(foodFile(), 'utf8'));
  assert.equal(food.dishes.length, 13);

  assert.equal((await call({ tripId: T, op: 'vote', dishId: 'puntarelle', vote: 'want' })).status, 200);
  assert.equal((await call({ tripId: T, op: 'taste', patch: { avoidTags: ['offal'], budget: 'mid' } })).status, 200);
  assert.equal((await call({ tripId: T, op: 'reject', key: 'osm:node/1', reason: 'touristy' })).status, 200);
  const after = JSON.parse(await readFile(foodFile(), 'utf8'));
  assert.deepEqual([after.votes, after.taste.avoidTags, after.taste.budget, after.rejected[0].key], [{ puntarelle: 'want' }, ['offal'], 'mid', 'osm:node/1']);

  const before = await readFile(foodFile(), 'utf8');
  for (const bad of [
    { op: 'vote', dishId: 'nope', vote: 'want' },
    { op: 'vote', dishId: 'puntarelle', vote: 'maybe' },
    { op: 'taste', patch: { budget: 'lots' } },
    { op: 'taste', patch: [] },
    { op: 'reject', key: 'osm:node/2', reason: 'rude' },
    { op: 'guide', city: '羅馬', page: '../x?y' },
    { op: 'near', date: 'tomorrow', slot: 'dinner' },
    { op: 'near', date: '2026-11-24', slot: 'brunch' },
    { op: 'near', date: '2026-11-25', slot: 'dinner' },
    { op: 'mystery' },
    {},
  ]) {
    const r = await call({ tripId: T, ...bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.equal(await readFile(foodFile(), 'utf8'), before);
});

test('near answers with ranked places, evidence and the credit, and does not write unless asked to save', async () => {
  await call({ tripId: T, op: 'guide', city: '羅馬', page: 'Rome' });
  const before = await readFile(foodFile(), 'utf8');
  const r = await call({ tripId: T, op: 'near', date: '2026-11-24', slot: 'dinner', save: false });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const j = r.json as { results: { key: string; evidence: { claim: string }[]; mapsUrl: string }[]; generalMode: boolean; attribution: string; anchor: { title: string } };
  assert.equal(j.anchor.title, '古羅馬廣場');
  assert.ok(j.results.length > 0 && j.results.every((x) => x.evidence.some((e) => e.claim === 'exists') && x.mapsUrl.startsWith('https://www.google.com/maps/')));
  assert.equal(j.generalMode, true);
  assert.match(j.attribution, /OpenStreetMap/);
  assert.equal(await readFile(foodFile(), 'utf8'), before);
  const saved = await call({ tripId: T, op: 'near', date: '2026-11-24', slot: 'dinner', save: true });
  assert.equal(saved.status, 200);
  const file = JSON.parse(await readFile(foodFile(), 'utf8'));
  assert.ok(file.places.length > 0);
  // The search is also kept as a shortlist: that is what the board on the left of the screen shows while the AI talks.
  assert.equal(file.shortlist.length, 1);
  assert.deepEqual([file.shortlist[0].date, file.shortlist[0].slot, file.shortlist[0].anchor], ['2026-11-24', 'dinner', '古羅馬廣場']);
  assert.ok(file.shortlist[0].items.length > 0 && file.shortlist[0].items.every((i: { key: string; mapsUrl: string }) => file.places.some((p: { key: string }) => p.key === i.key) && i.mapsUrl.startsWith('https://')));
  assert.equal(JSON.stringify(file).includes('rating'), false);
  // Asking again for the same meal replaces that entry instead of adding another.
  await call({ tripId: T, op: 'near', date: '2026-11-24', slot: 'dinner', save: true });
  assert.equal(JSON.parse(await readFile(foodFile(), 'utf8')).shortlist.length, 1);
  // The page's own searches (no `save` given) are saved too, so the board shows them.
  await call({ tripId: T, op: 'near', date: '2026-11-24', slot: 'lunch' });
  assert.equal(JSON.parse(await readFile(foodFile(), 'utf8')).shortlist.length, 2);
});

test('a trip folder that does not exist gets nothing written; the watcher recognises food.json only', async () => {
  const r = await handleTripcodeRequest('food', { tripId: 'ghost-trip', op: 'vote', dishId: 'x', vote: 'want' }, { root, edits, env: {} });
  assert.equal(r.status, 400);
  assert.equal(foodIdOfPath('/r', '/r/trips/rome/food.json'), 'rome');
  assert.equal(foodIdOfPath('/r', '/r/trips/rome/trip.ts'), undefined);
  assert.equal(foodIdOfPath('/r', '/r/trips/rome/inbox/food.json'), undefined);
  assert.equal(foodIdOfPath('/r', '/r/trips/Rome/food.json'), undefined);
});
