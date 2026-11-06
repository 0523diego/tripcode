// Mobile bottom sheet plumbing: three snap heights and a draggable grip. The rail is the only sheet;
// the map stays above it. Desktop never renders any of this.
import { useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';

export type Snap = 'peek' | 'half' | 'full';
export const SNAPS: Snap[] = ['peek', 'half', 'full'];

/** Sheet heights in px for a viewport height. Full leaves a strip of map visible above the sheet. */
export function sheetHeights(vh: number): Record<Snap, number> {
  const full = Math.max(320, vh - 56);
  return { peek: 172, half: Math.min(full - 80, Math.round(vh * 0.56)), full };
}

/** The snap whose height is closest to `h`. A flick (|dy| > 24, up positive) that lands back on `from` moves one step. */
export function nearestSnap(h: number, heights: Record<Snap, number>, from: Snap, dy: number): Snap {
  let best: Snap = 'peek';
  for (const s of SNAPS) if (Math.abs(heights[s] - h) < Math.abs(heights[best] - h)) best = s;
  if (best === from && Math.abs(dy) > 24) {
    const i = SNAPS.indexOf(from) + (dy > 0 ? 1 : -1);
    return SNAPS[Math.min(SNAPS.length - 1, Math.max(0, i))] ?? best;
  }
  return best;
}

interface GripProps {
  snap: Snap;
  heights: Record<Snap, number>;
  onSnap: (s: Snap) => void;
  /** Live height while dragging (null when released). */
  onLive: (h: number | null) => void;
  children?: ReactNode;
}

/** Handle bar + peek summary. Dragging it resizes the sheet; a tap steps peek → half → full → peek. */
export function SheetGrip({ snap, heights, onSnap, onLive, children }: GripProps) {
  const drag = useRef<{ y: number; h: number; moved: boolean; pid: number } | null>(null);
  const clamp = (h: number) => Math.min(heights.full, Math.max(heights.peek, h));
  const step = (dir: 1 | -1) => {
    const i = SNAPS.indexOf(snap) + dir;
    onSnap(SNAPS[Math.min(SNAPS.length - 1, Math.max(0, i))] ?? snap);
  };

  const down = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { y: e.clientY, h: heights[snap], moved: false, pid: e.pointerId };
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pid !== e.pointerId) return;
    const dy = d.y - e.clientY;
    if (Math.abs(dy) > 4) d.moved = true;
    if (d.moved) onLive(clamp(d.h + dy));
  };
  const up = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pid !== e.pointerId) return;
    drag.current = null;
    onLive(null);
    if (!d.moved) {
      onSnap(snap === 'full' ? 'peek' : SNAPS[SNAPS.indexOf(snap) + 1]!);
      return;
    }
    const dy = d.y - e.clientY; // positive = dragged up
    onSnap(nearestSnap(clamp(d.h + dy), heights, snap, dy));
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowUp') step(1);
    else if (e.key === 'ArrowDown') step(-1);
    else if (e.key === 'Enter' || e.key === ' ') onSnap(snap === 'full' ? 'peek' : SNAPS[SNAPS.indexOf(snap) + 1]!);
    else return;
    e.preventDefault();
  };

  return (
    <div
      className="sheet-grip"
      role="button"
      tabIndex={0}
      aria-label="調整面板高度（拖曳或點一下）"
      aria-expanded={snap !== 'peek'}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onKeyDown={key}
    >
      <span className="sheet-bar" aria-hidden="true" />
      {children}
    </div>
  );
}
