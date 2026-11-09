import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentProvider, ProviderRunOptions } from './provider.ts';
import { createAgentRunner } from './runner.ts';
import { closePending, createSessionStore } from './store.ts';
import type { AgentItem, AgentStreamEvent } from './types.ts';

type Script = (opts: ProviderRunOptions) => Promise<void>;

function fakeProvider(script: Script, canRewind = true): AgentProvider {
  return { name: 'Fake', sdkPackage: 'fake', cliCommand: 'fake', askInstruction: 'ask', canRewind, models: () => [], run: script };
}

function setup(script: Script, canRewind = true) {
  const store = createSessionStore();
  const events: AgentStreamEvent[] = [];
  store.subscribe((e) => events.push(e));
  const runner = createAgentRunner({ userCwd: '/work', writableRoots: ['/work/trips'], store, provider: fakeProvider(script, canRewind) });
  const session = store.create(null);
  return { store, events, runner, session };
}

async function idle(store: ReturnType<typeof createSessionStore>, id: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (store.get(id)?.status === 'idle') return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('session never went idle');
}

const kinds = (items: AgentItem[]) => items.map((i) => i.kind);

test('a turn streams text and tool calls into the session, then reports a result', async () => {
  const { store, runner, session } = setup(async (o) => {
    o.emit({ type: 'session-id', id: 'prov-1' });
    o.emit({ type: 'text-start', id: 't1' });
    o.emit({ type: 'text-delta', id: 't1', text: '好，' });
    o.emit({ type: 'text-delta', id: 't1', text: '改了。' });
    o.emit({ type: 'text-end', id: 't1', text: '好，改了。' });
    o.emit({ type: 'tool-start', id: 'x1', name: 'Edit', title: '編輯', detail: 'trips/a/trip.ts' });
    o.emit({ type: 'tool-end', id: 'x1', ok: true });
    o.emit({ type: 'result', durationMs: 12, costUsd: 0.01 });
  });
  await runner.send(session.id, { text: '把第一天排鬆' });
  assert.equal(store.get(session.id)?.status, 'running');
  await idle(store, session.id);
  const s = store.get(session.id)!;
  assert.deepEqual(kinds(s.items), ['user', 'assistant', 'tool', 'result']);
  assert.equal(s.title, '把第一天排鬆');
  assert.equal(s.providerSessionId, 'prov-1');
  assert.deepEqual(s.items[1], { ...s.items[1], text: '好，改了。', streaming: false });
  assert.equal(s.items[2]?.kind === 'tool' && s.items[2].status, 'done');
});

test('the prompt carries the viewer context and the trip is remembered on the session', async () => {
  let seen = '';
  const { store, runner, session } = setup(async (o) => {
    seen = o.prompt;
  });
  await runner.send(session.id, { text: '換掉這個', context: { tripId: 'italy-2026-11', day: 3, itemId: 'colosseo' } });
  await idle(store, session.id);
  assert.match(seen, /trips\/italy-2026-11\/trip\.ts/);
  assert.match(seen, /colosseo/);
  assert.equal(store.get(session.id)?.tripId, 'italy-2026-11');
});

test('a provider failure becomes an error item and the session still ends idle', async () => {
  const { store, runner, session } = setup(async () => {
    throw new Error('boom');
  });
  await runner.send(session.id, { text: 'x' });
  await idle(store, session.id);
  const items = store.get(session.id)!.items;
  assert.deepEqual(kinds(items), ['user', 'error', 'result']);
  assert.equal(items[1]?.kind === 'error' && items[1].text, 'boom');
});

test('a permission request waits for the panel; allow resolves it', async () => {
  let granted: boolean | null = null;
  const { store, runner, session } = setup(async (o) => {
    granted = await o.requestPermission({ tool: 'Bash', title: '執行指令', detail: 'npm run check' });
  });
  await runner.send(session.id, { text: 'check it' });
  await new Promise((r) => setTimeout(r, 20));
  const p = store.get(session.id)!.items.find((i) => i.kind === 'permission');
  assert.equal(p?.kind === 'permission' && p.status, 'pending');
  assert.equal(runner.respond(session.id, p!.id, { allow: true }), true);
  await idle(store, session.id);
  assert.equal(granted, true);
  const after = store.get(session.id)!.items.find((i) => i.kind === 'permission');
  assert.equal(after?.kind === 'permission' && after.status, 'allowed');
  assert.equal(runner.respond(session.id, p!.id, { allow: false }), false, 'nothing pending any more');
});

