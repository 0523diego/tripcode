import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Trip } from '../../core/types.ts';
import { agentContext } from './context.ts';

const trip = {
  title: '義大利',
  days: [
    { date: '2026-11-01', items: [{ id: 'a', title: '鬥獸場' }] },
    { date: '2026-11-02', items: [{ id: 'b', title: '梵蒂岡' }] },
  ],
  candidates: [{ id: 'c1', title: '特雷維噴泉' }],
} as unknown as Trip;

test('nothing selected, all days: only the trip', () => {
  const { context, label } = agentContext(trip, { tripId: 'italy', file: 'trip.ts', dayIdx: null, selection: null });
  assert.deepEqual(context, { tripId: 'italy', tripTitle: '義大利' });
  assert.equal(label, '義大利 · 全部天數');
});

test('a day and an item: 1-based day, item id and title', () => {
  const { context, label } = agentContext(trip, { tripId: 'italy', file: 'trip.ts', dayIdx: 1, selection: { type: 'item', id: 'b' } });
  assert.deepEqual(context, { tripId: 'italy', tripTitle: '義大利', day: 2, itemId: 'b' });
  assert.equal(label, '義大利 · 第 2 天 · 梵蒂岡');
});

test('an item selected while all days are shown still resolves its day', () => {
  const { context } = agentContext(trip, { tripId: 'italy', file: 'trip.ts', dayIdx: null, selection: { type: 'item', id: 'a' } });
  assert.equal(context.day, 1);
});

test('a variant file is named; a candidate is selectable; a day selection adds no item', () => {
  assert.equal(agentContext(trip, { tripId: 'italy', file: 'variant-b.ts', dayIdx: null, selection: null }).context.file, 'variant-b.ts');
  const cand = agentContext(trip, { tripId: 'italy', file: 'trip.ts', dayIdx: 0, selection: { type: 'candidate', id: 'c1' } });
  assert.equal(cand.context.itemId, 'c1');
  assert.match(cand.label, /特雷維噴泉$/);
  const day = agentContext(trip, { tripId: 'italy', file: 'trip.ts', dayIdx: 0, selection: { type: 'day', date: '2026-11-01' } });
  assert.equal(day.context.itemId, undefined);
});
