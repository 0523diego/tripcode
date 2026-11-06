import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, test } from 'node:test';
import type { CliContext } from '../context.ts';
import { checkTrip } from '../../src/core/index.ts';
import { run } from '../tripcode.ts';
import { createIdea, finishIdea, readIdea, updateIdea, writeIdea } from './idea.ts';
import { applyAnswer } from '../../src/core/idea.ts';

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'tripcode-idea-'));
  // The generated trip.ts imports ../../src/core/types.ts relative to <root>/trips/<id>/.
  await mkdir(path.join(root, 'src', 'core'), { recursive: true });
  await writeFile(path.join(root, 'src', 'core', 'types.ts'), await readFile(path.join(import.meta.dirname, '..', '..', 'src', 'core', 'types.ts')));
  let out = '';
  let err = '';
  const ctx: CliContext = {
    root,
    env: {},
    fetch: async () => new Response('{}'),
    stdout: (s) => (out += s),
    stderr: (s) => (err += s),
    now: () => new Date('2026-11-06T10:00:00.000Z'),
    loadCore: async () => (await import('../../src/core/index.ts')) as never,
    loadTrip: async (file) => (await import(pathToFileURL(file).href)).default,
  };
  const exec = async (...argv: string[]) => {
    out = '';
    err = '';
    const code = await run(argv, ctx);
    return { code, out, err };
  };
  const json = async (...argv: string[]) => {
    const r = await exec(...argv);
    assert.equal(r.code, 0, r.err);
    return JSON.parse(r.out);
  };
  return { root, ctx, exec, json };
}

const switzerland = {
  id: 'switzerland', slug: 'switzerland', name: '瑞士', kind: 'country', country: '瑞士', lat: 46.8, lng: 8.2, tz: 'Europe/Zurich',
  why: '山和湖都在你要的 6 月最好看', bestMonths: [6, 7, 8, 9], cost: { text: '每人約 TWD 8 萬（估計）' },
};
const norway = { ...switzerland, id: 'norway', slug: 'norway', name: '挪威', tz: 'Europe/Oslo' };
const japan = { ...switzerland, id: 'japan', slug: 'japan', name: '日本', kind: 'country', tz: 'Asia/Tokyo' };

async function toFinish(s: Awaited<ReturnType<typeof setup>>, id = 'zz-idea', create = true) {
  if (create) await s.json('idea', 'new', id);
  await s.json('idea', 'answer', id, 'known', '{"decided":false}');
  await s.json('idea', 'answer', id, 'origin', '台北');
  await s.json('idea', 'answer', id, 'focus', '"both"');
  await s.json('idea', 'answer', id, 'budget', '{"amount":60000,"currency":"TWD","per":"person"}');
  await s.json('idea', 'answer', id, 'scenery', '{"tags":["mountains","food"],"text":"想泡溫泉"}');
  await s.json('idea', 'answer', id, 'when', '{"months":[6]}');
  await s.json('idea', 'answer', id, 'days', '5');
  await s.json('idea', 'answer', id, 'party', '{"who":"friends","adults":3,"childrenAges":[]}');
  await s.json('idea', 'places', id, '--json', JSON.stringify([switzerland, norway, japan]));
  await s.json('idea', 'choose', id, 'switzerland');
  return s.json('idea', 'dates', id, '--start', '2027-06-05', '--end', '2027-06-09');
}

