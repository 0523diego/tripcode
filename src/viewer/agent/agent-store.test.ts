import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentItem, AgentSession, AgentSessionSummary } from '../../agent/types.ts';
import { applyEvent, pickSessionFor, readSettings } from './agent-store.ts';
import { classifyImage, parseBlocks, parseInline } from './markdown.ts';

const summary = (id: string, updatedAt: string, extra: Partial<AgentSessionSummary> = {}): AgentSessionSummary => ({
  id,
  title: id,
  createdAt: '2026-10-31T00:00:00Z',
  updatedAt,
  status: 'idle',
  tripId: null,
  ...extra,
});
const session = (id: string, items: AgentItem[] = []): AgentSession => ({ ...summary(id, '2026-10-31T00:00:00Z'), providerSessionId: null, providerCheckpoint: null, trimmed: false, items });
const text = (id: string, t: string): AgentItem => ({ kind: 'assistant', id, ts: '', text: t, streaming: true });

test('applyEvent: session events keep the list newest-first and refresh the open session', () => {
  let s = { sessions: [] as AgentSessionSummary[], active: session('a') as AgentSession | null };
  s = applyEvent(s, { type: 'session', session: summary('a', '2026-10-31T01:00:00Z') });
  s = applyEvent(s, { type: 'session', session: summary('b', '2026-10-31T02:00:00Z') });
  assert.deepEqual(
    s.sessions.map((x) => x.id),
    ['b', 'a'],
  );
  s = applyEvent(s, { type: 'session', session: summary('a', '2026-10-31T03:00:00Z', { status: 'running', title: '改了' }) });
  assert.deepEqual(
    s.sessions.map((x) => x.id),
    ['a', 'b'],
  );
  assert.equal(s.active?.status, 'running');
  assert.equal(s.active?.title, '改了');
  s = applyEvent(s, { type: 'session-removed', sessionId: 'a' });
  assert.equal(s.active, null);
  assert.deepEqual(
    s.sessions.map((x) => x.id),
    ['b'],
  );
});

test('applyEvent: items are appended or replaced by id, deltas extend text, truncate cuts', () => {
  let s = { sessions: [] as AgentSessionSummary[], active: session('a') as AgentSession | null };
  s = applyEvent(s, { type: 'item', sessionId: 'a', item: text('t1', '') });
  s = applyEvent(s, { type: 'delta', sessionId: 'a', itemId: 't1', text: '你' });
  s = applyEvent(s, { type: 'delta', sessionId: 'a', itemId: 't1', text: '好' });
  s = applyEvent(s, { type: 'item', sessionId: 'a', item: { kind: 'assistant', id: 't1', ts: '', text: '你好！', streaming: false } });
  s = applyEvent(s, { type: 'item', sessionId: 'a', item: { kind: 'error', id: 'e1', ts: '', text: 'x' } });
  assert.deepEqual(
    s.active?.items.map((i) => i.id),
    ['t1', 'e1'],
  );
  assert.equal(s.active?.items[0]?.kind === 'assistant' && s.active.items[0].text, '你好！');
  s = applyEvent(s, { type: 'truncate', sessionId: 'a', itemId: 'e1' });
  assert.equal(s.active?.items.length, 1);
  assert.equal(applyEvent(s, { type: 'truncate', sessionId: 'a', itemId: 'nope' }), s);
});

test('applyEvent: events for a session that is not open change nothing', () => {
  const s = { sessions: [] as AgentSessionSummary[], active: session('a') as AgentSession | null };
  assert.equal(applyEvent(s, { type: 'item', sessionId: 'z', item: text('t', '') }), s);
  assert.equal(applyEvent(s, { type: 'delta', sessionId: 'z', itemId: 't', text: 'x' }), s);
  assert.equal(applyEvent(s, { type: 'truncate', sessionId: 'z', itemId: 't' }), s);
});

test('readSettings falls back on anything unexpected', () => {
  assert.deepEqual(readSettings(null), { model: '', effort: '', autoApprove: false });
  assert.deepEqual(readSettings('not json'), { model: '', effort: '', autoApprove: false });
  assert.deepEqual(readSettings('{"model":"opus","effort":"high","autoApprove":true}'), { model: 'opus', effort: 'high', autoApprove: true });
  assert.deepEqual(readSettings('{"model":"bad model!","effort":"turbo","autoApprove":"yes"}'), { model: '', effort: '', autoApprove: false });
});

test('markdown: inline code, bold and http(s) links; other schemes stay text', () => {
  assert.deepEqual(parseInline('改了 **第 2 天** 的 `trip.ts`，見 [地圖](https://example.com/a?b=1) 與 [x](javascript:alert(1))'), [
    { kind: 'text', text: '改了 ' },
    { kind: 'bold', text: '第 2 天' },
    { kind: 'text', text: ' 的 ' },
    { kind: 'code', text: 'trip.ts' },
    { kind: 'text', text: '，見 ' },
    { kind: 'link', text: '地圖', href: 'https://example.com/a?b=1' },
    { kind: 'text', text: ' 與 [x](javascript:alert(1))' },
  ]);
});

