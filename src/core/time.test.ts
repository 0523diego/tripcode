import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, fromMinutes, isIsoDate, toMinutes, tryToMinutes, weekday } from './time.ts';

test('toMinutes parses HH:MM', () => {
  assert.equal(toMinutes('00:00'), 0);
  assert.equal(toMinutes('09:30'), 570);
  assert.equal(toMinutes('23:59'), 1439);
  assert.equal(toMinutes('24:00'), 1440);
});

test('toMinutes throws on malformed input, tryToMinutes returns undefined', () => {
  for (const bad of ['9:30', '25:00', '12:60', '', 'abc', '24:01', '12:5']) {
    assert.throws(() => toMinutes(bad), RangeError, bad);
    assert.equal(tryToMinutes(bad), undefined, bad);
  }
});

test('fromMinutes pads and wraps', () => {
  assert.equal(fromMinutes(0), '00:00');
  assert.equal(fromMinutes(570), '09:30');
  assert.equal(fromMinutes(1439), '23:59');
  assert.equal(fromMinutes(1440), '00:00');
  assert.equal(fromMinutes(-60), '23:00');
  assert.throws(() => fromMinutes(Number.NaN));
});

test('toMinutes/fromMinutes round trip', () => {
  for (let m = 0; m < 1440; m += 7) assert.equal(toMinutes(fromMinutes(m)), m);
});

test('weekday: 0 = Sunday, known dates', () => {
  assert.equal(weekday('2026-06-14'), 0); // Sunday
  assert.equal(weekday('2026-06-15'), 1);
  assert.equal(weekday('2000-01-01'), 6); // Saturday
  assert.equal(weekday('2024-02-29'), 4); // leap day, Thursday
});

test('weekday rejects invalid dates', () => {
  assert.throws(() => weekday('2026-02-30'), RangeError);
  assert.throws(() => weekday('2026-6-1'), RangeError);
  assert.equal(isIsoDate('2026-02-28'), true);
  assert.equal(isIsoDate('2026-13-01'), false);
});

test('weekday is independent of the host TZ', () => {
  const saved = process.env.TZ;
  try {
    for (const tz of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'UTC']) {
      process.env.TZ = tz;
      assert.equal(weekday('2026-06-14'), 0, tz);
    }
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
});

test('addDays crosses month, year and leap boundaries', () => {
  assert.equal(addDays('2026-06-30', 1), '2026-07-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays('2026-06-10', 0), '2026-06-10');
  assert.equal(addDays('2026-06-10', 365), '2027-06-10');
  assert.throws(() => addDays('nope', 1), RangeError);
});
