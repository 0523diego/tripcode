import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, test } from 'node:test';
import { CliError } from '../context.ts';
import { run } from '../tripcode.ts';
import type { BuyContext } from './buy.ts';

let root: string;
let home: string;
let out: string;
let err: string;
let pages: Record<string, string>;
let clock: Date;

const ctx = (): BuyContext => {
  out = '';
  err = '';
  return {
    root,
    env: {},
    home,
    fetch: async (url) => {
      const body = pages[url];
      return body === undefined ? new Response('nope', { status: 404 }) : new Response(body, { status: 200 });
    },
    stdout: (s) => (out += s),
    stderr: (s) => (err += s),
    now: () => clock,
    loadCore: async () => ({}) as never,
    loadTrip: async () => ({}) as never,
    connect: async () => ({ conn: { send: async () => ({ targetInfos: [] }), close() {} } as never, launched: false }),
  };
};

const buy = (...argv: string[]) => run(['buy', ...argv], ctx());
const json = () => JSON.parse(out);
const offer = (price: number) => `<script type="application/ld+json">${JSON.stringify({ '@type': 'Offer', price, priceCurrency: 'EUR' })}</script>`;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'tc-buy-root-'));
  home = await mkdtemp(path.join(tmpdir(), 'tc-buy-home-'));
  await mkdir(path.join(root, 'trips', 'rome'), { recursive: true });
  clock = new Date('2026-11-01T10:00:00Z');
  pages = {};
});

describe('buy watch / scan / alerts', () => {
  test('add, list, scan raises an alert, ack, pause, rm', async () => {
    assert.equal(await buy('watch', 'add', 'rome', '--id', 'hotel', '--title', '羅馬飯店', '--url', 'https://example.com/h', '--target', '100', '--currency', 'EUR'), 0);
    assert.equal(json().watch.everyMinutes, 360);

    pages['https://example.com/h'] = offer(90);
    await buy('scan', 'rome');
    assert.equal(json()[0].alerts[0].kind, 'target');

    await buy('alerts', 'rome');
    assert.equal(json()[0].alerts[0].seen, false);
    await buy('alerts', 'rome', '--ack');
    await buy('alerts', 'rome');
    assert.equal(json()[0].alerts[0].seen, true);

    await buy('watch', 'list', 'rome');
    assert.equal(json()[0].last.amount, 90);

    await buy('watch', 'pause', 'rome', 'hotel');
    clock = new Date('2026-11-02T10:00:00Z');
    await buy('scan', 'rome');
    assert.equal(json()[0].looked, 0);

    await buy('watch', 'rm', 'rome', 'hotel');
    await buy('watch', 'list', 'rome');
    assert.deepEqual(json(), []);
  });

  test('--all scans every trip that has watches', async () => {
    await mkdir(path.join(root, 'trips', 'paris'), { recursive: true });
    await buy('watch', 'add', 'paris', '--id', 'x', '--title', 'X', '--url', 'https://example.com/x', '--drop', '10');
    pages['https://example.com/x'] = offer(50);
    await buy('scan', '--all');
    assert.deepEqual(json().map((r: { tripId: string }) => r.tripId), ['paris']);
  });

  test('rejects abusive input with a readable error', async () => {
    const c = ctx();
    const code = await run(['buy', 'watch', 'add', 'rome', '--id', 'x', '--title', 'X', '--url', 'https://192.168.0.1/x', '--target', '5'], c);
    assert.equal(code, 1);
    assert.match(err, /內網/);
    assert.equal(await buy('watch', 'add', 'nope', '--id', 'x'), 1);
    assert.match(err, /找不到旅程/);
    assert.equal(await buy('watch', 'add', 'rome', '--bogus', '1'), 1);
    assert.match(err, /未知的選項/);
  });
});

test('there is no way to pay: vault, pay, intent and ledger are not commands', async () => {
  for (const argv of [['vault', 'init'], ['pay', 'rome', 'a'], ['pay', 'rome', 'a', '--auto'], ['intent', 'list', 'rome'], ['ledger']]) {
    err = '';
    assert.equal(await buy(...argv), 1, argv.join(' '));
    assert.match(err, /未知的(子指令|選項)/);
  }
});

test('buy with no sub-command prints usage', async () => {
  assert.equal(await buy(), 1);
  assert.match(out, /tripcode buy/);
  assert.ok(CliError);
});