test('markdown: blocks', () => {
  assert.deepEqual(parseBlocks('# 標題\n第一行\n第二行\n\n- a\n- b\n1. x\n2) y\n\n```ts\nconst a = 1;\n\nb\n```\n結尾'), [
    { kind: 'h', text: '標題' },
    { kind: 'p', text: '第一行 第二行' },
    { kind: 'ul', items: ['a', 'b'] },
    { kind: 'ol', items: ['x', 'y'] },
    { kind: 'code', text: 'const a = 1;\n\nb' },
    { kind: 'p', text: '結尾' },
  ]);
  assert.deepEqual(parseBlocks('```\nstill streaming'), [{ kind: 'code', text: 'still streaming' }]);
  assert.deepEqual(parseBlocks(''), []);
});

test('pickSessionFor: every trip gets its own conversation, never another trip\'s', () => {
  // Newest first, as the store keeps them.
  const list = [
    summary('rome-2', '2026-11-05T00:00:00Z', { tripId: 'rome' }),
    summary('paris-1', '2026-11-04T00:00:00Z', { tripId: 'paris' }),
    summary('rome-1', '2026-11-03T00:00:00Z', { tripId: 'rome' }),
    summary('loose', '2026-11-02T00:00:00Z'),
  ];
  assert.equal(pickSessionFor(list, 'paris', null), 'paris-1');
  assert.equal(pickSessionFor(list, 'rome', null), 'rome-2', 'no memory: the most recent one of that trip');
  assert.equal(pickSessionFor(list, 'rome', 'rome-1'), 'rome-1', 'the one it had open last wins');
  assert.equal(pickSessionFor(list, 'rome', 'paris-1'), 'rome-2', 'a remembered id that belongs to another trip is ignored');
  assert.equal(pickSessionFor(list, 'rome', 'gone'), 'rome-2', 'a deleted conversation falls back');
  assert.equal(pickSessionFor(list, 'idea-new', null), null, 'a trip with no conversation starts blank');
  assert.equal(pickSessionFor(list, null, null), 'loose');
});


test('markdown: tables need a separator row, keep alignment, escape pipes, and pad short rows', () => {
  assert.deepEqual(parseBlocks('比較如下：\n\n| 航空 | 價格 | 轉機 |\n|:--|--:|:-:|\n| 阿提哈德 | NT$29,387 | 1 |\n| 土耳其 | NT$32,111 \\| 含稅 |\n\n結論'), [
    { kind: 'p', text: '比較如下：' },
    {
      kind: 'table',
      head: ['航空', '價格', '轉機'],
      align: ['left', 'right', 'center'],
      rows: [
        ['阿提哈德', 'NT$29,387', '1'],
        ['土耳其', 'NT$32,111 | 含稅', ''],
      ],
    },
    { kind: 'p', text: '結論' },
  ]);
  // A line with a pipe but no separator row is just text; a bare --- is not a table.
  assert.deepEqual(parseBlocks('a | b\nc | d'), [{ kind: 'p', text: 'a | b c | d' }]);
  assert.deepEqual(parseBlocks('a | b\n---'), [{ kind: 'p', text: 'a | b ---' }]);
  // Streaming: a header and separator with no body yet is already a table.
  assert.deepEqual(parseBlocks('| x | y |\n|---|---|'), [{ kind: 'table', head: ['x', 'y'], align: [null, null], rows: [] }]);
});

test('markdown: images show only from trips/ or as a click-through https link; anything else stays text', () => {
  assert.equal(classifyImage('trips/rome/attachments/chart.svg'), 'local');
  assert.equal(classifyImage('node_modules/.tripcode/attachments/img-a-12345678.png'), 'local');
  assert.equal(classifyImage('https://example.com/a.png'), 'remote');
  for (const bad of ['http://example.com/a.png', 'javascript:alert(1)', 'data:image/png;base64,AAAA', '/etc/passwd', 'trips/../secret.png', 'trips/a/.git/x.png', 'trips/a/x.png?q=1', 'trips//x.png', 'src/viewer/a.png', 'file:///a.png']) {
    assert.equal(classifyImage(bad), null, bad);
  }
  assert.deepEqual(parseInline('看圖 ![行程圖](trips/rome/attachments/map.svg) 與 ![外面](https://example.com/p.png) 與 ![壞](javascript:x)'), [
    { kind: 'text', text: '看圖 ' },
    { kind: 'image', alt: '行程圖', src: 'trips/rome/attachments/map.svg', local: true },
    { kind: 'text', text: ' 與 ' },
    { kind: 'image', alt: '外面', src: 'https://example.com/p.png', local: false },
    { kind: 'text', text: ' 與 ' },
    { kind: 'text', text: '![壞](javascript:x)' },
  ]);
});