describe('tripcode idea: whole flow', () => {
  test('new → answers → places → choose → dates → finish', async () => {
    const s = await setup();
    const created = await s.json('idea', 'new', 'zz-idea');
    assert.deepEqual(created, { ok: true, tripId: 'zz-idea', file: 'trips/zz-idea/idea.json', next: 'known' });

    const r = await toFinish(s, 'zz-idea', false);
    assert.equal(r.next, 'finish');

    const shown = await s.json('idea', 'show', 'zz-idea');
    assert.equal(shown.next, 'finish');
    assert.equal(shown.idea.chosen, 'switzerland');
    assert.deepEqual(shown.idea.places.map((p: { status: string }) => p.status), ['chosen', 'shown', 'shown']);
    assert.ok(shown.summary.includes('出發地：台北'));

    const fin = await s.json('idea', 'finish', 'zz-idea', '--children', '5,8');
    assert.equal(fin.ok, true);
    assert.equal(fin.tripId, 'switzerland-2027-06');
    assert.equal(fin.ideaFolderRemoved, true);
    assert.deepEqual(fin.files, [
      'trips/switzerland-2027-06/trip.ts',
      'trips/switzerland-2027-06/brief.md',
      'trips/switzerland-2027-06/inbox/.gitkeep',
      'trips/switzerland-2027-06/idea.json',
    ]);

    const trips = await readdir(path.join(s.root, 'trips'));
    assert.deepEqual(trips, ['switzerland-2027-06']); // the old folder is gone
    const dir = path.join(s.root, 'trips', 'switzerland-2027-06');
    const ts = await readFile(path.join(dir, 'trip.ts'), 'utf8');
    assert.match(ts, /title: '瑞士 5 天'/);
    assert.match(ts, /tz: 'Europe\/Zurich'/);
    assert.match(ts, /start: '2027-06-05'/);
    assert.match(ts, /party: \{ adults: 3, childrenAges: \[5, 8\] \}/);
    const brief = await readFile(path.join(dir, 'brief.md'), 'utf8');
    assert.match(brief, /目的地 \/ 熟悉度：瑞士 \/ （待填）/);
    assert.match(brief, /出發地：台北/);
    assert.match(brief, /- 每人 TWD 60000/);
    assert.match(brief, /- 想看：山、美食（想泡溫泉）/);
    assert.match(brief, /第 0 步/);
    const idea = JSON.parse(await readFile(path.join(dir, 'idea.json'), 'utf8'));
    assert.equal(idea.tripId, 'switzerland-2027-06');
    assert.deepEqual((await json2(s, 'switzerland-2027-06')).next, 'done');

    // the generated trip is a valid trip
    const trip = await s.ctx.loadTrip(path.join(dir, 'trip.ts'));
    assert.equal(trip.days.length, 5);
    assert.deepEqual(checkTrip(trip).filter((i) => i.level === 'error'), []);
  });

  test('the suggested id gets -2 when taken; --title, --tz, --trip-id are honoured', async () => {
    const s = await setup();
    await mkdir(path.join(s.root, 'trips', 'switzerland-2027-06'), { recursive: true });
    await toFinish(s);
    const fin = await s.json('idea', 'finish', 'zz-idea', '--title', '我的瑞士', '--tz', 'Europe/Zurich');
    assert.equal(fin.tripId, 'switzerland-2027-06-2');
    assert.match(await readFile(path.join(s.root, 'trips', fin.tripId, 'trip.ts'), 'utf8'), /title: '我的瑞士'/);

    const s2 = await setup();
    await toFinish(s2);
    const fin2 = await s2.json('idea', 'finish', 'zz-idea', '--trip-id', 'ch-trip');
    assert.equal(fin2.tripId, 'ch-trip');
  });

  test('cover.jpg moves along; other leftovers keep the old folder', async () => {
    const s = await setup();
    await toFinish(s);
    await writeFile(path.join(s.root, 'trips', 'zz-idea', 'cover.jpg'), 'jpg');
    const fin = await s.json('idea', 'finish', 'zz-idea');
    assert.equal(fin.ideaFolderRemoved, true);
    assert.equal(await readFile(path.join(s.root, 'trips', fin.tripId, 'cover.jpg'), 'utf8'), 'jpg');

    const s2 = await setup();
    await toFinish(s2);
    await writeFile(path.join(s2.root, 'trips', 'zz-idea', 'notes.txt'), 'hi');
    const fin2 = await s2.json('idea', 'finish', 'zz-idea');
    assert.equal(fin2.ideaFolderRemoved, false);
    assert.deepEqual(fin2.leftover, ['notes.txt']);
    assert.deepEqual(await readdir(path.join(s2.root, 'trips', 'zz-idea')), ['notes.txt']); // idea.json was moved, not copied
  });

  test('the new id may equal the idea id: the folder is reused in place', async () => {
    const s = await setup();
    await toFinish(s, 'switzerland-2027-06');
    const fin = await s.json('idea', 'finish', 'switzerland-2027-06');
    assert.equal(fin.tripId, 'switzerland-2027-06');
    const names = await readdir(path.join(s.root, 'trips', 'switzerland-2027-06'));
    assert.deepEqual(names.sort(), ['brief.md', 'idea.json', 'inbox', 'trip.ts']);
    assert.equal((await readIdea(s.root, 'switzerland-2027-06')).tripId, 'switzerland-2027-06');
  });

  test('uses destinations/<slug>.md for a country that has notes', async () => {
    const s = await setup();
    await mkdir(path.join(s.root, 'destinations'));
    await writeFile(path.join(s.root, 'destinations', 'switzerland.md'), '# x');
    await toFinish(s);
    const fin = await s.json('idea', 'finish', 'zz-idea');
    assert.match(await readFile(path.join(s.root, 'trips', fin.tripId, 'trip.ts'), 'utf8'), /destination: 'switzerland'/);
  });

  test('finish before it is time, and twice, is refused', async () => {
    const s = await setup();
    await s.json('idea', 'new', 'zz-idea');
    const early = await s.exec('idea', 'finish', 'zz-idea');
    assert.equal(early.code, 1);
    assert.match(early.err, /還不能建立行程/);
    await toFinish(s, 'zz-idea2');
    await s.json('idea', 'finish', 'zz-idea2');
    assert.equal((await s.exec('idea', 'finish', 'zz-idea2')).code, 1);
  });

  test('an existing target trip is never overwritten', async () => {
    const s = await setup();
    await toFinish(s);
    await mkdir(path.join(s.root, 'trips', 'taken'));
    const r = await s.exec('idea', 'finish', 'zz-idea', '--trip-id', 'taken');
    assert.equal(r.code, 1);
    assert.match(r.err, /已存在/);
    assert.deepEqual((await readdir(path.join(s.root, 'trips'))).sort(), ['taken', 'zz-idea']);
    assert.equal((await readIdea(s.root, 'zz-idea')).tripId, undefined);
  });
});

