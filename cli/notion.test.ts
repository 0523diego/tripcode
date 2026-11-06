import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, test } from 'node:test';
import type { CliContext, Core } from './context.ts';
import { NOTION_VERSION, NotionApiError, NotionClient, batchBlocks, normalizePageId, syncTrip } from './notion.ts';
import type { NotionState } from './notion.ts';
import type { NotionBlock } from './notion-render.ts';
import type { Trip } from '../src/core/types.ts';
import { run } from './tripcode.ts';

interface Call { method: string; url: string; body?: any; form?: FormData; headers: Record<string, string> }
const PAGE = '11111111-2222-3333-4444-555555555555';

function fakeNotion(opts: { existingChildren?: string[]; pageStatus?: number; failAppend?: (n: number) => Response | undefined } = {}) {
  const calls: Call[] = [];
  let uploadN = 0;
  let appendN = 0;
  const json = (o: unknown, status = 200, h: Record<string, string> = {}) => new Response(JSON.stringify(o), { status, headers: h });
  const fetch = async (url: string, init: RequestInit = {}) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    const call: Call = { method: init.method ?? 'GET', url: url.replace('https://api.notion.com/v1', ''), body, headers: init.headers as Record<string, string> };
    if (init.body instanceof FormData) call.form = init.body;
    calls.push(call);
    const u = call.url;
    if (call.method === 'POST' && u === '/pages') return json({ id: PAGE, url: 'https://notion.so/p' });
    if (call.method === 'GET' && u === `/pages/${PAGE}`) return opts.pageStatus ? json({ code: 'object_not_found', message: 'gone' }, opts.pageStatus) : json({ id: PAGE, url: 'https://notion.so/p' });
    if (call.method === 'PATCH' && u === `/pages/${PAGE}`) return json({});
    if (call.method === 'GET' && u.startsWith(`/blocks/${PAGE}/children`)) return json({ results: (opts.existingChildren ?? []).map((id) => ({ id })), has_more: false });
    if (call.method === 'DELETE') return json({});
    if (call.method === 'POST' && u === '/file_uploads') return json({ id: `up-${++uploadN}` });
    if (call.method === 'POST' && u.endsWith('/send')) return json({ status: 'uploaded' });
    if (call.method === 'PATCH' && u.endsWith('/children')) {
      const f = opts.failAppend?.(++appendN);
      return f ?? json({ results: [] });
    }
    return json({ message: 'unexpected ' + u }, 500);
  };
  return { fetch, calls };
}

const noSleep = async () => {};
const para = (t: string): NotionBlock => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: t } }] } });

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'tripcode-notion-'));
  await mkdir(path.join(dir, 'tickets'));
  await writeFile(path.join(dir, 'tickets', 'a.pdf'), 'PDFDATA');
});

function sync(f: ReturnType<typeof fakeNotion>, blocks: NotionBlock[], state: NotionState, extra: object = {}) {
  const warnings: string[] = [];
  const saves: string[] = [];
  const client = new NotionClient({ token: 'secret_TOKEN', fetch: f.fetch, sleep: noSleep });
  const p = syncTrip({ client, title: 'T', parentPageId: 'PARENT', blocks, tripDir: dir, state, save: async (s) => void saves.push(JSON.stringify(s)), warn: (m) => warnings.push(m), ...extra });
  return { p, warnings, saves };
}

const attBlock = (file: string): NotionBlock => ({ object: 'block', type: 'pdf', pdf: { type: 'file_upload', file_upload: { id: '' } }, _attach: { file, label: 'L' } });

