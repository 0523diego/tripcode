import { useEffect, useMemo, useRef, useState } from 'react';
import type { Trip } from '../../core/types.ts';
import { dayColorSlots, dayColorVar } from '../../core/day-colors.ts';
import type { TripEntry } from '../trips.ts';
import { variantName } from '../variant.ts';

interface HeaderProps {
  trips: TripEntry[];
  tripId: string;
  onTrip: (id: string) => void;
  onHome: () => void;
  entry: TripEntry;
  file: string;
  onFile: (file: string) => void;
  trip: Trip;
  compare: boolean;
  onCompare: () => void;
  /** Toggles the AI 助手 panel; omitted when there is no dev server behind the viewer. */
  agent?: { open: boolean; running: boolean; onToggle: () => void };
  /** Opens the 訂票清單 page; omitted when there is no dev server behind the viewer. */
  onOffice?: () => void;
  /** Undo / redo of the viewer's edits to this file; omitted when there is no dev server behind the viewer. */
  history?: { undo: number; redo: number; undoLabel?: string; redoLabel?: string; onUndo: () => void; onRedo: () => void };
}

/** Curved arrow for undo; `flip` mirrors it for redo. An SVG, because ↶ ↷ are missing from many fonts. */
function ArrowIcon({ flip = false }: { flip?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={flip ? { transform: 'scaleX(-1)' } : undefined}>
      <path d="M5.5 3 2.5 6l3 3" />
      <path d="M2.8 6H9.5a3.5 3.5 0 0 1 0 7H6.5" />
    </svg>
  );
}

function shortDate(date: string): string {
  const [, m, d] = date.split('-').map(Number);
  return m && d ? `${m}/${d}` : date;
}

function partyText(trip: Trip): string {
  const { adults, childrenAges } = trip.party;
  const kids = childrenAges.length > 0 ? ` · ${childrenAges.length} 位小孩` : '';
  return `${adults} 位大人${kids}`;
}

export function RailHeader({ trips, tripId, onTrip, onHome, entry, file, onFile, trip, compare, onCompare, agent, onOffice, history }: HeaderProps) {
  return (
    <header className="rail-head">
      <div className="rail-top">
        <button type="button" className="brand home-link" onClick={onHome} aria-label="回到首頁（所有旅程）">
          ‹ TripCode
        </button>
        {trips.length > 1 && (
          <label className="trip-pick">
            <span className="sr-only">選擇旅程</span>
            <select value={tripId} onChange={(e) => onTrip(e.target.value)}>
              {trips.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.files[0]?.trip.title ?? t.id}
                </option>
              ))}
            </select>
          </label>
        )}
        {(history || agent || onOffice) && (
          <div className="rail-tools">
            {history && (
              <div className="undo-redo" role="group" aria-label="復原與重做">
                <button
                  type="button"
                  disabled={history.undo === 0}
                  onClick={history.onUndo}
                  aria-label={history.undoLabel ? `復原：${history.undoLabel}` : '復原'}
                  title={history.undoLabel ? `復原：${history.undoLabel}（⌘Z）` : '沒有可以復原的動作'}
                >
                  <ArrowIcon />
                </button>
                <button
                  type="button"
                  disabled={history.redo === 0}
                  onClick={history.onRedo}
                  aria-label={history.redoLabel ? `重做：${history.redoLabel}` : '重做'}
                  title={history.redoLabel ? `重做：${history.redoLabel}（⇧⌘Z）` : '沒有可以重做的動作'}
                >
                  <ArrowIcon flip />
                </button>
              </div>
            )}
            {onOffice && (
              <button type="button" className="agent-open" onClick={onOffice}>
                訂票清單
              </button>
            )}
            {agent && (
              <button type="button" className="agent-open" aria-pressed={agent.open} onClick={agent.onToggle}>
                {agent.running && <span className="dot" aria-hidden="true" />}
                AI 助手
              </button>
            )}
          </div>
        )}
      </div>
      <h1 className="rail-title">{trip.title}</h1>
      <p className="rail-meta">
        {shortDate(trip.start)} – {shortDate(trip.end)} · {trip.days.length} 天 · {partyText(trip)}
      </p>
      {entry.files.length > 1 && (
      <div className="rail-actions">
        {!compare && (
          <div className="seg" role="group" aria-label="方案切換">
            {entry.files.map((f) => (
              <button
                key={f.file}
                type="button"
                className={f.file === file ? 'on' : ''}
                aria-pressed={f.file === file}
                onClick={() => onFile(f.file)}
              >
                {variantName(f.file)}
              </button>
            ))}
          </div>
        )}
        <button type="button" className={`btn${compare ? ' on' : ''}`} aria-pressed={compare} onClick={onCompare}>
          比較方案
        </button>
      </div>
      )}
    </header>
  );
}

