import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, test } from 'node:test';
import { activityPath, logActivity, readActivity } from './activity.ts';
import { readOffice, scanWithActivity } from './office.ts';
import { createBuyRoutes } from './routes.ts';
import { loadAlerts, purchaseDir, saveWatches, validateWatch } from './store.ts';

const NOW = new Date('2026-11-01T12:00:00Z');
const offer = (price: number) => `<script type="application/ld+json">${JSON.stringify({ '@type': 'Offer', price, priceCurrency: 'EUR' })}</script>`;

let root: string;
let home: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'tc-office-root-'));
  home = await mkdtemp(path.join(tmpdir(), 'tc-office-home-'));
  await mkdir(path.join(root, 'trips', 'rome'), { recursive: true });
  await mkdir(path.join(root, 'trips', 'empty'), { recursive: true });
});

describe('activity log', () => {
  test('keeps short lines and reads the newest back', async () => {
    for (let i = 0; i < 5; i++) await logActivity(home, { at: `2026-11-01T12:0${i}:00Z`, actor: 'browser', text: `step ${i}` });
    await logActivity(home, { at: NOW.toISOString(), actor: 'scout', text: 'x'.repeat(500) });
    const a = await readActivity(home, 3);
    assert.equal(a.length, 3);
    assert.equal(a.at(-1)!.text.length, 160);
    assert.equal(a[0]!.text, 'step 3');
  });
});

describe('readOffice', () => {
  test('a fresh machine: only the asked-for trip is listed, and whether Chrome is there', async () => {
    const s = await readOffice({ root, home, now: NOW, tripId: 'empty', env: { TRIPCODE_CHROME: '/nonexistent' } });
    assert.deepEqual(s.setup, { chrome: false });
    assert.deepEqual(s.trips.map((t) => t.id), ['empty']);
  });

  test('shows watches with their price history, alerts and the activity log', async () => {
    const dir = purchaseDir(root, 'rome');
    await mkdir(dir, { recursive: true });
    const pages: Record<string, string> = { 'https://www.klook.com/a': offer(100) };
    await saveWatches(dir, [validateWatch({ id: 'tour', title: '巨石陣', url: 'https://www.klook.com/a', currency: 'EUR', targetPrice: 99 }, NOW)]);
    await scanWithActivity({ root, home, tripId: 'rome', fetch: async (u) => new Response(pages[u] ?? '', { status: pages[u] ? 200 : 404 }), now: () => NOW, force: true });
    pages['https://www.klook.com/a'] = offer(95);
    await scanWithActivity({ root, home, tripId: 'rome', fetch: async (u) => new Response(pages[u]!, { status: 200 }), now: () => new Date(NOW.getTime() + 3600_000 * 7), force: true });

    const s = await readOffice({ root, home, now: NOW });
    const rome = s.trips.find((t) => t.id === 'rome')!;
    assert.deepEqual(rome.watches[0]!.history, [100, 95]);
    assert.equal(rome.watches[0]!.lowest, 95);
    assert.ok(rome.alerts.length >= 1);
    assert.ok(s.activity.some((a) => a.actor === 'scout' && /巨石陣/.test(a.text)));
  });

  test('the activity log keeps no secrets: short sentences only', async () => {
    await logActivity(home, { at: NOW.toISOString(), actor: 'browser', text: '打開 www.louvre.fr' });
    assert.ok(!(await readFile(activityPath(home), 'utf8')).includes('?'));
  });
});

describe('/__buy routes', () => {
  async function serve(guardOk = true) {
    const routes = createBuyRoutes({ root, home, now: () => NOW, guard: () => (guardOk ? null : { status: 403, error: 'nope' }), fetch: async () => new Response(offer(90), { status: 200 }) });
    const server = http.createServer((req, res) => routes.handle(req, res, () => { res.statusCode = 404; res.end('{}'); }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  }

  test('state, scan and ack work; there is nothing else to call', async () => {
    const dir = purchaseDir(root, 'rome');
    await mkdir(dir, { recursive: true });
    await saveWatches(dir, [validateWatch({ id: 'tour', title: '巨石陣', url: 'https://www.klook.com/a', currency: 'EUR', targetPrice: 99 }, NOW)]);
    const { server, url } = await serve();
    const post = (p: string, body: unknown) => fetch(url + p, { method: 'POST', body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: (await r.json()) as Record<string, any> }));
    try {
      const state = (await (await fetch(`${url}/state?trip=rome`)).json()) as { trips: { id: string }[] };
      assert.equal(state.trips[0]!.id, 'rome');
      assert.equal((await post('/scan', { tripId: 'rome', force: true })).json.looked, 1);
      assert.ok((await loadAlerts(dir)).length >= 1);
      assert.equal((await post('/ack', { tripId: 'rome' })).json.acked >= 1, true);
      assert.equal((await loadAlerts(dir)).every((a) => a.seen), true);
      assert.equal((await post('/scan', { tripId: '../etc' })).status, 400);
      for (const p of ['/pay', '/vault', '/cancel', '/bought', '/autopilot-off']) assert.equal((await post(p, {})).status, 404, p);
    } finally {
      server.close();
    }
  });

  test('the request guard is respected', async () => {
    const { server, url } = await serve(false);
    try {
      assert.equal((await fetch(`${url}/state`)).status, 403);
    } finally {
      server.close();
    }
  });
});