describe('syncTrip', () => {
  test('create: page under parent, then children appended, headers carry version', async () => {
    const f = fakeNotion();
    const { p } = sync(f, [para('a')], { files: {} });
    const r = await p;
    assert.equal(r.created, true);
    assert.equal(f.calls[0]!.url, '/pages');
    assert.deepEqual(f.calls[0]!.body.parent, { type: 'page_id', page_id: 'PARENT' });
    assert.equal(f.calls[0]!.headers['Notion-Version'], NOTION_VERSION);
    assert.equal(f.calls[0]!.headers.Authorization, 'Bearer secret_TOKEN');
    assert.equal(f.calls.at(-1)!.url, `/blocks/${PAGE}/children`);
  });
  test('update: keeps page, deletes old children, re-appends', async () => {
    const f = fakeNotion({ existingChildren: ['b1', 'b2'] });
    const r = await sync(f, [para('a')], { files: {} }, { existingPageId: PAGE }).p;
    assert.equal(r.created, false);
    assert.ok(!f.calls.some((c) => c.method === 'POST' && c.url === '/pages'));
    assert.deepEqual(f.calls.filter((c) => c.method === 'DELETE').map((c) => c.url), ['/blocks/b1', '/blocks/b2']);
  });
  test('missing/archived page is recreated', async () => {
    const f = fakeNotion({ pageStatus: 404 });
    const r = await sync(f, [para('a')], { files: {} }, { existingPageId: PAGE }).p;
    assert.equal(r.created, true);
  });
  test('batches of at most 100 blocks', async () => {
    const f = fakeNotion();
    await sync(f, Array.from({ length: 250 }, (_, i) => para(String(i))), { files: {} }).p;
    const sizes = f.calls.filter((c) => c.method === 'PATCH' && c.url.endsWith('/children')).map((c) => c.body.children.length);
    assert.deepEqual(sizes, [100, 100, 50]);
    assert.equal(batchBlocks([]).length, 0);
  });
  test('attachment: create upload, send multipart, attach by id, cache hash', async () => {
    const f = fakeNotion();
    const state: NotionState = { files: {} };
    const { p } = sync(f, [attBlock('tickets/a.pdf')], state);
    const r = await p;
    assert.equal(r.uploaded, 1);
    const urls = f.calls.map((c) => `${c.method} ${c.url}`);
    assert.deepEqual(urls.slice(-3), ['POST /file_uploads', 'POST /file_uploads/up-1/send', `PATCH /blocks/${PAGE}/children`]);
    const send = f.calls.find((c) => c.url.endsWith('/send'))!;
    assert.ok(send.form!.get('file') instanceof Blob);
    assert.equal(send.headers['Content-Type'], undefined);
    const attached = f.calls.at(-1)!.body.children[0];
    assert.deepEqual(attached.pdf.file_upload, { id: 'up-1' });
    assert.ok(!('_attach' in attached));
    assert.equal(state.files['tickets/a.pdf']!.fileUploadId, 'up-1');
    assert.equal(state.files['tickets/a.pdf']!.sha256.length, 64);
  });
  test('unchanged attachment is not re-uploaded; changed one is', async () => {
    const state: NotionState = { files: {} };
    await sync(fakeNotion(), [attBlock('tickets/a.pdf')], state).p;
    const f2 = fakeNotion();
    const r2 = await sync(f2, [attBlock('tickets/a.pdf')], state, { existingPageId: PAGE }).p;
    assert.equal(r2.uploaded, 0);
    assert.equal(r2.reused, 1);
    assert.ok(!f2.calls.some((c) => c.url === '/file_uploads'));
    assert.deepEqual(f2.calls.at(-1)!.body.children[0].pdf.file_upload, { id: 'up-1' });
    await writeFile(path.join(dir, 'tickets', 'a.pdf'), 'NEW');
    const f3 = fakeNotion();
    const r3 = await sync(f3, [attBlock('tickets/a.pdf')], state, { existingPageId: PAGE }).p;
    assert.equal(r3.uploaded, 1);
  });
  test('stale cached upload id: 400 on append triggers one fresh upload', async () => {
    const state: NotionState = { files: {} };
    await sync(fakeNotion(), [attBlock('tickets/a.pdf')], state).p;
    const f = fakeNotion({ failAppend: (n) => (n === 1 ? new Response(JSON.stringify({ code: 'validation_error', message: 'expired' }), { status: 400 }) : undefined) });
    const r = await sync(f, [attBlock('tickets/a.pdf')], state, { existingPageId: PAGE }).p;
    assert.equal(r.uploaded, 1);
  });
  test('missing file becomes a warning paragraph, sync continues', async () => {
    const f = fakeNotion();
    const { p, warnings } = sync(f, [attBlock('tickets/none.pdf')], { files: {} });
    await p;
    assert.match(warnings[0]!, /找不到附件/);
    assert.equal(f.calls.at(-1)!.body.children[0].type, 'paragraph');
  });
  test('path traversal is refused', async () => {
    const f = fakeNotion();
    const { p, warnings } = sync(f, [attBlock('../../etc/passwd')], { files: {} });
    await p;
    assert.match(warnings[0]!, /不在行程資料夾/);
  });
});

describe('NotionClient', () => {
  test('429 honours Retry-After, then succeeds', async () => {
    let n = 0;
    const sleeps: number[] = [];
    const client = new NotionClient({
      token: 't',
      sleep: async (ms) => void sleeps.push(ms),
      fetch: async () => (++n === 1 ? new Response('{"code":"rate_limited","message":"slow"}', { status: 429, headers: { 'Retry-After': '2' } }) : new Response('{"id":"x"}')),
    });
    await client.getPage('p');
    assert.ok(sleeps.includes(2000));
    assert.equal(n, 2);
  });
  test('errors show Notion message and never the token', async () => {
    const client = new NotionClient({ token: 'secret_ABC', sleep: noSleep, fetch: async () => new Response('{"code":"object_not_found","message":"Could not find page"}', { status: 404 }) });
    await assert.rejects(client.getPage('p'), (e: Error) => e instanceof NotionApiError && /Could not find page/.test(e.message) && /Connections/.test(e.message) && !e.message.includes('secret_ABC'));
  });
  test('throttles to the minimum interval', async () => {
    const sleeps: number[] = [];
    const client = new NotionClient({ token: 't', minIntervalMs: 1000, sleep: async (ms) => void sleeps.push(ms), fetch: async () => new Response('{}') });
    await client.getPage('a');
    await client.getPage('b');
    assert.ok(sleeps.some((s) => s > 0 && s <= 1000));
  });
});

