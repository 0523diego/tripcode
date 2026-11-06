import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { guardRequest } from '../../vite-plugin-tripcode.ts';
import type { AgentProvider } from './provider.ts';
import { createAgentRoutes, isLoopbackRequest, parseContext, parseModel, parseRespond } from './routes.ts';
import { createSessionStore } from './store.ts';
import type { AgentSession, AgentStatus } from './types.ts';

const provider: AgentProvider = {
  name: 'Fake',
  sdkPackage: '@fake/sdk',
  cliCommand: 'fake-cli-that-does-not-exist',
  askInstruction: 'ask',
  canRewind: true,
  models: () => [{ id: 'opus', label: 'Opus', efforts: ['low'] }],
  async run(o) {
    o.emit({ type: 'text-start', id: 't' });
    o.emit({ type: 'text-end', id: 't', text: `echo: ${o.prompt.split('\n')[0]}` });
  },
};

async function withServer(
  enabled: boolean,
  fn: (call: (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: any }>, base: string) => Promise<void>, // eslint-disable-line @typescript-eslint/no-explicit-any
) {
  const store = createSessionStore();
  const routes = createAgentRoutes({ root: '/nonexistent-root', guard: (h, o) => guardRequest(h, { requireJson: o.requireJson }), enabled, provider, store });
  const server = createServer((req, res) => {
    const prefix = '/__agent';
    req.url = (req.url ?? '/').slice(prefix.length) || '/';
    void routes.handle(req, res, () => {
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}/__agent${path}`, {
      method,
      headers: { ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : method === 'POST' ? { body: '{}' } : {}),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  try {
    await fn(call, base);
  } finally {
    routes.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

test('parse helpers accept only well-formed input', () => {
  assert.deepEqual(parseContext({ tripId: 'italy-2026-11', file: 'variant-b.ts', day: 2.7, itemId: 'a_b-1', tripTitle: 'x'.repeat(500) }), {
    tripId: 'italy-2026-11',
    file: 'variant-b.ts',
    day: 2,
    itemId: 'a_b-1',
    tripTitle: 'x'.repeat(120),
  });
  assert.deepEqual(parseContext({ tripId: '../etc', file: '../x.ts', itemId: 'a b', day: 'x' }), {});
  assert.deepEqual(parseContext({ tripId: 'zz-idea', idea: true }), { tripId: 'zz-idea', idea: true });
  assert.deepEqual(parseContext({ tripId: 'zz-idea', idea: 'yes' }), { tripId: 'zz-idea' }); // only a real boolean true
  assert.equal(parseContext(null), undefined);
  assert.equal(parseModel('opus'), 'opus');
  assert.equal(parseModel('bad model!'), null);
  assert.equal(parseModel(5), null);
  assert.deepEqual(parseRespond({ cancel: true }), { cancel: true });
  assert.deepEqual(parseRespond({ allow: false }), { allow: false });
  assert.deepEqual(parseRespond({ answers: { q: 'a', n: 3 } }), { answers: { q: 'a' } });
  assert.equal(parseRespond({}), null);
  assert.equal(parseRespond('x'), null);
});

test('only loopback sockets count as this machine', () => {
  const sock = (remoteAddress?: string) => ({ socket: { remoteAddress } }) as never;
  assert.equal(isLoopbackRequest(sock('127.0.0.1')), true);
  assert.equal(isLoopbackRequest(sock('::1')), true);
  assert.equal(isLoopbackRequest(sock('::ffff:127.0.0.1')), true);
  assert.equal(isLoopbackRequest(sock('192.168.1.5')), false);
  assert.equal(isLoopbackRequest(sock(undefined)), false);
});

test('status: reports the SDK as not installed here, with the provider models', async () => {
  await withServer(true, async (call) => {
    const { status, body } = await call('GET', '/status');
    assert.equal(status, 200);
    const s = body as AgentStatus;
    assert.equal(s.enabled, true);
    assert.equal(s.sdkInstalled, false);
    assert.equal(s.sdkPackage, '@fake/sdk');
    assert.equal(s.cliFound, false);
    assert.equal(s.models[0]?.id, 'opus');
  });
});

test('when disabled the panel sees enabled:false and every other route is 404', async () => {
  await withServer(false, async (call) => {
    assert.equal((await call('GET', '/status')).body.enabled, false);
    assert.equal((await call('GET', '/sessions')).status, 404);
    assert.equal((await call('POST', '/sessions', {})).status, 404);
  });
});

test('browser-origin protection: foreign Origin, cross-site fetches and non-JSON POSTs are refused', async () => {
  await withServer(true, async (call, base) => {
    assert.equal((await call('GET', '/sessions', undefined, { origin: 'http://evil.example' })).status, 403);
    assert.equal((await call('GET', '/sessions', undefined, { 'sec-fetch-site': 'cross-site' })).status, 403);
    const form = await fetch(`${base}/__agent/sessions`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
    assert.equal(form.status, 415);
    assert.equal((await call('GET', '/sessions', undefined, { origin: base })).status, 200);
  });
});

test('session lifecycle: create, send a message, read it back, delete', async () => {
  await withServer(true, async (call) => {
    const created = await call('POST', '/sessions', { tripId: 'italy-2026-11' });
    assert.equal(created.status, 200);
    const id = (created.body as AgentSession).id;
    assert.equal((created.body as AgentSession).tripId, 'italy-2026-11');

    assert.equal((await call('POST', `/sessions/${id}/messages`, { text: '  ' })).status, 400);
    assert.equal((await call('POST', `/sessions/${id}/messages`, { text: 'hi', edit: 'nope' })).status, 400);
    const sent = await call('POST', `/sessions/${id}/messages`, { text: '你好', context: { tripId: 'italy-2026-11' }, model: 'opus', effort: 'low' });
    assert.equal(sent.status, 202);

    let session: AgentSession | undefined;
    for (let i = 0; i < 100; i++) {
      session = (await call('GET', `/sessions/${id}`)).body as AgentSession;
      if (session.status === 'idle' && session.items.some((x) => x.kind === 'result')) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.deepEqual(
      session?.items.map((i) => i.kind),
      ['user', 'assistant', 'result'],
    );
    const reply = session?.items[1];
    assert.equal(reply?.kind === 'assistant' && reply.text, 'echo: 你好');

    assert.equal(((await call('GET', '/sessions')).body as { sessions: unknown[] }).sessions.length, 1);
    assert.equal((await call('POST', `/sessions/${id}/stop`)).body.ok, false, 'nothing running');
    assert.equal((await call('POST', `/sessions/${id}/respond`, { itemId: 'x', allow: true })).status, 409);
    assert.equal((await call('POST', `/sessions/${id}/respond`, { nonsense: true })).status, 400);
    assert.equal((await call('DELETE', `/sessions/${id}`)).status, 200);
    assert.equal((await call('GET', `/sessions/${id}`)).status, 404);
  });
});

test('events: new sessions and items are pushed over server-sent events', async () => {
  await withServer(true, async (call, base) => {
    const res = await fetch(`${base}/__agent/events`);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const readUntil = async (needle: string) => {
      for (let i = 0; i < 50 && !text.includes(needle); i++) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
      }
    };
    await readUntil(': connected');
    const { body } = await call('POST', '/sessions', {});
    await readUntil('"type":"session"');
    assert.ok(text.includes(`"id":"${(body as AgentSession).id}"`));
    await reader.cancel();
  });
});
