import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRoute } from './route.ts';

test('routes: home, trip and the purchasing office', () => {
  assert.deepEqual(parseRoute(''), { name: 'home' });
  assert.deepEqual(parseRoute('#/trip/italy-2026-11'), { name: 'trip', id: 'italy-2026-11' });
  assert.deepEqual(parseRoute('#/trip/italy-2026-11/'), { name: 'trip', id: 'italy-2026-11' });
  assert.deepEqual(parseRoute('#/trip/italy-2026-11/office'), { name: 'office', id: 'italy-2026-11' });
  assert.deepEqual(parseRoute('#/trip/a/office/'), { name: 'office', id: 'a' });
  assert.deepEqual(parseRoute('#/trip/../office'), { name: 'home' });
  assert.deepEqual(parseRoute('#/idea/idea-20261106-ab12'), { name: 'idea', id: 'idea-20261106-ab12' });
  assert.deepEqual(parseRoute('#/idea/x/'), { name: 'idea', id: 'x' });
  assert.deepEqual(parseRoute('#/idea/../x'), { name: 'home' });
  assert.deepEqual(parseRoute('#/idea/'), { name: 'home' });
});

test('routes: the print page carries its options in the query', () => {
  assert.deepEqual(parseRoute('#/trip/italy-2026-11/print'), { name: 'print', id: 'italy-2026-11', query: '' });
  assert.deepEqual(parseRoute('#/trip/a/print/'), { name: 'print', id: 'a', query: '' });
  assert.deepEqual(parseRoute('#/trip/a/print?days=2'), { name: 'print', id: 'a', query: 'days=2' });
  assert.deepEqual(parseRoute('#/trip/../print'), { name: 'home' });
  assert.deepEqual(parseRoute('#/trip/a/printer'), { name: 'home' });
});
