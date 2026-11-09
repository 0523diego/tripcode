// How wide the AI panel is. One width for every page that shows it (map, 訂票清單, 找方向), kept in the CSS variable
// --agent-w on <html> and remembered in localStorage; the layouts read it with their old width as the fallback, so
// "no saved width" looks exactly as before. Pure helpers here, the DOM bits at the bottom.
export const DEFAULT_WIDTH = 340;
export const MIN_WIDTH = 300;
export const MAX_WIDTH = 960;
/** Room kept on the left for the rail, the question card or the page content. */
const LEAVE_FREE = 440;
export const KEY_STEP = 24;
const STORAGE_KEY = 'tripcode.agent.width';

/** The widest the panel may get on a screen this wide: never more than 70% of it, and the left side stays usable. */
export function maxWidthFor(viewport: number): number {
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.floor(viewport * 0.7), viewport - LEAVE_FREE));
}

export function clampWidth(width: number, viewport: number): number {
  return Math.round(Math.min(maxWidthFor(viewport), Math.max(MIN_WIDTH, width)));
}

/** A saved value, or null when there is none or it is not a sane number. */
export function parseWidth(raw: string | null): number | null {
  if (!raw || !/^\d{2,4}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= MIN_WIDTH && n <= MAX_WIDTH ? n : null;
}

/** Arrow keys move the left edge: Left widens, Right narrows, Home goes back to the default (null). */
export function widthAfterKey(current: number, key: string, viewport: number): number | null | undefined {
  if (key === 'ArrowLeft') return clampWidth(current + KEY_STEP, viewport);
  if (key === 'ArrowRight') return clampWidth(current - KEY_STEP, viewport);
  if (key === 'Home') return null;
  return undefined; // not a resize key
}

export function applyWidth(width: number | null): void {
  if (width === null) document.documentElement.style.removeProperty('--agent-w');
  else document.documentElement.style.setProperty('--agent-w', `${width}px`);
}

export function saveWidth(width: number | null): void {
  try {
    if (width === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, String(width));
  } catch {
    /* private mode: the width is simply forgotten on reload */
  }
}

export function loadWidth(): number | null {
  try {
    return parseWidth(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}