async function json2(s: Awaited<ReturnType<typeof setup>>, id: string) {
  return s.json('idea', 'show', id);
}

describe('tripcode idea: commands', () => {
  test('new refuses an existing folder and bad ids', async () => {
    const s = await setup();
    await mkdir(path.join(s.root, 'trips', 'exists'), { recursive: true });
    const a = await s.exec('idea', 'new', 'exists');
    assert.equal(a.code, 1);
    assert.match(a.err, /已存在/);
    assert.equal((await s.exec('idea', 'new', '../x')).code, 1);
    assert.equal((await s.exec('idea', 'new', 'Bad_Id')).code, 1);
    assert.equal((await s.exec('idea', 'new')).code, 1);
  });

  test('answer: JSON values, null, and bare strings for origin / known', async () => {
    const s = await setup();
    await s.json('idea', 'new', 'zz-a');
    await s.json('idea', 'answer', 'zz-a', 'known', '瑞士');
    await s.json('idea', 'answer', 'zz-a', 'origin', '"台北 桃園"');
    let i = (await s.json('idea', 'show', 'zz-a')).idea;
    assert.deepEqual(i.known, { decided: true, place: '瑞士' });
    assert.equal(i.origin, '台北 桃園');
    await s.json('idea', 'answer', 'zz-a', 'origin', 'null');
    await s.json('idea', 'answer', 'zz-a', 'days', 'null');
    await s.json('idea', 'answer', 'zz-a', 'want-now', 'true');
    i = (await s.json('idea', 'show', 'zz-a')).idea;
    assert.equal(i.origin, null);
    assert.equal(i.days, null);
    assert.equal(i.wantNow, true);
  });

  test('answer: bad field, bad JSON, bad value, missing value', async () => {
    const s = await setup();
    await s.json('idea', 'new', 'zz-a');
    for (const argv of [
      ['idea', 'answer', 'zz-a', 'colour', '"red"'],
      ['idea', 'answer', 'zz-a', 'days', 'five'],
      ['idea', 'answer', 'zz-a', 'days', '0'],
      ['idea', 'answer', 'zz-a', 'budget', '{"amount":5}'],
      ['idea', 'answer', 'zz-a', 'days'],
      ['idea', 'answer', 'zz-missing', 'days', '3'],
    ]) {
      const r = await s.exec(...argv);
      assert.equal(r.code, 1, argv.join(' '));
      assert.match(r.err, /^錯誤：/);
    }
    assert.equal((await readIdea(s.root, 'zz-a')).days, undefined);
  });

  test('places: --file, {places:[…]}, validation errors write nothing', async () => {
    const s = await setup();
    await s.json('idea', 'new', 'zz-a');
    for (const [f, v] of [['known', '{"decided":false}'], ['origin', 'null'], ['focus', '"both"'], ['budget', 'null'], ['scenery', 'null'], ['when', 'null'], ['days', 'null'], ['party', 'null']] as const) {
      await s.json('idea', 'answer', 'zz-a', f, v);
    }
    const bad = await s.exec('idea', 'places', 'zz-a', '--json', JSON.stringify([{ ...switzerland, lat: 200 }]));
    assert.equal(bad.code, 1);
    assert.match(bad.err, /lat/);
    assert.equal((await readIdea(s.root, 'zz-a')).places.length, 0);
    assert.equal((await s.exec('idea', 'places', 'zz-a')).code, 1);
    assert.equal((await s.exec('idea', 'places', 'zz-a', '--json', '[]', '--file', 'x.json')).code, 1);
    assert.equal((await s.exec('idea', 'places', 'zz-a', '--file', 'nope.json')).code, 1);
    await writeFile(path.join(s.root, 'round.json'), JSON.stringify({ places: [switzerland, norway] }));
    const ok = await s.json('idea', 'places', 'zz-a', '--file', 'round.json');
    assert.equal(ok.next, 'choose');
  });

  test('reject, reject-round and re-suggest', async () => {
    const s = await setup();
    await toFinish(s);
    await s.json('idea', 'reject', 'zz-idea', 'switzerland');
    assert.equal((await s.json('idea', 'show', 'zz-idea')).next, 'choose');
    assert.equal((await s.json('idea', 'reject-round', 'zz-idea')).next, 'suggest');
    const again = await s.json('idea', 'places', 'zz-idea', '--json', JSON.stringify([{ ...switzerland, id: 'austria', slug: 'austria', name: '奧地利' }]));
    assert.equal(again.next, 'choose');
    assert.equal((await s.exec('idea', 'choose', 'zz-idea', 'nope')).code, 1);
  });

  test('known = yes: one located place is chosen automatically', async () => {
    const s = await setup();
    await s.json('idea', 'new', 'zz-b');
    await s.json('idea', 'answer', 'zz-b', 'known', '瑞士');
    await s.json('idea', 'answer', 'zz-b', 'origin', '台北');
    await s.json('idea', 'answer', 'zz-b', 'want-now', 'true');
    assert.equal((await s.json('idea', 'show', 'zz-b')).next, 'locate');
    const r = await s.json('idea', 'places', 'zz-b', '--json', JSON.stringify([switzerland]));
    assert.equal(r.next, 'dates');
  });

  test('dates are validated', async () => {
    const s = await setup();
    await toFinish(s);
    for (const [a, b] of [['2027-06-09', '2027-06-05'], ['2027-02-30', '2027-03-02'], ['2027-1-1', '2027-1-3']]) {
      assert.equal((await s.exec('idea', 'dates', 'zz-idea', '--start', a!, '--end', b!)).code, 1);
    }
    assert.equal((await s.exec('idea', 'dates', 'zz-idea', '--start', '2027-06-05')).code, 1);
  });

  test('show --pretty names the step, what to ask, and the places', async () => {
    const s = await setup();
    await s.json('idea', 'new', 'zz-p');
    let r = await s.exec('idea', 'show', 'zz-p', '--pretty');
    assert.match(r.out, /^第 0 步：找方向/);
    assert.match(r.out, /還沒有回答/);
    assert.match(r.out, /下一步：known — 決定好要去哪了嗎/);
    assert.match(r.out, /tripcode idea answer zz-p known/);
    await toFinish(s, 'zz-q');
    r = await s.exec('idea', 'show', 'zz-q', '--pretty');
    assert.match(r.out, /出發地：台北/);
    assert.match(r.out, /第 1 輪的點子：/);
    assert.match(r.out, /\[chosen\] 瑞士（id: switzerland/);
    assert.match(r.out, /\[shown\] 挪威/);
    assert.match(r.out, /每人約 TWD 8 萬（估計）/);
    assert.match(r.out, /下一步：finish/);
  });

  test('help and unknown sub-commands', async () => {
    const s = await setup();
    const h = await s.exec('idea', '--help');
    assert.equal(h.code, 0);
    assert.match(h.out, /idea finish/);
    assert.equal((await s.exec('idea')).code, 1);
    const u = await s.exec('idea', 'frobnicate', 'x');
    assert.equal(u.code, 1);
    assert.match(u.err, /未知的 idea 子指令/);
  });

  test('a hand-edited, invalid idea.json is reported, not trusted', async () => {
    const s = await setup();
    await s.json('idea', 'new', 'zz-a');
    await writeFile(path.join(s.root, 'trips', 'zz-a', 'idea.json'), JSON.stringify({ version: 1, createdAt: 'x', updatedAt: 'y', places: [] }));
    const r = await s.exec('idea', 'show', 'zz-a');
    assert.equal(r.code, 1);
    assert.match(r.err, /createdAt/);
    await writeFile(path.join(s.root, 'trips', 'zz-a', 'idea.json'), '{nope');
    assert.match((await s.exec('idea', 'show', 'zz-a')).err, /不是有效的 JSON/);
  });
});

describe('idea IO helpers', () => {
  test('createIdea / updateIdea / writeIdea round-trip and leave no temp files', async () => {
    const s = await setup();
    const now = new Date('2026-11-06T10:00:00.000Z');
    await createIdea(s.root, 'zz-io', now);
    await updateIdea(s.root, 'zz-io', (i) => applyAnswer(i, { field: 'origin', value: '台北' }, now));
    assert.equal((await readIdea(s.root, 'zz-io')).origin, '台北');
    await assert.rejects(() => writeIdea(s.root, 'zz-io', { version: 1 } as never));
    assert.deepEqual(await readdir(path.join(s.root, 'trips', 'zz-io')), ['idea.json']);
    await assert.rejects(() => createIdea(s.root, 'zz-io', now), /已存在/);
    await assert.rejects(() => finishIdea(s.root, 'zz-io', {}, now), /還不能建立行程/);
  });
});
