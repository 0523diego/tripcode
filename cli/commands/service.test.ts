import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, test } from 'node:test';
import { CliError } from '../context.ts';
import type { CliContext } from '../context.ts';
import { LABEL, buildPlist, logPath, plistPath, serviceCommand, servicePath } from './service.ts';
import type { ExecResult, ServiceDeps } from './service.ts';

let root: string;
let home: string;
let out: string;
let calls: string[];
let loaded: boolean;
let up: boolean;
let bootstrapFails: number;

const ctx = (): CliContext => ({ root, env: {}, fetch: async () => new Response(''), stdout: (s) => (out += s), stderr: () => {}, now: () => new Date(), loadCore: async () => ({}) as never, loadTrip: async () => ({}) as never });
const deps = (over: Partial<ServiceDeps> = {}): ServiceDeps => ({
  platform: 'darwin',
  home,
  uid: 501,
  node: '/usr/local/bin/node',
  exec: async (cmd, args): Promise<ExecResult> => {
    calls.push(`${cmd} ${args.join(' ')}`);
    if (args[0] === 'print') return { code: loaded ? 0 : 113, stdout: loaded ? '\tpid = 4242\n' : '', stderr: '' };
    if (args[0] === 'bootstrap') {
      if (bootstrapFails-- > 0) return { code: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' };
      loaded = true;
      up = true;
    }
    if (args[0] === 'bootout') {
      loaded = false;
      up = false;
    }
    return { code: 0, stdout: '', stderr: '' };
  },
  reachable: async () => up,
  sleep: async () => {},
  ...over,
});

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'tc-svc-root-'));
  home = await mkdtemp(path.join(tmpdir(), 'tc-svc-home-'));
  await mkdir(path.join(root, 'node_modules', 'vite', 'bin'), { recursive: true });
  await writeFile(path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '');
  out = '';
  calls = [];
  loaded = false;
  up = false;
  bootstrapFails = 0;
});

describe('buildPlist', () => {
  const plist = buildPlist({ node: '/usr/local/bin/node', root: "/Users/me/trip & code's", port: 5288, home: '/Users/me', logFile: '/Users/me/Library/Logs/tripcode-dev.log' });
  test('starts the dev server on a fixed port, from the project folder, at login, and keeps it alive', () => {
    assert.match(plist, new RegExp(`<key>Label</key>\\s*<string>${LABEL}</string>`));
    assert.match(plist, /<string>\/usr\/local\/bin\/node<\/string>/);
    assert.match(plist, /node_modules\/vite\/bin\/vite\.js/);
    assert.match(plist, /<string>--port<\/string>\s*<string>5288<\/string>\s*<string>--strictPort<\/string>/);
    assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
    assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  });
  test('never exposes the server to the network', () => {
    assert.ok(!plist.includes('--host'), 'no --host: Vite stays on localhost');
  });
  test('paths with & and quotes are escaped', () => {
    assert.match(plist, /trip &amp; code&apos;s/);
    assert.ok(!/trip & code/.test(plist));
  });
  test('launchd gets a PATH that finds node, brew and the user bin folders', () => {
    const p = servicePath('/opt/nvm/v24/bin/node', '/Users/me');
    assert.ok(p.startsWith('/opt/nvm/v24/bin:') && p.includes('/opt/homebrew/bin') && p.includes('/Users/me/.local/bin'));
  });
});

describe('tripcode service', () => {
  test('install writes the plist, bootstraps it, waits until the page answers, and says the address', async () => {
    assert.equal(await serviceCommand(ctx(), ['install'], deps()), 0);
    assert.match(await readFile(plistPath(home), 'utf8'), /com\.tripcode\.dev/);
    assert.equal((await stat(plistPath(home))).mode & 0o777, 0o644);
    assert.ok(calls.some((c) => c === `launchctl bootstrap gui/501 ${plistPath(home)}`));
    assert.match(out, /http:\/\/localhost:5288\//);
  });
  test('install again replaces the running one instead of failing', async () => {
    await serviceCommand(ctx(), ['install'], deps());
    calls = [];
    assert.equal(await serviceCommand(ctx(), ['install', '--port', '5300'], deps()), 0);
    assert.ok(calls.findIndex((c) => c.includes('bootout')) < calls.findIndex((c) => c.includes('bootstrap')));
    assert.match(await readFile(plistPath(home), 'utf8'), /<string>5300<\/string>/);
  });
  test('a first bootstrap failure is retried once after clearing the old registration', async () => {
    bootstrapFails = 1;
    assert.equal(await serviceCommand(ctx(), ['install'], deps()), 0);
    assert.equal(calls.filter((c) => c.includes('bootstrap')).length, 2);
  });
  test('refuses to install over something else that already answers on the port', async () => {
    up = true;
    await assert.rejects(serviceCommand(ctx(), ['install'], deps()), /已經有東西在跑/);
    assert.equal(calls.some((c) => c.includes('bootstrap')), false);
  });
  test('needs npm install first, and only works on macOS', async () => {
    await assert.rejects(serviceCommand({ ...ctx(), root: home }, ['install'], deps()), /npm install/);
    await assert.rejects(serviceCommand(ctx(), ['install'], deps({ platform: 'linux' })), /只支援 macOS/);
  });
  test('uninstall stops it and removes the file; status and logs report', async () => {
    await serviceCommand(ctx(), ['install'], deps());
    out = '';
    assert.equal(await serviceCommand(ctx(), ['status'], deps()), 0);
    assert.match(out, /已安裝（程序 4242）/);
    assert.match(out, /連得上/);
    await mkdir(path.dirname(logPath(home)), { recursive: true });
    await writeFile(logPath(home), 'ready in 300 ms\n');
    out = '';
    await serviceCommand(ctx(), ['logs'], deps());
    assert.match(out, /ready in 300 ms/);
    out = '';
    await serviceCommand(ctx(), ['uninstall'], deps());
    await assert.rejects(stat(plistPath(home)));
    assert.equal(await serviceCommand(ctx(), ['status'], deps()), 1);
    assert.match(out, /沒有安裝/);
  });
  test('a port outside 1024–65535 and an unknown sub-command are refused', async () => {
    await assert.rejects(serviceCommand(ctx(), ['install', '--port', '80'], deps()), CliError);
    await assert.rejects(serviceCommand(ctx(), ['frobnicate'], deps()), /未知的子指令/);
  });
});
