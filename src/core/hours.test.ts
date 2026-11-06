import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { windowsFor } from './hours.ts';

describe('windowsFor', () => {
  test('a normal day', () => {
    assert.deepEqual(windowsFor({ periods: [{ day: 2, open: '09:00', close: '18:00' }] }, 2), [{ open: 540, close: 1080 }]);
    assert.deepEqual(windowsFor({ periods: [{ day: 2, open: '09:00', close: '18:00' }] }, 3), []);
  });
  test('a period that runs past midnight spills into the next day', () => {
    const h = { periods: [{ day: 5, open: '18:00', close: '02:00' }] };
    assert.deepEqual(windowsFor(h, 5), [{ open: 1080, close: 1560 }]);
    assert.deepEqual(windowsFor(h, 6), [{ open: 0, close: 120 }]);
  });
  test('00:00 to 00:00 is open all day', () => {
    assert.deepEqual(windowsFor({ periods: [{ day: 0, open: '00:00', close: '00:00' }] }, 0), [{ open: 0, close: 1440 }]);
  });
  test('unreadable times are skipped, not guessed', () => {
    assert.deepEqual(windowsFor({ periods: [{ day: 1, open: 'late', close: '18:00' }] }, 1), []);
  });
});
