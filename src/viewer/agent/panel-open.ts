// Whether the AI panel is open, remembered for the browser tab (sessionStorage). The panel's own state lives in a component, so
// anything that rebuilds the page (a new trip folder, the dev server restarting, moving between the trip and its booking list)
// used to close it in the middle of a conversation. Reopening it is now the default after such a rebuild.
import { useCallback, useState } from 'react';

export const PANEL_OPEN_KEY = 'tripcode.agentOpen';
type KeyValueStore = Pick<Storage, 'getItem' | 'setItem'>;

export function readPanelOpen(storage?: KeyValueStore): boolean {
  try {
    return (storage ?? sessionStorage).getItem(PANEL_OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

export function writePanelOpen(open: boolean, storage?: KeyValueStore): void {
  try {
    (storage ?? sessionStorage).setItem(PANEL_OPEN_KEY, open ? '1' : '0');
  } catch {
    /* blocked storage: the panel just does not come back after a reload */
  }
}

/** `useState(false)` for the panel that survives a rebuild of the page. */
export function usePanelOpen(): [boolean, (open: boolean | ((was: boolean) => boolean)) => void] {
  const [open, set] = useState<boolean>(() => readPanelOpen());
  const setOpen = useCallback((next: boolean | ((was: boolean) => boolean)) => {
    set((was) => {
      const value = typeof next === 'function' ? next(was) : next;
      writePanelOpen(value);
      return value;
    });
  }, []);
  return [open, setOpen];
}
