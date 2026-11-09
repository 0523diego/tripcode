import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PANEL_OPEN_KEY, readPanelOpen, writePanelOpen } from './panel-open.ts';

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

test('the panel comes back open after a rebuild of the page, and closed when it was closed or nothing was saved', () => {
  const s = memory();
  assert.equal(readPanelOpen(s), false, 'nothing saved: closed');
  writePanelOpen(true, s);
  assert.equal(readPanelOpen(s), true);
  writePanelOpen(false, s);
  assert.equal(readPanelOpen(s), false);
  s.setItem(PANEL_OPEN_KEY, 'maybe');
  assert.equal(readPanelOpen(s), false, 'anything else is closed');
});

test('blocked storage never throws: the panel is simply closed', () => {
  const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  assert.equal(readPanelOpen(blocked), false);
  assert.doesNotThrow(() => writePanelOpen(true, blocked));
});