interface StripProps {
  trip: Trip;
  dayIdx: number | null;
  onDay: (i: number | null) => void;
}

export function DayStrip({ trip, dayIdx, onDay }: StripProps) {
  const slots = useMemo(() => dayColorSlots(trip), [trip]);
  const nav = useRef<HTMLElement | null>(null);
  const [edge, setEdge] = useState({ left: false, right: false });

  const measure = () => {
    const el = nav.current;
    if (!el) return;
    setEdge({ left: el.scrollLeft > 4, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4 });
  };
  useEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [trip.days.length]);

  // Keep the selected day in view when it changes from the map or the keyboard.
  useEffect(() => {
    const el = nav.current;
    const on = el?.querySelector<HTMLElement>('.ds.on');
    if (!el || !on) return;
    const pad = 48;
    if (on.offsetLeft - pad < el.scrollLeft) el.scrollTo({ left: on.offsetLeft - pad, behavior: 'smooth' });
    else if (on.offsetLeft + on.offsetWidth + pad > el.scrollLeft + el.clientWidth) {
      el.scrollTo({ left: on.offsetLeft + on.offsetWidth + pad - el.clientWidth, behavior: 'smooth' });
    }
  }, [dayIdx]);

  const page = (dir: -1 | 1) => nav.current?.scrollBy({ left: dir * nav.current.clientWidth * 0.7, behavior: 'smooth' });

  return (
    <div className="day-strip-wrap">
      <button type="button" className={`ds-more prev${edge.left ? ' on' : ''}`} tabIndex={-1} aria-hidden="true" onClick={() => page(-1)}>
        ‹
      </button>
      <button type="button" className={`ds-more next${edge.right ? ' on' : ''}`} tabIndex={-1} aria-hidden="true" onClick={() => page(1)}>
        ›
      </button>
      <nav
        ref={nav}
        className="day-strip"
        aria-label="選擇日期"
        onScroll={measure}
        onKeyDown={(e) => {
          // ←/→ move to the previous/next day (Home/End: first/last), starting from the focused button.
          const step = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
          if (step === 0 && e.key !== 'Home' && e.key !== 'End') return;
          const buttons = Array.from(e.currentTarget.querySelectorAll('button'));
          const from = buttons.indexOf(document.activeElement as HTMLButtonElement);
          if (from < 0) return;
          const to = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : Math.min(buttons.length - 1, Math.max(0, from + step));
          e.preventDefault();
          if (to !== from) {
            buttons[to]!.focus();
            onDay(to === 0 ? null : to - 1);
          }
        }}
      >
        <button
          type="button"
          className={`ds all${dayIdx === null ? ' on' : ''}`}
          aria-pressed={dayIdx === null}
          onClick={() => onDay(null)}
        >
          <span className="ds-n">全部</span>
          <span className="ds-d">{trip.days.length} 天</span>
        </button>
        {trip.days.map((d, i) => (
          <button
            key={d.date}
            type="button"
            className={`ds${dayIdx === i ? ' on' : ''}`}
            aria-pressed={dayIdx === i}
            aria-label={`第 ${i + 1} 天 ${d.date}${d.title ? ` ${d.title}` : ''}`}
            title={d.title ?? ''}
            onClick={() => onDay(i)}
            style={{ ['--c' as string]: `var(${dayColorVar(slots[i]!)})` }}
          >
            <span className="ds-n">{i + 1}</span>
            <span className="ds-d">{shortDate(d.date)}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
