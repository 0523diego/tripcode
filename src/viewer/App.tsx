import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { post, type Send } from './api.ts';
import type { HistoryInfo } from '../core/history.ts';
import { CompareView } from './components/CompareView.tsx';
import { DetailPanel } from './components/DetailPanel.tsx';
import { FactsPanel, useHealth } from './components/FactsPanel.tsx';
import { InboxPanel } from './components/InboxPanel.tsx';
import { AgentPanel } from './agent/AgentPanel.tsx';
import { usePanelOpen } from './agent/panel-open.ts';
import { Office } from './office/Office.tsx';
import { agentContext } from './agent/context.ts';
import { useAgent } from './agent/agent-store.ts';
import { Itinerary } from './components/Itinerary.tsx';
import { COLOR_NAMES } from './components/DayColorPicker.tsx';
import { AddPlace } from './components/AddPlace.tsx';
import { MapPanel, type MapInset } from './components/MapPanel.tsx';
import { PrintLayer } from './print/PrintLayer.tsx';
import { PrintPage } from './print/PrintPage.tsx';
import { DayStrip, RailHeader } from './components/RailHeader.tsx';
import { Home } from './components/Home.tsx';
import { targetTitle } from './components/CommentLog.tsx';
import { OptimizeHint } from './components/OptimizeHint.tsx';
import { RailFoot } from './components/RailFoot.tsx';
import { SheetGrip, sheetHeights, type Snap } from './components/Sheet.tsx';
import { appendComment, loadComments, normalizeText, type SentComment } from './comment-log.ts';
import { go, useRoute } from './route.ts';
import { IdeaPage } from './idea/IdeaPage.tsx';
import { OpeningTrip } from './idea/OpeningTrip.tsx';
import { clearLanding, readLanding } from './idea/landing.ts';
import { buildMapData, dateLabel, findItem, lockedItems, parseInbox, selKey, type MapPin, type Selection } from './model.ts';
import { nextItem, todayDayIdx, viewerNow } from './today.ts';
import { useTrips, type TripEntry } from './trips.ts';
import { variantName } from './variant.ts';
import type { Trip } from '../core/types.ts';

const STORE = 'tripcode.viewer';

interface Saved {
  file?: string;
  dayIdx?: number | null;
  selection?: Selection | null;
  tab?: Tab;
  compare?: boolean;
  cmpLeft?: string;
  cmpRight?: string;
}

function readSaved(tripId: string): Saved {
  try {
    return JSON.parse(sessionStorage.getItem(`${STORE}.${tripId}`) ?? '{}') as Saved;
  } catch {
    return {};
  }
}

type Tab = 'plan' | 'facts' | 'inbox';

const TABS: [Tab, string][] = [
  ['plan', '行程'],
  ['facts', '已確定'],
  ['inbox', '匯入'],
];

/** Rail width + gaps, and the detail card width (keep in sync with styles.css). */
const RAIL_SPACE = 384 + 24;
const DETAIL_SPACE = 340 + 24;

/** Narrow-screen layout: map on top, the rail becomes a bottom sheet (keep in sync with styles/mobile.css). */
const MOBILE_MAX = 900;