test('autoApprove allows without asking', async () => {
  let granted: boolean | null = null;
  const { store, runner, session } = setup(async (o) => {
    granted = await o.requestPermission({ tool: 'Bash', title: 't', detail: null });
  });
  await runner.send(session.id, { text: 'go', autoApprove: true });
  await idle(store, session.id);
  assert.equal(granted, true);
});

test('questions are answered through respond, and the answers reach the provider', async () => {
  let answers: Record<string, string> | null = null;
  const { store, runner, session } = setup(async (o) => {
    answers = await o.askUser([{ header: '天數', question: '幾天？', options: [{ label: '3' }], multiSelect: false }]);
  });
  await runner.send(session.id, { text: '規劃' });
  await new Promise((r) => setTimeout(r, 20));
  const q = store.get(session.id)!.items.find((i) => i.kind === 'question')!;
  assert.equal(runner.respond(session.id, q.id, { answers: { '幾天？': '3' } }), true);
  await idle(store, session.id);
  assert.deepEqual(answers, { '幾天？': '3' });
  const after = store.get(session.id)!.items.find((i) => i.kind === 'question');
  assert.equal(after?.kind === 'question' && after.status, 'answered');
});

test('stop aborts the turn, cancels pending prompts, and marks the result aborted', async () => {
  let aborted = false;
  const { store, runner, session } = setup(
    (o) =>
      new Promise<void>((resolve) => {
        void o.requestPermission({ tool: 'Bash', title: 't', detail: null });
        o.signal.addEventListener('abort', () => {
          aborted = true;
          resolve();
        });
      }),
  );
  await runner.send(session.id, { text: 'long' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(runner.stop(session.id), true);
  await idle(store, session.id);
  assert.equal(aborted, true);
  const items = store.get(session.id)!.items;
  const denied = items.find((i) => i.kind === 'permission');
  assert.equal(denied?.kind === 'permission' && denied.status, 'denied');
  const result = items.find((i) => i.kind === 'result');
  assert.equal(result?.kind === 'result' && result.aborted, true);
  assert.equal(runner.stop(session.id), false);
});

test('a second message while running is refused', async () => {
  const { store, runner, session } = setup(() => new Promise<void>((r) => setTimeout(r, 40)));
  await runner.send(session.id, { text: 'one' });
  await assert.rejects(runner.send(session.id, { text: 'two' }), /正在執行/);
  await idle(store, session.id);
  await assert.rejects(runner.send(session.id, { text: '   ' }), /空的/);
});

test('editing a later message rewinds the provider to its checkpoint', async () => {
  const seen: { resume: string | null; resumeAt: string | null; prompt: string }[] = [];
  const { store, runner, session } = setup(async (o) => {
    seen.push({ resume: o.resume, resumeAt: o.resumeAt, prompt: o.prompt });
    o.emit({ type: 'session-id', id: 'prov' });
    o.emit({ type: 'checkpoint', id: `cp-${seen.length}` });
  });
  await runner.send(session.id, { text: 'first' });
  await idle(store, session.id);
  await runner.send(session.id, { text: 'second' });
  await idle(store, session.id);
  const second = store.get(session.id)!.items.filter((i) => i.kind === 'user')[1]!;
  assert.equal(second.kind === 'user' && second.resumeAt, 'cp-1');
  await runner.send(session.id, { text: 'second, better', edit: second.id });
  await idle(store, session.id);
  const last = seen.at(-1)!;
  assert.equal(last.resume, 'prov');
  assert.equal(last.resumeAt, 'cp-1');
  assert.match(last.prompt, /tripcode-note/);
  const users = store.get(session.id)!.items.filter((i) => i.kind === 'user');
  assert.deepEqual(
    users.map((u) => u.kind === 'user' && u.text),
    ['first', 'second, better'],
  );
});

test('editing the first message starts the provider conversation over', async () => {
  const seen: (string | null)[] = [];
  const { store, runner, session } = setup(async (o) => {
    seen.push(o.resume);
    o.emit({ type: 'session-id', id: 'prov' });
  });
  await runner.send(session.id, { text: 'first' });
  await idle(store, session.id);
  const first = store.get(session.id)!.items[0]!;
  await runner.send(session.id, { text: 'first v2', edit: first.id });
  await idle(store, session.id);
  assert.deepEqual(seen, [null, null]);
  assert.equal(store.get(session.id)!.items.filter((i) => i.kind === 'user').length, 1);
});

test('without rewind support an edit is replayed on top of the old history', async () => {
  const prompts: string[] = [];
  const { store, runner, session } = setup(async (o) => {
    prompts.push(o.prompt);
    o.emit({ type: 'session-id', id: 'prov' });
  }, false);
  await runner.send(session.id, { text: 'a' });
  await idle(store, session.id);
  await runner.send(session.id, { text: 'b' });
  await idle(store, session.id);
  const b = store.get(session.id)!.items.filter((i) => i.kind === 'user')[1]!;
  await runner.send(session.id, { text: 'b2', edit: b.id });
  await idle(store, session.id);
  assert.match(prompts.at(-1)!, /<original-message>\nb\n<\/original-message>/);
});

test('store: closePending settles whatever was in flight', () => {
  assert.deepEqual(closePending({ kind: 'assistant', id: 'a', ts: '', text: 'x', streaming: true }), { kind: 'assistant', id: 'a', ts: '', text: 'x', streaming: false });
  assert.equal((closePending({ kind: 'tool', id: 't', ts: '', name: 'n', title: 't', detail: null, status: 'running' }) as { status: string }).status, 'error');
  assert.equal((closePending({ kind: 'question', id: 'q', ts: '', questions: [], answers: null, status: 'pending' }) as { status: string }).status, 'cancelled');
  assert.equal((closePending({ kind: 'permission', id: 'p', ts: '', tool: 'x', title: 't', detail: null, status: 'pending' }) as { status: string }).status, 'denied');
});

test('store: events mirror every change; list is newest first; removal is announced', () => {
  const store = createSessionStore();
  const seen: string[] = [];
  store.subscribe((e) => seen.push(e.type));
  const a = store.create('a');
  const b = store.create('b');
  assert.deepEqual(
    store.list().map((s) => s.id),
    [b.id, a.id],
  );
  store.appendItem(a.id, { kind: 'assistant', id: 'x', ts: '', text: '', streaming: true });
  store.appendDelta(a.id, 'x', 'hi');
  assert.equal((store.get(a.id)!.items[0] as { text: string }).text, 'hi');
  store.truncateFrom(a.id, 'x');
  assert.equal(store.get(a.id)!.items.length, 0);
  assert.equal(store.remove(b.id), true);
  assert.equal(store.remove(b.id), false);
  assert.ok(['session', 'item', 'delta', 'truncate', 'session-removed'].every((t) => seen.includes(t)));
  assert.throws(() => store.patch('nope', {}), /未知/);
});


test('pictures: the paths go to the user item and into the prompt; a picture alone is enough; an edit keeps them', async () => {
  const seen: string[] = [];
  const { store, runner, session } = setup(async (o) => {
    seen.push(o.prompt);
    o.emit({ type: 'text-start', id: `t${seen.length}` });
    o.emit({ type: 'text-end', id: `t${seen.length}`, text: 'ok' });
  });
  const ref = 'trips/rome/attachments/img-abc-0123abcd.png';
  await runner.send(session.id, { text: '', images: [ref] });
  await idle(store, session.id);
  const first = store.get(session.id)!.items[0];
  assert.equal(first?.kind === 'user' && first.text, '（請看附上的圖片）');
  assert.deepEqual(first?.kind === 'user' && first.images, [ref]);
  assert.match(seen[0] ?? '', /<tripcode-attachments>[\s\S]*img-abc-0123abcd\.png[\s\S]*<\/tripcode-attachments>/);
  assert.match(seen[0] ?? '', /Read/);

  await runner.send(session.id, { text: '這張的價格呢', images: [ref] });
  await idle(store, session.id);
  const second = store.get(session.id)!.items.find((i) => i.kind === 'user' && i.text === '這張的價格呢');
  assert.ok(second);

  // Editing the second message without new pictures keeps the ones it had.
  await runner.send(session.id, { text: '這張的價格是多少', edit: second.id });
  await idle(store, session.id);
  const edited = store.get(session.id)!.items.find((i) => i.kind === 'user' && i.text === '這張的價格是多少');
  assert.deepEqual(edited?.kind === 'user' && edited.images, [ref]);
  assert.match(seen.at(-1) ?? '', /img-abc-0123abcd\.png/);
});

test('no pictures: the prompt has no attachments block', async () => {
  let seen = '';
  const { store, runner, session } = setup(async (o) => {
    seen = o.prompt;
  });
  await runner.send(session.id, { text: '你好' });
  await idle(store, session.id);
  assert.doesNotMatch(seen, /tripcode-attachments/);
  assert.equal(store.get(session.id)!.items[0]?.kind === 'user' && 'images' in store.get(session.id)!.items[0]!, false);
});
