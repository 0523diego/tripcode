import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pickVersion } from './install.ts';

const now = new Date('2026-10-31T12:00:00Z');

test('pickVersion: newest stable version that is at least 7 days old', () => {
  const times = {
    created: '2025-01-01T00:00:00Z',
    modified: '2026-10-31T00:00:00Z',
    '0.3.309': '2026-10-22T20:35:53Z',
    '0.3.310': '2026-10-23T21:21:54Z', // 7 d 14 h old → allowed
    '0.3.311': '2026-10-26T19:49:59Z', // 5 days → too new
    '0.3.316': '2026-10-31T00:39:30Z', // published today
  };
  assert.equal(pickVersion(times, now), '0.3.310');
});

test('pickVersion: orders numerically, not lexically', () => {
  const times = { '0.3.9': '2026-01-01T00:00:00Z', '0.3.10': '2026-01-02T00:00:00Z', '0.10.0': '2026-01-03T00:00:00Z', '0.2.99': '2026-01-04T00:00:00Z' };
  assert.equal(pickVersion(times, now), '0.10.0');
});

test('pickVersion: skips prereleases, bad dates, and returns null when nothing is old enough', () => {
  assert.equal(pickVersion({ '1.0.0-beta.1': '2026-01-01T00:00:00Z', '1.0.0': 'not a date' }, now), null);
  assert.equal(pickVersion({ '1.0.0': '2026-10-30T00:00:00Z' }, now), null);
  assert.equal(pickVersion({}, now), null);
});

test('pickVersion: the cutoff is exact to the millisecond', () => {
  const edge = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(pickVersion({ '1.0.0': edge }, now), '1.0.0');
  assert.equal(pickVersion({ '1.0.0': new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000 + 1).toISOString() }, now), null);
});
