import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Trip } from '../core/types.ts';
import { buildMapData, dayVar, onVar } from './model.ts';

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

/** Hex custom properties declared in the theme's `:root` block (the viewer has a single all-black theme). */
function vars(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of block.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) out.set(m[1]!, m[2]!);
  return out;
}
const theme = vars(/:root\s*\{([\s\S]*?)\n\}/.exec(css)![1]!);

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

test('onVar maps fills to their ink variable', () => {
  assert.equal(onVar('--day-3'), '--on-day-3');
  assert.equal(onVar('--discuss'), '--on-discuss');
  assert.equal(onVar('--accept'), '--on-accept');
  assert.equal(onVar(dayVar(9)), '--on-day-2'); // wraps like dayVar
});

const FILLS = ['--day-1', '--day-2', '--day-3', '--day-4', '--day-5', '--day-6', '--day-7', '--day-8', '--discuss', '--accept'];

test('pin text on every day / status fill is >= 4.5:1', () => {
  for (const fill of FILLS) {
    const bg = theme.get(fill);
    const ink = theme.get(onVar(fill));
    assert.ok(bg && ink, `${fill} / ${onVar(fill)} defined`);
    assert.ok(contrast(bg, ink) >= 4.5, `${fill} on ${onVar(fill)} = ${contrast(bg, ink).toFixed(2)}`);
  }
});

test('day / status colors stand out from the black map (>= 3:1, non-text UI)', () => {
  const map = theme.get('--map-bg');
  assert.ok(map, '--map-bg defined');
  for (const fill of FILLS) {
    const c = theme.get(fill)!;
    assert.ok(contrast(c, map) >= 3, `${fill} on --map-bg = ${contrast(c, map).toFixed(2)}`);
  }
});

test('body text colors are readable on the surfaces they sit on', () => {
  for (const ink of ['--text', '--muted', '--faint']) {
    for (const bg of ['--bg', '--surface', '--surface-2']) {
      const r = contrast(theme.get(ink)!, theme.get(bg)!);
      assert.ok(r >= 4.5, `${ink} on ${bg} = ${r.toFixed(2)}`);
    }
  }
});

test('every day\'s route starts and ends at the hotel, even on days with no hotel item', () => {
  const trip: Trip = {
    title: 't',
    start: '2026-11-22',
    end: '2026-11-24',
    tz: 'Europe/Rome',
    party: { adults: 1, childrenAges: [] },
    candidates: [],
    days: [
      { date: '2026-11-22', items: [{ id: 'h', kind: 'hotel', title: 'Hotel', nights: 2, loc: { lat: 41.9, lng: 12.48 } }] },
      { date: '2026-11-23', items: [{ id: 'museum', kind: 'poi', title: 'Museum', loc: { lat: 41.905, lng: 12.454 } }] },
      { date: '2026-11-24', items: [] },
    ],
  };
  const day2 = buildMapData(trip, 1);
  assert.deepEqual(day2.routes[0]?.points.map((p) => p.lat), [41.9, 41.905, 41.9]);
  const stay = day2.pins.find((p) => p.key === 'item:h');
  assert.equal(stay?.label, '宿');
  assert.equal(day2.pins.length, 2);
  // In the whole-trip view the hotel's own numbered pin is reused rather than duplicated.
  const all = buildMapData(trip, null);
  assert.equal(all.pins.filter((p) => p.key === 'item:h').length, 1);
  assert.equal(all.pins.find((p) => p.key === 'item:h')?.label, '1');
});
