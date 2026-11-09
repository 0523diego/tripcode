// The drag strip on the AI panel's left edge: pull it outward to make the panel wider (inward to narrow it). Double-click
// or Home resets it, Left / Right arrows resize from the keyboard. The width is shared by every page that shows the panel.
import { useLayoutEffect, useRef, useState } from 'react';
import { applyWidth, clampWidth, DEFAULT_WIDTH, loadWidth, MIN_WIDTH, maxWidthFor, saveWidth, widthAfterKey } from './panel-width.ts';

export function PanelResizer() {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startX: number; startWidth: number; width: number } | null>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);

  const panelWidth = () => ref.current?.parentElement?.getBoundingClientRect().width ?? DEFAULT_WIDTH;
  const set = (w: number | null, persist: boolean) => {
    applyWidth(w);
    if (persist) saveWidth(w);
    // Read the real width back: on a narrow screen the panel ignores the variable (it is full screen).
    requestAnimationFrame(() => setWidth(Math.round(panelWidth())));
  };

  // The saved width is applied before the panel is first painted, so it never flashes at the default size.
  useLayoutEffect(() => {
    const saved = loadWidth();
    if (saved !== null) applyWidth(clampWidth(saved, window.innerWidth));
    setWidth(Math.round(panelWidth()));
    // A smaller window can make a saved width too wide: pull it back instead of covering the page.
    const onResize = () => {
      const now = panelWidth();
      const cap = maxWidthFor(window.innerWidth);
      if (loadWidth() !== null && now > cap) applyWidth(cap);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return (
    <div
      ref={ref}
      className="ag-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="調整 AI 助手寬度（往左拉變寬，雙擊還原）"
      aria-valuemin={MIN_WIDTH}
      aria-valuemax={maxWidthFor(typeof window === 'undefined' ? 1440 : window.innerWidth)}
      aria-valuenow={width}
      tabIndex={0}
      title="往左拉變寬，雙擊還原"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { startX: e.clientX, startWidth: panelWidth(), width: panelWidth() };
        document.body.classList.add('ag-resizing');
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        // The panel hangs on the right edge, so moving the pointer left by N pixels makes it N pixels wider.
        d.width = clampWidth(d.startWidth + (d.startX - e.clientX), window.innerWidth);
        applyWidth(d.width);
      }}
      onPointerUp={() => {
        const d = drag.current;
        drag.current = null;
        document.body.classList.remove('ag-resizing');
        if (d) set(d.width, true);
      }}
      onPointerCancel={() => {
        drag.current = null;
        document.body.classList.remove('ag-resizing');
        set(loadWidth(), false);
      }}
      onDoubleClick={() => set(null, true)}
      onKeyDown={(e) => {
        const next = widthAfterKey(panelWidth(), e.key, window.innerWidth);
        if (next === undefined) return;
        e.preventDefault();
        set(next, true);
      }}
    />
  );
}
