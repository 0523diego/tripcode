import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, test } from 'node:test';
import type { CliContext } from './context.ts';
import { checkTrip } from '../src/core/index.ts';
import { run } from './tripcode.ts';

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'tripcode-new-'));
  // The generated trip.ts imports ../../src/core/types.ts relative to <root>/trips/<id>/.
  await mkdir(path.join(root, 'src', 'core'), { recursive: true });
  await writeFile(path.join(root, 'src', 'core', 'types.ts'), await readFile(path.join(import.meta.dirname, '..', 'src', 'core', 'types.ts')));
  let out = '';
  let err = '';
  const ctx: CliContext = {
    root,
    env: {},
    fetch: async () => new Response('{}'),
    stdout: (s) => (out += s),
    stderr: (s) => (err += s),
    now: () => new Date('2026-10-16T10:00:00.000Z'),
    loadCore: async () => (await import('../src/core/index.ts')) as never,
    loadTrip: async (file) => (await import(pathToFileURL(file).href)).default,
  };
  return { root, ctx, get out() { return out; }, get err() { return err; } };
}

const BASE = ['new', 'demo-trip', '--title', '東京 3 天', '--start', '2026-11-01', '--end', '2026-11-03', '--tz', 'Asia/Tokyo'];

describe('tripcode new', () => {
  test('creates trip.ts, brief.md, inbox/.gitkeep and prints JSON', async () => {
    const s = await setup();
    const code = await run([...BASE, '--adults', '2', '--children', '5,8', '--destination', 'japan', '--style', 'default'], s.ctx);
    assert.equal(code, 0, s.err);
    const res = JSON.parse(s.out);
    assert.equal(res.ok, true);
    assert.equal(res.tripId, 'demo-trip');
    assert.deepEqual(res.files, ['trips/demo-trip/trip.ts', 'trips/demo-trip/brief.md', 'trips/demo-trip/inbox/.gitkeep']);
    assert.deepEqual(res.warnings, ['找不到 destinations/japan.md', '找不到 styles/default.md']);
    const dir = path.join(s.root, 'trips', 'demo-trip');
    const ts = await readFile(path.join(dir, 'trip.ts'), 'utf8');
    assert.match(ts, /from '\.\.\/\.\.\/src\/core\/types\.ts'/);
    assert.match(ts, /title: '東京 3 天'/);
    assert.match(ts, /tz: 'Asia\/Tokyo'/);
    assert.match(ts, /party: \{ adults: 2, childrenAges: \[5, 8\] \}/);
    assert.match(ts, /destination: 'japan'/);
    assert.match(ts, /style: 'default'/);
    assert.match(ts, /\{ date: '2026-11-01', items: \[\] \},\n\s+\{ date: '2026-11-02', items: \[\] \},\n\s+\{ date: '2026-11-03', items: \[\] \},/);
    assert.match(ts, /candidates: \[\],/);
    const brief = await readFile(path.join(dir, 'brief.md'), 'utf8');
    assert.match(brief, /^# 東京 3 天 旅程簡報/);
    assert.match(brief, /2026-11-01 ~ 2026-11-03（3 天，時區 Asia\/Tokyo）/);
    assert.match(brief, /2 位成人、2 位小孩（5、8 歲）/);
    for (const h of ['## 基本', '## 已確定（locked）', '## 一定 / 絕不', '## 偏好（比較題結果）', '## 預算與取捨', '## 待確認']) assert.ok(brief.includes(h), h);
    assert.deepEqual(await readdir(path.join(dir, 'inbox')), ['.gitkeep']);
  });

  test('defaults: 2 adults, no children, omits style/destination; --pretty', async () => {
    const s = await setup();
    assert.equal(await run([...BASE, '--pretty'], s.ctx), 0, s.err);
    assert.match(s.out, /已建立 trips\/demo-trip\/（3 天）/);
    const ts = await readFile(path.join(s.root, 'trips', 'demo-trip', 'trip.ts'), 'utf8');
    assert.match(ts, /party: \{ adults: 2, childrenAges: \[\] \}/);
    assert.doesNotMatch(ts, /style:|destination:/);
  });

  test('titles with quotes are escaped', async () => {
    const s = await setup();
    const argv = [...BASE];
    argv[3] = "Tom's \\ trip";
    assert.equal(await run(argv, s.ctx), 0, s.err);
    const trip = await s.ctx.loadTrip(path.join(s.root, 'trips', 'demo-trip', 'trip.ts'));
    assert.equal(trip.title, "Tom's \\ trip");
  });

  test('line breaks (including a lone CR) in the title do not break the generated file', async () => {
    const s = await setup();
    const argv = [...BASE];
    argv[3] = 'a\rb\u2028c';
    assert.equal(await run(argv, s.ctx), 0, s.err);
    const trip = await s.ctx.loadTrip(path.join(s.root, 'trips', 'demo-trip', 'trip.ts'));
    assert.equal(trip.title, 'a\nb\nc');
  });

  test('generated trip loads and passes checkTrip', async () => {
    const s = await setup();
    assert.equal(await run([...BASE, '--children', '5'], s.ctx), 0, s.err);
    const trip = await s.ctx.loadTrip(path.join(s.root, 'trips', 'demo-trip', 'trip.ts'));
    assert.equal(trip.days.length, 3);
    assert.deepEqual(trip.party, { adults: 2, childrenAges: [5] });
    const issues = checkTrip(trip);
    assert.deepEqual(issues.filter((i) => i.level === 'error'), []);
  });

  test('refuses to overwrite an existing trip', async () => {
    const s = await setup();
    await mkdir(path.join(s.root, 'trips', 'demo-trip'), { recursive: true });
    await writeFile(path.join(s.root, 'trips', 'demo-trip', 'trip.ts'), '// mine');
    assert.equal(await run(BASE, s.ctx), 1);
    assert.match(s.err, /已存在/);
    assert.equal(await readFile(path.join(s.root, 'trips', 'demo-trip', 'trip.ts'), 'utf8'), '// mine');
  });

  const bad: [string, string[], RegExp][] = [
    ['bad tripId', ['new', 'Bad_ID', ...BASE.slice(2)], /無效的 tripId/],
    ['missing tripId', ['new', ...BASE.slice(2)], /請提供 tripId/],
    ['missing title', BASE.filter((_, i) => i !== 2 && i !== 3), /缺少 --title/],
    ['missing start', BASE.filter((_, i) => i !== 4 && i !== 5), /缺少 --start/],
    ['bad date format', swap(BASE, '2026-11-01', '2026/11/01'), /無效的日期 --start/],
    ['impossible date', swap(BASE, '2026-11-03', '2026-02-30'), /無效的日期 --end/],
    ['start after end', swap(BASE, '2026-11-01', '2026-11-09'), /不可晚於/],
    ['missing tz', BASE.slice(0, -2), /缺少 --tz/],
    ['bad tz', swap(BASE, 'Asia/Tokyo', 'Mars/Base'), /無效的時區/],
    ['bad adults', [...BASE, '--adults', '0'], /無效的 --adults/],
    ['bad children', [...BASE, '--children', '5,x'], /無效的 --children/],
    ['child too old', [...BASE, '--children', '30'], /無效的 --children/],
    ['bad destination', [...BASE, '--destination', 'Japan'], /無效的 --destination/],
    ['bad style', [...BASE, '--style', 'a b'], /無效的 --style/],
    ['too many days', swap(BASE, '2026-11-03', '2028-01-01'), /最多 366 天/],
  ];
  for (const [name, argv, re] of bad) {
    test(`rejects ${name} and writes nothing`, async () => {
      const s = await setup();
      assert.equal(await run(argv, s.ctx), 1);
      assert.match(s.err, re);
      await assert.rejects(readdir(path.join(s.root, 'trips')));
    });
  }
});

function swap(argv: string[], from: string, to: string): string[] {
  return argv.map((a) => (a === from ? to : a));
}
