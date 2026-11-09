import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, test } from 'node:test';
import { handleTripcodeRequest } from './vite-plugin-tripcode.ts';
import type { SourceEdits } from './vite-plugin-tripcode.ts';
import * as realEdits from './src/core/source-edit.ts';
import { EditHistory } from './src/core/history.ts';

const edits = realEdits as unknown as SourceEdits;
const T = 'meal-trip';
const SRC = `import { defineTrip } from '../../src/core/types.ts';
export default defineTrip({
  days: [
    {
      date: '2026-11-24',
      items: [
        { id: 'colosseo', kind: 'poi', title: '競技場', start: '09:00', end: '12:00' },
        { id: 'dinner-tbd', kind: 'meal', title: '晚餐：待選' },
      ],
    },
  ],
});
`;
let root: string;
let history: EditHistory;
const file = () => path.join(root, 'trips', T, 'trip.ts');
const NOW = new Date('2026-11-07T12:00:00Z');
const call = (body: unknown) => handleTripcodeRequest('meal', body, { root, edits, env: {}, history, now: () => NOW });
const AT = '2026-11-07T11:00:00Z';
const PLACE = {
  key: 'osm:node/7082306423',
  name: 'Trattoria Pizzeria Luzzi',
  loc: { lat: 41.8893, lng: 12.4966 },
  dishes: ['carbonara'],
  evidence: [
    { kind: 'map-osm', claim: 'exists', source: 'osm:node/7082306423', fetchedAt: AT, confidence: 'reference' },
    { kind: 'map-osm', claim: 'open-at-slot', source: 'osm:node/7082306423', fetchedAt: AT, confidence: 'reference', detail: 'OSM 營業時間：Th-Tu 12:00-24:00' },
  ],
};

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'tripcode-mealplace-'));
  history = new EditHistory();
  await mkdir(path.join(root, 'trips', T), { recursive: true });
  await writeFile(file(), SRC);
});

test('a place picked from the drawer fills the placeholder: name, coordinates, place id, slot, dishes and checks with their sources', async () => {
  const r = await call({ tripId: T, file: 'trip.ts', date: '2026-11-24', existingItemId: 'dinner-tbd', place: PLACE, slot: 'dinner' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const out = await readFile(file(), 'utf8');
  assert.match(out, /title: 'Trattoria Pizzeria Luzzi'/);
  assert.match(out, /placeId: 'osm:node\/7082306423'/);
  assert.match(out, /slot: 'dinner'/);
  assert.match(out, /dishes: \['carbonara'\]/);
  assert.match(out, /exists: \{ value: true, source: 'osm:node\/7082306423', fetchedAt: '2026-11-07T11:00:00Z', confidence: 'reference' \}/);
  assert.match(out, /openAtSlot: \{ value: true/);
  assert.match(out, /loc: \{ lat: 41\.8893, lng: 12\.4966, fetchedAt: '2026-11-07T12:00:00Z' \}/);
  assert.doesNotMatch(out, /rating|userRatingCount/i, 'no rating is ever written');
  assert.equal((out.match(/id: 'dinner-tbd'/g) ?? []).length, 1, 'the placeholder was filled, not duplicated');
});

test('with no placeholder a new meal item is added in the day, carrying the same fields', async () => {
  const r = await call({ tripId: T, file: 'trip.ts', date: '2026-11-24', place: PLACE, slot: 'dinner' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const out = await readFile(file(), 'utf8');
  assert.match(out, /kind: 'meal'[^}]*title: 'Trattoria Pizzeria Luzzi'|title: 'Trattoria Pizzeria Luzzi'[^}]*kind: 'meal'/s);
  assert.match(out, /checks: \{ exists:/);
});

test('one undo takes the choice back', async () => {
  await call({ tripId: T, file: 'trip.ts', date: '2026-11-24', existingItemId: 'dinner-tbd', place: PLACE });
  const u = await handleTripcodeRequest('undo', { tripId: T, file: 'trip.ts' }, { root, edits, env: {}, history });
  assert.equal(u.status, 200, JSON.stringify(u.json));
  assert.equal(await readFile(file(), 'utf8'), SRC);
});

test('a place with no proof that it exists, a bad key or a bad slot is refused and the file is untouched', async () => {
  const bad: Record<string, unknown>[] = [
    { place: { ...PLACE, evidence: [] } },
    { place: { ...PLACE, evidence: [PLACE.evidence[1]] } },
    { place: { ...PLACE, key: 'x y' } },
    { place: { ...PLACE, loc: { lat: 99, lng: 0 } } },
    { place: { ...PLACE, rating: 4.8 } },
    { place: { ...PLACE, evidence: [{ ...PLACE.evidence[0], rating: 4.8 }] } },
    { place: PLACE, slot: 'tea' },
    { place: { ...PLACE, dishes: ['Not Kebab'] } },
  ];
  for (const b of bad) {
    const r = await call({ tripId: T, file: 'trip.ts', date: '2026-11-24', existingItemId: 'dinner-tbd', ...b });
    assert.equal(r.status, 400, JSON.stringify(b));
  }
  assert.equal(await readFile(file(), 'utf8'), SRC);
});

test('the old way still works: a pasted Google Maps link fills the placeholder', async () => {
  const r = await call({ tripId: T, file: 'trip.ts', date: '2026-11-24', existingItemId: 'dinner-tbd', mapsUrl: 'https://www.google.com/maps/place/Da+Enzo/@41.88,12.47,17z/data=!3d41.8884!4d12.4770' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.match(await readFile(file(), 'utf8'), /title: 'Da Enzo'/);
});

test('proof must come from a map and name this place: the AI\'s memory, another place\'s proof, a closed claim and a rating in a label are refused', async () => {
  const ev = (over: Record<string, unknown>) => ({ ...PLACE.evidence[0], ...over });
  const refused: Record<string, unknown>[] = [
    { place: { ...PLACE, evidence: [ev({ kind: 'ai-memory', source: 'I remember it' })] } },
    { place: { ...PLACE, evidence: [ev({ source: 'osm:node/999' })] } },
    { place: { ...PLACE, evidence: [PLACE.evidence[0], ev({ claim: 'closed-at-slot' })] } },
    { place: { ...PLACE, evidence: [PLACE.evidence[0], ev({ claim: 'permanently-closed' })] } },
  ];
  for (const b of refused) assert.equal((await call({ tripId: T, file: 'trip.ts', date: '2026-11-24', existingItemId: 'dinner-tbd', ...b })).status, 400, JSON.stringify(b).slice(0, 80));
  assert.equal(await readFile(file(), 'utf8'), SRC);
  const rated = ev({ kind: 'web', claim: 'recommended', source: 'https://example.com/guide', detail: 'Google 4.8★' });
  const ok = await call({ tripId: T, file: 'trip.ts', date: '2026-11-24', existingItemId: 'dinner-tbd', place: { ...PLACE, evidence: [PLACE.evidence[0], rated] } });
  assert.equal(ok.status, 200);
  assert.doesNotMatch(await readFile(file(), 'utf8'), /4\.8|★|recommendedBy/, 'a recommendation whose label carries a rating is dropped, not written');
});
