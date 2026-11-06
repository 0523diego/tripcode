import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClaudeMapper } from './claude.ts';
import type { ProviderEvent } from './provider.ts';

function run(messages: Record<string, unknown>[]) {
  const events: ProviderEvent[] = [];
  const mapper = createClaudeMapper((e) => events.push(e), '/work');
  for (const m of messages) mapper.handle(m);
  return { events, mapper };
}

const stream = (event: Record<string, unknown>, parent: string | null = null) => ({ type: 'stream_event', parent_tool_use_id: parent, event });

test('streamed text: start, deltas, then the final text closes the same item', () => {
  const { events } = run([
    { type: 'system', subtype: 'init', session_id: 's-1' },
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
    stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你' } }),
    stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好' } }),
    { type: 'assistant', uuid: 'u-1', message: { content: [{ type: 'text', text: '你好' }] } },
  ]);
  assert.equal(events[0]?.type, 'session-id');
  const start = events[1] as Extract<ProviderEvent, { type: 'text-start' }>;
  assert.equal(start.type, 'text-start');
  assert.deepEqual(events.slice(2, 4), [
    { type: 'text-delta', id: start.id, text: '你' },
    { type: 'text-delta', id: start.id, text: '好' },
  ]);
  assert.deepEqual(events[4], { type: 'text-end', id: start.id, text: '你好' });
  assert.deepEqual(events[5], { type: 'checkpoint', id: 'u-1' });
});

test('text that never streamed is shown whole; blank text is dropped', () => {
  const { events } = run([{ type: 'assistant', message: { content: [{ type: 'text', text: '  ' }, { type: 'text', text: 'hi' }] } }]);
  assert.deepEqual(
    events.map((e) => e.type),
    ['text-start', 'text-end'],
  );
});

test('tool_use starts a tool item and its tool_result ends it', () => {
  const { events } = run([
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu-1', name: 'Edit', input: { file_path: '/work/trips/a/trip.ts' } }] } },
    { type: 'user', uuid: 'u-2', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1', is_error: false }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-2', is_error: true }] } },
  ]);
  assert.deepEqual(events[0], { type: 'tool-start', id: 'tu-1', name: 'Edit', title: '編輯', detail: 'trips/a/trip.ts' });
  assert.deepEqual(events[1], { type: 'checkpoint', id: 'u-2' });
  assert.deepEqual(events[2], { type: 'tool-end', id: 'tu-1', ok: true });
  assert.deepEqual(events[3], { type: 'tool-end', id: 'tu-2', ok: false });
});

test("a subagent's messages are not shown as the main conversation", () => {
  const { events } = run([
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }, 'tu-9'),
    { type: 'assistant', parent_tool_use_id: 'tu-9', message: { content: [{ type: 'text', text: 'inner' }] } },
    { type: 'user', parent_tool_use_id: 'tu-9', uuid: 'u', message: { content: [] } },
  ]);
  assert.deepEqual(events, []);
});

test('a successful result emits only the result; a failed one emits the error first', () => {
  const ok = run([{ type: 'result', subtype: 'success', duration_ms: 1200, total_cost_usd: 0.05, session_id: 's' }]);
  assert.deepEqual(ok.events, [
    { type: 'session-id', id: 's' },
    { type: 'result', durationMs: 1200, costUsd: 0.05 },
  ]);
  assert.equal(ok.mapper.resultSeen, true);

  const failed = run([{ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['too many turns'] }]);
  assert.deepEqual(failed.events[0], { type: 'error', text: 'too many turns' });
  assert.deepEqual(failed.events[1], { type: 'result', durationMs: null, costUsd: null });

  const bare = run([{ type: 'result', subtype: 'error_during_execution' }]);
  assert.match((bare.events[0] as { text: string }).text, /error_during_execution/);
});

test('garbage input is ignored', () => {
  const { events } = run([null as never, 'x' as never, { type: 'weird' }, { type: 'system', subtype: 'other' }]);
  assert.deepEqual(events, []);
});
