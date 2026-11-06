import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, test } from 'node:test';
import { handleTripcodeRequest, ideaIdOfPath } from './vite-plugin-tripcode.ts';
import type { SourceEdits } from './vite-plugin-tripcode.ts';
import * as realEdits from './src/core/source-edit.ts';
import { EditHistory } from './src/core/history.ts';

const edits = realEdits as unknown as SourceEdits;
const T = 'idea-trip';
let root: string;
const now = () => new Date('2026-11-06T10:00:00.000Z');
const call = (ep: string, body: unknown) => handleTripcodeRequest(ep, body, { root, edits, env: {}, history: new EditHistory(), now });
const exists = (p: string) => access(p).then(() => true, () => false);
const ideaPath = (id = T) => path.join(root, 'trips', id, 'idea.json');
const read = async (id = T) => JSON.parse(await readFile(ideaPath(id), 'utf8'));
const op = (body: Record<string, unknown>) => call('idea', { tripId: T, ...body });

const zurich = { id: 'switzerland', slug: 'switzerland', name: '瑞士', kind: 'country', lat: 46.8, lng: 8.2, tz: 'Europe/Zurich', why: '山和湖' };

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'tripcode-idea-ep-'));
  await mkdir(path.join(root, 'trips'), { recursive: true });
});

/** The page never writes places, so the test plays the AI by writing them through the same IO the CLI uses. */
async function aiSuggests(places: unknown[]) {
  const { updateIdea } = await import('./cli/commands/idea.ts');
  const { addPlaces } = await import('./src/core/idea.ts');
  await updateIdea(root, T, (i) => addPlaces(i, places, now()));
}

async function answerAll() {
  for (const [field, value] of [['known', { decided: false }], ['origin', '台北'], ['focus', 'both'], ['budget', null], ['scenery', null], ['when', { months: [6] }], ['days', 5], ['party', null]] as const) {
    const r = await op({ op: 'answer', field, value });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  }
}

test('idea-new creates trips/<id>/idea.json and refuses an existing folder', async () => {
  const r = await call('idea-new', { tripId: T });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal((r.json as { next: string }).next, 'known');
  assert.equal((await read()).version, 1);
  assert.equal((await call('idea-new', { tripId: T })).status, 400);
  await mkdir(path.join(root, 'trips', 'real-trip'));
  assert.equal((await call('idea-new', { tripId: 'real-trip' })).status, 400);
  assert.deepEqual(await readdir(path.join(root, 'trips', 'real-trip')), []);
});

test('ids cannot climb out of trips/ or be malformed, on every idea endpoint', async () => {
  for (const id of ['../x', 'a/b', 'A', '', undefined, 5]) {
    assert.equal((await call('idea-new', { tripId: id })).status, 400, String(id));
    assert.equal((await call('idea', { tripId: id, op: 'reject-round' })).status, 400, String(id));
    assert.equal((await call('idea-finish', { tripId: id })).status, 400, String(id));
  }
  assert.equal(await exists(path.join(root, 'x')), false);
});

test('idea answers, choose, reject, reject-round and dates return the new idea and the next step', async () => {
  await call('idea-new', { tripId: T });
  await answerAll();
  let r = await op({ op: 'answer', field: 'wantNow', value: true });
  assert.equal((r.json as { next: string }).next, 'suggest');
  await aiSuggests([zurich, { ...zurich, id: 'norway', slug: 'norway', name: '挪威' }]);

  r = await op({ op: 'choose', placeId: 'norway' });
  assert.deepEqual([r.status, (r.json as { next: string }).next], [200, 'dates']);
  assert.equal((r.json as { idea: { chosen: string } }).idea.chosen, 'norway');

  r = await op({ op: 'reject', placeId: 'norway' });
  assert.equal((r.json as { next: string }).next, 'choose');
  r = await op({ op: 'reject-round' });
  assert.equal((r.json as { next: string }).next, 'suggest');

  await aiSuggests([{ ...zurich, id: 'japan', slug: 'japan', name: '日本', tz: 'Asia/Tokyo' }]);
  await op({ op: 'choose', placeId: 'japan' });
  r = await op({ op: 'dates', start: '2027-06-05', end: '2027-06-09' });
  assert.deepEqual([r.status, (r.json as { next: string }).next], [200, 'finish']);
  assert.deepEqual((await read()).dates, { start: '2027-06-05', end: '2027-06-09' });
});

test('invalid operations are refused with 400 and the file is untouched', async () => {
  await call('idea-new', { tripId: T });
  const before = await readFile(ideaPath(), 'utf8');
  const bad: Record<string, unknown>[] = [
    {},
    { op: 'places', places: [zurich] }, // the page never writes places
    { op: 'nope' },
    { op: 'answer', field: 'colour', value: 1 },
    { op: 'answer', field: 'days' },
    { op: 'answer', field: 'days', value: 0 },
    { op: 'answer', field: 'budget', value: { amount: 'lots' } },
    { op: 'answer', field: 'wantNow', value: true }, // before known / origin
    { op: 'choose', placeId: 'zzz' },
    { op: 'choose' },
    { op: 'reject-round' },
    { op: 'dates', start: '2027-06-05', end: '2027-06-09' }, // nothing chosen
  ];
  for (const body of bad) assert.equal((await op(body)).status, 400, JSON.stringify(body));
  assert.equal(await readFile(ideaPath(), 'utf8'), before);
  assert.equal((await call('idea', [] as never)).status, 400);
});