describe('normalizePageId', () => {
  test('url, bare and dashed ids', () => {
    assert.equal(normalizePageId('https://www.notion.so/My-Trips-0123456789abcdef0123456789abcdef?pvs=4'), '01234567-89ab-cdef-0123-456789abcdef');
    assert.equal(normalizePageId('01234567-89ab-cdef-0123-456789abcdef'), '01234567-89ab-cdef-0123-456789abcdef');
    assert.equal(normalizePageId('nope'), undefined);
  });
});

describe('export notion command', () => {
  const trip: Trip = {
    title: '瑞士', start: '2026-05-02', end: '2026-05-02', tz: 'Europe/Zurich', party: { adults: 2, childrenAges: [] },
    days: [{ date: '2026-05-02', items: [{ id: 'a', kind: 'poi', title: 'A', start: '09:00', attachments: [{ file: 'tickets/a.pdf', label: 'T' }] }] }],
    candidates: [],
  };
  const core: Core = { checkTrip: () => [], dayMapsLinks: () => [], tripToIcs: () => '' };
  let root: string;
  let out: string;
  let err: string;
  let f: ReturnType<typeof fakeNotion>;
  const ctx = (env: Record<string, string>): CliContext => {
    out = err = '';
    f = fakeNotion();
    return { root, env, fetch: f.fetch as never, stdout: (s) => (out += s), stderr: (s) => (err += s), now: () => new Date(2026, 4, 1, 18, 5), loadCore: async () => core, loadTrip: async () => trip };
  };
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'tripcode-notion-cmd-'));
    await mkdir(path.join(root, 'trips', 'swiss', 'tickets'), { recursive: true });
    await writeFile(path.join(root, 'trips', 'swiss', 'trip.ts'), '//');
    await writeFile(path.join(root, 'trips', 'swiss', 'tickets', 'a.pdf'), 'X');
  });

  test('--dry-run prints blocks, makes no network call, needs no token', async () => {
    const c = ctx({});
    assert.equal(await run(['export', 'notion', 'swiss', '--dry-run'], c), 0);
    assert.equal(f.calls.length, 0);
    const j = JSON.parse(out);
    assert.equal(j.dryRun, true);
    assert.equal(j.children[0].type, 'callout');
    assert.deepEqual(j.children.at(-1).bulleted_list_item.children[0].pdf.file_upload, { id: '<upload:tickets/a.pdf>' });
  });
  test('missing token / parent give Traditional Chinese setup help', async () => {
    assert.equal(await run(['export', 'notion', 'swiss'], ctx({})), 1);
    assert.match(err, /NOTION_TOKEN[\s\S]*integrations/);
    assert.equal(await run(['export', 'notion', 'swiss'], ctx({ NOTION_TOKEN: 'secret_Z' })), 1);
    assert.match(err, /NOTION_PARENT_PAGE_ID/);
    assert.ok(!err.includes('secret_Z'));
    assert.equal(f.calls.length, 0);
  });
  test('first sync creates page and writes .notion.json; second sync updates it', async () => {
    const env = { NOTION_TOKEN: 'secret_Z', NOTION_PARENT_PAGE_ID: 'https://notion.so/x-0123456789abcdef0123456789abcdef' };
    assert.equal(await run(['export', 'notion', 'swiss'], ctx(env)), 0);
    assert.equal(JSON.parse(out).created, true);
    assert.equal(f.calls[0]!.body.parent.page_id, '01234567-89ab-cdef-0123-456789abcdef');
    const st = JSON.parse(await readFile(path.join(root, 'trips', 'swiss', '.notion.json'), 'utf8'));
    assert.equal(st.pageId, PAGE);
    assert.ok(st.files['tickets/a.pdf']);
    assert.ok(!JSON.stringify(st).includes('secret_Z'));

    assert.equal(await run(['export', 'notion', 'swiss'], ctx({ NOTION_TOKEN: 'secret_Z' })), 0); // no parent needed any more
    const j = JSON.parse(out);
    assert.equal(j.created, false);
    assert.equal(j.uploaded, 0);
    assert.equal(j.reused, 1);
  });
  test('Notion errors are reported without the token', async () => {
    const c = ctx({ NOTION_TOKEN: 'secret_Z', NOTION_PARENT_PAGE_ID: '0123456789abcdef0123456789abcdef' });
    c.fetch = async () => new Response('{"code":"unauthorized","message":"API token is invalid."}', { status: 401 });
    assert.equal(await run(['export', 'notion', 'swiss'], c), 1);
    assert.match(err, /API token is invalid/);
    assert.ok(!err.includes('secret_Z'));
  });
});
