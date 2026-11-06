import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EditHistory } from './history.ts';

const K = '/trips/a/trip.ts';

function step(h: EditHistory, dir: 'undo' | 'redo', current: string) {
  const p = h.plan(K, dir, current);
  if (p.ok) p.commit();
  return p;
}

test('undo walks back through edits and redo walks forward again', () => {
  const h = new EditHistory();
  h.record(K, { label: '改標題', before: 'A', after: 'B', itemId: 'x' });
  h.record(K, { label: '鎖定', before: 'B', after: 'C', itemId: 'y' });
  assert.deepEqual(h.info(K), { undo: 2, redo: 0, undoLabel: '鎖定', undoItemId: 'y' });

  const u1 = step(h, 'undo', 'C');
  assert.equal(u1.ok && u1.content, 'B');
  assert.deepEqual(h.info(K), { undo: 1, redo: 1, undoLabel: '改標題', undoItemId: 'x', redoLabel: '鎖定', redoItemId: 'y' });
  const u2 = step(h, 'undo', 'B');
  assert.equal(u2.ok && u2.content, 'A');

  const r1 = step(h, 'redo', 'A');
  assert.equal(r1.ok && r1.content, 'B');
  const r2 = step(h, 'redo', 'B');
  assert.equal(r2.ok && r2.content, 'C');
  assert.deepEqual(h.info(K), { undo: 2, redo: 0, undoLabel: '鎖定', undoItemId: 'y' });
});

test('a new edit ends the redo chain', () => {
  const h = new EditHistory();
  h.record(K, { label: '1', before: 'A', after: 'B' });
  step(h, 'undo', 'B');
  assert.equal(h.info(K).redo, 1);
  h.record(K, { label: '2', before: 'A', after: 'D' });
  assert.equal(h.info(K).redo, 0);
  assert.equal(h.plan(K, 'redo', 'D').ok, false);
});

test('nothing to undo or redo is reported, not thrown', () => {
  const h = new EditHistory();
  const u = h.plan(K, 'undo', 'A');
  assert.equal(!u.ok && u.reason, 'empty');
  const r = h.plan(K, 'redo', 'A');
  assert.equal(!r.ok && r.reason, 'empty');
  assert.deepEqual(h.info('/other'), { undo: 0, redo: 0 });
});

test('if the file changed since the edit, undo refuses and drops the stale history', () => {
  const h = new EditHistory();
  h.record(K, { label: '1', before: 'A', after: 'B' });
  h.record(K, { label: '2', before: 'B', after: 'C' });
  const p = h.plan(K, 'undo', 'C + something Claude wrote');
  assert.equal(!p.ok && p.reason, 'conflict');
  assert.match(!p.ok ? p.error : '', /被改過/);
  assert.deepEqual(h.info(K), { undo: 0, redo: 0 });
});

test('redo also refuses when the file moved on after the undo', () => {
  const h = new EditHistory();
  h.record(K, { label: '1', before: 'A', after: 'B' });
  step(h, 'undo', 'B');
  const p = h.plan(K, 'redo', 'A edited elsewhere');
  assert.equal(!p.ok && p.reason, 'conflict');
});

test('plan changes nothing until commit (a failed write leaves the history intact)', () => {
  const h = new EditHistory();
  h.record(K, { label: '1', before: 'A', after: 'B' });
  const p = h.plan(K, 'undo', 'B');
  assert.equal(p.ok, true);
  assert.deepEqual(h.info(K), { undo: 1, redo: 0, undoLabel: '1' });
  assert.equal(h.plan(K, 'undo', 'B').ok, true, 'still available');
});

test('no-op edits are not recorded; each file has its own history; the stack is capped', () => {
  const h = new EditHistory();
  h.record(K, { label: 'same', before: 'A', after: 'A' });
  assert.equal(h.info(K).undo, 0);
  h.record(K, { label: 'a', before: 'A', after: 'B' });
  assert.equal(h.info('/trips/a/variant-b.ts').undo, 0);
  for (let i = 0; i < 80; i++) h.record(K, { label: `n${i}`, before: `s${i}`, after: `s${i + 1}` });
  assert.equal(h.info(K).undo, 50);
  assert.equal(h.info(K).undoLabel, 'n79');
});