/** Viewport size, updated on resize. */
function useViewport(): { width: number; height: number } {
  const [size, setSize] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  useEffect(() => {
    const on = () => setSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return size;
}

/** One line for the collapsed sheet: which day, and what comes next. */
function PeekSummary({ trip, dayIdx, todayIdx, time }: { trip: Trip; dayIdx: number | null; todayIdx: number | null; time: string }) {
  const idx = dayIdx ?? todayIdx;
  const day = idx !== null ? trip.days[idx] : undefined;
  if (idx === null || !day) {
    return (
      <div className="peek">
        <div className="peek-kicker">{trip.days.length} 天</div>
        <div className="peek-title">{trip.title}</div>
        <div className="peek-next muted">拉起面板看行程，或點下方日期</div>
      </div>
    );
  }
  const isToday = idx === todayIdx;
  const next = nextItem(day, isToday ? time : null);
  let line = '這天還沒有安排';
  if (day.items.length > 0) {
    line = next ? `${isToday ? '下一個' : '第一個'} ${next.start ?? ''} ${next.title}`.replace('  ', ' ') : '今天的行程都過了';
  }
  return (
    <div className="peek">
      <div className="peek-kicker">
        Day {idx + 1} · {dateLabel(day.date)}
        {isToday && <em className="tag today">今天</em>}
      </div>
      <div className="peek-title">{day.title || trip.title}</div>
      <div className="peek-next">{line}</div>
    </div>
  );
}

/**
 * Space the map keeps free for the floating panels. Reserved whether or not the detail card is open,
 * so selecting a pin never re-fits the map; dropped step by step when the screen is too narrow.
 */
function mapInset(width: number): MapInset {
  const MIN_MAP = 360;
  if (width <= 900) return { left: 0, right: 0 };
  if (width - RAIL_SPACE - DETAIL_SPACE >= MIN_MAP) return { left: RAIL_SPACE, right: DETAIL_SPACE };
  if (width - RAIL_SPACE >= MIN_MAP) return { left: RAIL_SPACE, right: 0 };
  return { left: 0, right: 0 };
}

interface Toast {
  id: number;
  ok: boolean;
  text: string;
}

export function App() {
  const trips = useTrips();
  const route = useRoute();
  // The trip step 0 created is on screen: forget the marker that bridged the reload.
  useEffect(() => {
    if (route.name === 'trip' && readLanding()?.tripId === route.id && trips.some((t) => t.id === route.id)) clearLanding();
  }, [route, trips]);
  const realTrips = trips.filter((t) => !t.fixture);
  if (route.name === 'office' && import.meta.env.DEV) {
    const entry = trips.find((t) => t.id === route.id);
    if (entry) return <Office key={entry.id} entry={entry} />;
  }
  if (route.name === 'print') {
    const entry = trips.find((t) => t.id === route.id);
    if (entry) return <PrintPage key={entry.id} entry={entry} query={route.query} />;
  }
  if (route.name === 'trip' || route.name === 'office') {
    const entry = trips.find((t) => t.id === route.id);
    if (entry) return <TripView key={entry.id} trips={realTrips.length ? realTrips : trips} entry={entry} />;
  }
  // Step 0 (找方向): before the sample fallback, or a user with no trips would never see their idea.
  if (route.name === 'idea') return <IdeaPage key={route.id} id={route.id} />;
  // No real trips yet: show the bundled sample so the viewer is never blank.
  const fallback = realTrips.length === 0 && trips[0] ? <TripView key={trips[0].id} trips={trips} entry={trips[0]} /> : <Home trips={trips} />;
  // A trip that step 0 just created may not be in `trips` yet (Vite has not picked up its files): wait instead of showing the fallback.
  if (route.name === 'trip') return <OpeningTrip id={route.id} fallback={fallback} />;
  return fallback;
}

function TripView({ trips, entry }: { trips: TripEntry[]; entry: TripEntry }) {
  const tripId = entry.id;
  const saved = useMemo(() => readSaved(tripId), [tripId]);
  const [file, setFile] = useState(saved.file ?? 'trip.ts');
  const activeFile = entry?.files.find((f) => f.file === file) ?? entry?.files[0];
  const trip = activeFile?.trip;
  // During the trip, opening it lands on today — an old sessionStorage selection must not win.
  // Outside the trip dates the previous view is restored as before.
  const [landIdx] = useState(() => (trip ? todayDayIdx(trip, viewerNow(trip.tz, window.location.search).date) : null));
  const landed = landIdx !== null;
  const [dayIdx, setDayIdx] = useState<number | null>(landed ? landIdx : (saved.dayIdx ?? null));
  const [selection, setSelection] = useState<Selection | null>(landed ? null : (saved.selection ?? null));
  const [tab, setTab] = useState<Tab>(landed ? 'plan' : (saved.tab ?? 'plan'));
  const railBody = useRef<HTMLDivElement | null>(null);
  const sheetMain = useRef<HTMLDivElement | null>(null);
  const { width, height } = useViewport();
  const mobile = width <= MOBILE_MAX;
  const [snap, setSnap] = useState<Snap>(landed ? 'peek' : 'half');
  const [live, setLive] = useState<number | null>(null);
  // A new tab starts at the top (the 行程 tab then scrolls to the selection itself).
  useEffect(() => {
    (mobile ? sheetMain.current : railBody.current)?.scrollTo({ top: 0 });
  }, [tab, mobile]);
  const [compare, setCompare] = useState(saved.compare ?? false);
  const [cmpLeft, setCmpLeft] = useState(saved.cmpLeft ?? 'trip.ts');
  const [cmpRight, setCmpRight] = useState(saved.cmpRight ?? '');
  const [toast, setToast] = useState<Toast | null>(null);
  const [comments, setComments] = useState<SentComment[]>(() => loadComments(tripId));

  // The clock, refreshed every minute so "next up" does not go stale on a long-open tab.
  const [clock, setClock] = useState(() => viewerNow(trip?.tz ?? 'UTC', window.location.search));
  useEffect(() => {
    const t = setInterval(() => setClock(viewerNow(trip?.tz ?? 'UTC', window.location.search)), 60_000);
    return () => clearInterval(t);
  }, [trip?.tz]);
  const todayIdx = trip ? todayDayIdx(trip, clock.date) : null;

  // Persist view state: edits to trip files reload the page.
  useEffect(() => {
    try {
      sessionStorage.setItem(
        `${STORE}.${tripId}`,
        JSON.stringify({ file: activeFile?.file, dayIdx, selection, tab, compare, cmpLeft, cmpRight } satisfies Saved),
      );
    } catch {
      /* storage unavailable: ignore */
    }
  }, [tripId, activeFile?.file, dayIdx, selection, tab, compare, cmpLeft, cmpRight]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.ok ? 3500 : 8000);
    return () => clearTimeout(t);
  }, [toast]);

  // Drop state that no longer exists (e.g. trip file changed on disk).
  useEffect(() => {
    if (!trip) return;
    if (dayIdx !== null && dayIdx >= trip.days.length) setDayIdx(null);
    if (selection?.type === 'item' && !findItem(trip, selection.id)) setSelection(null);
    if (selection?.type === 'candidate' && !trip.candidates.some((c) => c.id === selection.id)) setSelection(null);
  }, [trip, dayIdx, selection]);

  // Selecting something while the sheet is collapsed opens it to half so the detail is visible.
  useEffect(() => {
    if (mobile && selection) setSnap((s) => (s === 'peek' ? 'half' : s));
  }, [mobile, selection]);

  const currentFile = activeFile?.file ?? 'trip.ts';

  // Undo / redo of this file's edits (kept by the dev server; see src/core/history.ts).
  const [hist, setHist] = useState<HistoryInfo>({ undo: 0, redo: 0 });
  useEffect(() => {
    let live = true;
    void post('history', { tripId, ...(currentFile !== 'trip.ts' ? { file: currentFile } : {}) }).then((r) => {
      if (live && r.history) setHist(r.history);
    });
    return () => {
      live = false;
    };
  }, [tripId, currentFile]);

  const send: Send = useCallback(
    async (endpoint, body, okMessage) => {
      const res = await post(endpoint, {
        tripId,
        ...(currentFile !== 'trip.ts' && endpoint !== 'inbox' ? { file: currentFile } : {}),
        ...body,
      });
      if (res.history) setHist(res.history);
      setToast({ id: Date.now(), ok: res.ok, text: res.ok ? okMessage : `失敗：${res.error ?? '未知錯誤'}` });
      if (res.ok && endpoint === 'comment' && trip) {
        setComments(
          appendComment(tripId, {
            at: Date.now(),
            file: currentFile,
            target: targetTitle(trip, String(body.targetId ?? ''), String(body.anchor ?? 'item')),
            text: normalizeText(String(body.text ?? '')),
          }),
        );
      }
      return res.ok;
    },
    [tripId, currentFile, trip],
  );

  /** Brings the item an undo / redo touched back on screen (its day, selected in the list and map). */
  const jumpTo = (itemId: string | undefined) => {
    const ref = itemId && trip ? findItem(trip, itemId) : undefined;
    if (!ref) return;
    setSelection({ type: 'item', id: ref.item.id });
    if (dayIdx !== null) setDayIdx(ref.dayIdx);
  };
  const stepHistory = async (dir: 'undo' | 'redo') => {
    if ((dir === 'undo' ? hist.undo : hist.redo) === 0) return;
    // The page may reload as soon as the file changes, so go to the item first when it is already there.
    jumpTo(dir === 'undo' ? hist.undoItemId : hist.redoItemId);
    const res = await post(dir, { tripId, ...(currentFile !== 'trip.ts' ? { file: currentFile } : {}) });
    if (res.history) setHist(res.history);
    setToast({ id: Date.now(), ok: res.ok, text: res.ok ? `${dir === 'undo' ? '已復原' : '已重做'}：${res.label ?? ''}` : (res.error ?? '失敗') });
    if (res.ok) jumpTo(res.itemId);
  };
  // Ctrl/Cmd+Z and Shift+Ctrl/Cmd+Z (or Ctrl+Y). Inside a text field the browser's own undo of typing wins.
  const stepRef = useRef(stepHistory);
  stepRef.current = stepHistory;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      const undo = k === 'z' && !e.shiftKey;
      const redo = (k === 'z' && e.shiftKey) || (k === 'y' && !e.metaKey);
      if (!undo && !redo) return;
      if ((e.target as HTMLElement | null)?.closest('input, textarea, select, [contenteditable="true"]')) return;
      e.preventDefault();
      void stepRef.current(undo ? 'undo' : 'redo');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Tell Claude Code what the user is looking at (current-trip skill). Debounced and de-duplicated.
  const lastCurrent = useRef('');
  useEffect(() => {
    if (!trip) return;
    const itemId = selection?.type === 'item' || selection?.type === 'candidate' ? selection.id : undefined;
    let day: number | undefined = dayIdx !== null ? dayIdx + 1 : undefined;
    if (day === undefined && selection?.type === 'item') {
      const ref = findItem(trip, selection.id);
      if (ref) day = ref.dayIdx + 1;
    }
    const body = {
      tripId,
      ...(currentFile !== 'trip.ts' ? { file: currentFile } : {}),
      ...(day !== undefined ? { day } : {}),
      ...(itemId ? { itemId } : {}),
    };
    const key = JSON.stringify(body);
    if (key === lastCurrent.current) return;
    const t = setTimeout(() => {
      lastCurrent.current = key;
      void post('current', body);
    }, 300);
    return () => clearTimeout(t);
  }, [tripId, currentFile, dayIdx, selection, trip]);

  /** Scroll the 行程 tab to what is next on today (or the first row of the day being viewed). */
  const scrollToNext = useCallback(
    (idx: number, smooth = false): boolean => {
      const day = trip?.days[idx];
      if (!day) return true;
      const next = nextItem(day, idx === todayIdx ? clock.time : null);
      if (!next) return true;
      const el = document.querySelector<HTMLElement>(`li[data-item-id="${CSS.escape(next.id)}"]`);
      if (!el || el.offsetParent === null) return false; // not rendered/visible yet (e.g. sheet collapsed)
      el.scrollIntoView({ block: mobile ? 'start' : 'center', behavior: smooth ? 'smooth' : 'auto' });
      return true;
    },
    [trip, todayIdx, clock.time, mobile],
  );
  // On landing: once the list is visible, bring the next stop into view.
  const landScrolled = useRef(false);
  useEffect(() => {
    if (landIdx === null || landScrolled.current || tab !== 'plan') return;
    let tries = 0;
    const t = setInterval(() => {
      if (scrollToNext(landIdx)) {
        landScrolled.current = true;
        clearInterval(t);
      } else if (++tries > 10) clearInterval(t); // sheet collapsed: retried when it opens (snap)
    }, 150);
    return () => clearInterval(t);
  }, [landIdx, tab, snap, scrollToNext]);

  const mapData = useMemo(() => (trip ? buildMapData(trip, dayIdx) : null), [trip, dayIdx]);
  const emptyTrip = useMemo(() => ({ title: '', start: '', end: '', tz: 'UTC', party: { adults: 1, childrenAges: [] }, days: [], candidates: [] }), []);
  const health = useHealth(trip ?? emptyTrip);
  const lockedCount = useMemo(() => (trip ? lockedItems(trip).length : 0), [trip]);
  const pendingInbox = useMemo(
    () => (entry ? entry.inbox.map(parseInbox).filter((n) => n.status === 'pending').length : 0),
    [entry],
  );

  if (!entry || !trip || !mapData) {
    return <p className="empty">找不到任何旅程。請在 trips/&lt;id&gt;/trip.ts 建立行程。</p>;
  }

  // Compare needs two files; fall back to the normal view otherwise.
  const canCompare = entry.files.length > 1;
  const showCompare = compare && canCompare;
  const fileNames = entry.files.map((f) => f.file);
  const left = fileNames.includes(cmpLeft) ? cmpLeft : (fileNames[0] ?? 'trip.ts');
  const right = fileNames.includes(cmpRight) && cmpRight !== left ? cmpRight : (fileNames.find((f) => f !== left) ?? left);

  const select = (sel: Selection | null) => {
    setSelection(sel);
    if (sel && (sel.type === 'item' || sel.type === 'gap' || sel.type === 'day')) setTab('plan');
  };
  const selectPin = (pin: MapPin) => select(pin.sel);
  const selectFromFacts = (sel: Selection, di: number | null) => {
    setSelection(sel);
    if (di !== null && dayIdx !== null) setDayIdx(di);
  };
  const backToToday = () => {
    if (todayIdx === null) return;
    setDayIdx(todayIdx);
    setSelection(null);
    setTab('plan');
    if (mobile && snap === 'peek') setSnap('half');
    setTimeout(() => scrollToNext(todayIdx, true), 120);
  };
  const showCandidates = () => {
    setTab('plan');
    setTimeout(() => document.querySelector('.cands')?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 80);
  };
  const inset = mobile ? { left: 0, right: 0 } : mapInset(width);
  const counts: Record<Tab, number> = { plan: 0, facts: lockedCount, inbox: entry.inbox.length };

  // AI 助手 (src/agent/) only exists behind the dev server, so a production build never offers it.
  // It takes the detail card's slot, so the card steps aside while the panel is open.
  const [agentOpen, setAgentOpen] = usePanelOpen();
  const agentRunning = useAgent().active?.status === 'running';
  const agentView = agentContext(trip, { tripId, file: currentFile, dayIdx, selection });

  const heights = sheetHeights(height);
  const sheetH = live ?? heights[snap];
  const pushed = mobile && !!selection && !showCompare;

  const header = (
    <RailHeader
      trips={trips}
      tripId={entry.id}
      onTrip={(id) => go(`/trip/${id}`)}
      onHome={() => go('/')}
      entry={entry}
      file={currentFile}
      onFile={(f) => {
        setFile(f);
        setSelection(null);
      }}
      trip={trip}
      compare={showCompare}
      onCompare={() => setCompare(!showCompare)}
      agent={import.meta.env.DEV ? { open: agentOpen, running: agentRunning, onToggle: () => setAgentOpen((o) => !o) } : undefined}
      onOffice={import.meta.env.DEV ? () => go(`/trip/${tripId}/office`) : undefined}
      history={
        import.meta.env.DEV
          ? { ...hist, onUndo: () => void stepHistory('undo'), onRedo: () => void stepHistory('redo') }
          : undefined
      }
    />
  );
  const strip = <DayStrip trip={trip} dayIdx={dayIdx} onDay={setDayIdx} />;
  const todayRow = todayIdx !== null && dayIdx !== todayIdx && (
    <div className="today-row">
      <button type="button" className="btn today-btn" onClick={backToToday}>
        回到今天 · Day {todayIdx + 1}
      </button>
    </div>
  );
  const tabs = (
    <div className="tabs" role="tablist" aria-label="面板">
      {TABS.map(([id, label]) => (
        <button
          key={id}
          type="button"
          role="tab"
          id={`tab-${id}`}
          aria-selected={tab === id}
          aria-controls="rail-body"
          className="tab"
          onClick={() => setTab(id)}
        >
          {label}
          {counts[id] > 0 && <span className={`count${id === 'inbox' && pendingInbox > 0 ? ' hot' : ''}`}>{counts[id]}</span>}
        </button>
      ))}
    </div>
  );
  const body = (
    <div className="rail-body" id="rail-body" ref={railBody} role="tabpanel" aria-labelledby={`tab-${tab}`}>
      {tab === 'plan' && (
        <>
          <AddPlace trip={trip} dayIdx={dayIdx} send={send} />
          <OptimizeHint tripId={tripId} file={currentFile} trip={trip} dayIdx={dayIdx} send={send} />
          <Itinerary
            tripId={tripId}
            trip={trip}
            dayIdx={dayIdx}
            selection={selection}
            onSelect={select}
            onEditField={(itemId, field, value) =>
              void send('item-field', { itemId, field, value }, field === 'title' ? '已更新名稱' : `已更新時間為 ${value}`)
            }
            onMove={(itemId, toDate, beforeItemId) =>
              void send('move-item', { itemId, toDate, beforeItemId }, '已調整順序；時間可請 Claude 重新安排')
            }
            onSchedule={(candidateId, toDate, beforeItemId) =>
              void send('schedule-candidate', { candidateId, toDate, beforeItemId }, '已排入行程')
            }
            onColor={
              import.meta.env.DEV
                ? (dates, color) => void send('day-color', { dates, color }, color === null ? '已恢復自動顏色（同住宿同顏色）' : `已換成${COLOR_NAMES[color - 1]}色，⌘Z 可復原`)
                : undefined
            }
          />
        </>
      )}
      {tab === 'facts' && <FactsPanel tripId={tripId} trip={trip} health={health} send={send} onSelect={selectFromFacts} />}
      {tab === 'inbox' && <InboxPanel inbox={entry.inbox} candidates={trip.candidates} send={send} />}
    </div>
  );
  const foot = (
    <RailFoot
      tripId={tripId}
      trip={trip}
      health={health}
      lockedCount={lockedCount}
      pendingInbox={pendingInbox}
      comments={comments}
      variant={entry.files.length > 1 ? variantName(currentFile) : undefined}
      onFacts={() => setTab('facts')}
      onCandidates={showCandidates}
      onInbox={() => setTab('inbox')}
      onPrint={() => go(`/trip/${tripId}/print${currentFile !== 'trip.ts' ? `?file=${currentFile}` : ''}`)}
    />
  );
  const detail = (embedded: boolean) => (
    <DetailPanel
      tripId={tripId}
      trip={trip}
      selection={selection as Selection}
      dayIdx={dayIdx}
      send={send}
      onClose={() => setSelection(null)}
      embedded={embedded}
    />
  );

  return (
    <div
      className="app"
      data-snap={mobile ? snap : undefined}
      style={mobile ? ({ ['--map-bottom' as string]: `${heights[snap === 'full' ? 'half' : snap]}px` } as React.CSSProperties) : undefined}
    >
      <div className="map-layer">
        <MapPanel data={mapData} selectedKey={selKey(selection)} onSelect={selectPin} inset={inset} />
      </div>

      {mobile ? (
        <aside
          className="rail card sheet"
          aria-label="旅程面板"
          data-snap={snap}
          data-dragging={live !== null ? '' : undefined}
          style={{ height: sheetH }}
        >
          <SheetGrip snap={snap} heights={heights} onSnap={setSnap} onLive={setLive}>
            <PeekSummary trip={trip} dayIdx={dayIdx} todayIdx={todayIdx} time={clock.time} />
          </SheetGrip>
          <div className={`sheet-stack${pushed ? ' pushed' : ''}`}>
            <div className="sheet-layer sheet-main" ref={sheetMain} inert={pushed} aria-hidden={pushed || undefined}>
              {header}
              <div className="rail-nav">
                {strip}
                {todayRow}
                {tabs}
              </div>
              {body}
              {foot}
            </div>
            <div className="sheet-layer sheet-detail" inert={!pushed} aria-hidden={!pushed || undefined}>
              {pushed && detail(true)}
            </div>
          </div>
        </aside>
      ) : (
        <aside className="rail card" aria-label="旅程面板">
          {header}
          {strip}
          {todayRow}
          {tabs}
          {body}
          {foot}
        </aside>
      )}

      {showCompare && (
        <section className="compare-sheet card" aria-label="比較方案">
          <header>
            <h2>比較方案</h2>
            <button type="button" className="close-x" onClick={() => setCompare(false)} aria-label="關閉比較">
              ×
            </button>
          </header>
          <CompareView
            entry={entry}
            left={left}
            right={right}
            onPick={(side, f) => (side === 'left' ? setCmpLeft(f) : setCmpRight(f))}
            onOpen={(f, di) => {
              setFile(f);
              setDayIdx(di);
              setSelection(null);
              setCompare(false);
            }}
          />
        </section>
      )}

      {selection && !showCompare && !mobile && !agentOpen && detail(false)}
      {import.meta.env.DEV && agentOpen && <AgentPanel context={agentView.context} contextLabel={agentView.label} onClose={() => setAgentOpen(false)} />}

      <PrintLayer trip={trip} />
      {entry.fixture && <div className="fixture-note">顯示範例資料（trips/ 內沒有行程）</div>}
      <div className="toast-region" role="status" aria-live="polite">
        {toast && <div className={`toast ${toast.ok ? 'ok' : 'err'}`}>{toast.text}</div>}
      </div>
    </div>
  );
}