test('idea never creates a folder or a file for a trip that has no idea.json', async () => {
  assert.equal((await op({ op: 'answer', field: 'days', value: 3 })).status, 400);
  assert.equal(await exists(path.join(root, 'trips', T)), false);
  await mkdir(path.join(root, 'trips', 'real-trip'));
  assert.equal((await call('idea', { tripId: 'real-trip', op: 'answer', field: 'days', value: 3 })).status, 400);
  assert.deepEqual(await readdir(path.join(root, 'trips', 'real-trip')), []);
});

test('idea-finish creates the trip, moves idea.json, and reports the new id', async () => {
  await call('idea-new', { tripId: T });
  await answerAll();
  await aiSuggests([zurich]);
  await op({ op: 'choose', placeId: 'switzerland' });
  assert.equal((await call('idea-finish', { tripId: T })).status, 400); // no dates yet
  await op({ op: 'dates', start: '2027-06-05', end: '2027-06-09' });

  assert.equal((await call('idea-finish', { tripId: T, adults: 'two' })).status, 400);
  assert.equal((await call('idea-finish', { tripId: T, childrenAges: [30] })).status, 400);
  assert.equal(await exists(path.join(root, 'trips', 'switzerland-2027-06')), false);

  const r = await call('idea-finish', { tripId: T, title: '瑞士之旅', adults: 2, childrenAges: [6] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const j = r.json as { tripId: string; files: string[] };
  assert.equal(j.tripId, 'switzerland-2027-06');
  assert.ok(j.files.includes('trips/switzerland-2027-06/trip.ts'));
  assert.equal(await exists(path.join(root, 'trips', T)), false);
  const ts = await readFile(path.join(root, 'trips', j.tripId, 'trip.ts'), 'utf8');
  assert.match(ts, /title: '瑞士之旅'/);
  assert.match(ts, /party: \{ adults: 2, childrenAges: \[6\] \}/);
  assert.equal((await read(j.tripId)).tripId, j.tripId);
  // the finished idea can no longer be changed
  assert.equal((await call('idea', { tripId: j.tripId, op: 'answer', field: 'days', value: 3 })).status, 400);
});

test('idea get reads the file; idea-list lists only unfinished ideas, newest first', async () => {
  assert.deepEqual((await call('idea-list', {})).json, { ok: true, ideas: [] });
  await call('idea-new', { tripId: T });
  await op({ op: 'answer', field: 'known', value: { decided: false } });
  const g = await op({ op: 'get' });
  assert.equal(g.status, 200);
  assert.equal((g.json as { next: string }).next, 'origin');
  assert.equal((await call('idea', { tripId: 'nope', op: 'get' })).status, 400);
  assert.equal(await exists(path.join(root, 'trips', 'nope')), false);

  const later = () => new Date('2026-11-07T10:00:00.000Z');
  const { createIdea } = await import('./cli/commands/idea.ts');
  await createIdea(root, 'idea-newer', later());
  await mkdir(path.join(root, 'trips', 'real-trip')); // no idea.json: not listed
  await mkdir(path.join(root, 'trips', 'broken'));
  await writeFile(path.join(root, 'trips', 'broken', 'idea.json'), '{nope'); // skipped, not fatal
  const l = (await call('idea-list', {})).json as { ideas: { id: string; next: string; summary: string[] }[] };
  assert.deepEqual(l.ideas.map((i) => i.id), ['idea-newer', T]);
  assert.deepEqual(l.ideas[1]!.summary, ['目的地：還沒決定']);

  // a finished idea drops out of the list
  await answerAll();
  await aiSuggests([zurich]);
  await op({ op: 'choose', placeId: 'switzerland' });
  await op({ op: 'dates', start: '2027-06-05', end: '2027-06-09' });
  await call('idea-finish', { tripId: T });
  assert.deepEqual(((await call('idea-list', {})).json as { ideas: { id: string }[] }).ideas.map((i) => i.id), ['idea-newer']);
});

test('ideaIdOfPath matches only trips/<id>/idea.json', () => {
  const r = path.join(path.sep, 'repo');
  const t = (...p: string[]) => path.join(r, 'trips', ...p);
  assert.equal(ideaIdOfPath(r, t('a-1', 'idea.json')), 'a-1');
  for (const f of [t('a-1', 'trip.ts'), t('a-1', 'inbox', 'idea.json'), t('idea.json'), t('a-1', 'idea.json.1.tmp'), t('A', 'idea.json'), path.join(r, 'x', 'a', 'idea.json'), path.join(r, 'idea.json')]) {
    assert.equal(ideaIdOfPath(r, f), undefined, f);
  }
});
