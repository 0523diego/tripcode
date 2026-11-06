import { useEffect, useMemo, useRef, useState } from 'react';
import type { Candidate, Day, Item, Trip } from '../../core/types.ts';
import { dayMapsLinks, fromMinutes } from '../../core/index.ts';
import { MODE_LABEL, duration, safeMinutes, transitTime } from '../travel.ts';
import { KIND_LABEL, STATUS_LABEL, dateLabel, dayVar, hasLoc, selKey, type Selection } from '../model.ts';
import { InlineEdit } from './InlineEdit.tsx';

/** Fields that can be edited in place (double-click, or F2 on the focused row). */
type InlineField = 'title' | 'start';

interface EditApi {
  editing: { id: string; field: InlineField } | null;
  start: (id: string, field: InlineField) => void;
  stop: () => void;
  commit: (id: string, field: InlineField, value: string) => void;
}

interface Props {
  trip: Trip;
  dayIdx: number | null;
  selection: Selection | null;
  onSelect: (sel: Selection) => void;
  /** Save a title or start time edited in the list. Omitted = the list is read-only. */
  onEditField?: (itemId: string, field: InlineField, value: string) => void;
  /** Move an item to `toDate`, before `beforeId` (null = end of that day). */
  onMove: (itemId: string, toDate: string, beforeId: string | null) => void;
  /** Turn a candidate into an item of `toDate`, before `beforeId` (null = end). */
  onSchedule: (candidateId: string, toDate: string, beforeId: string | null) => void;
}

interface Drag {
  kind: 'item' | 'cand';
  id: string;
  title: string;
  date: string;
  x: number;
  y: number;
}
interface Target {
  date: string;
  beforeId: string | null;
  /** Indicator offset inside the day block, px. */
  top: number;
}

/** Shared drag-handle props (pointer drag + keyboard up/down). */
interface HandleApi {
  start: (e: React.PointerEvent, kind: Drag['kind'], id: string, title: string, date: string) => void;
  nudge: (id: string, date: string, dir: -1 | 1) => void;
  draggingId: string | null;
}

function Handle({ api, kind, id, title, date }: { api: HandleApi; kind: Drag['kind']; id: string; title: string; date: string }) {
  return (
    <button
      type="button"
      className="grip"
      aria-label={`拖曳調整「${title}」的順序；也可用上下方向鍵`}
      title="拖曳調整順序"
      onPointerDown={(e) => api.start(e, kind, id, title, date)}
      onKeyDown={(e) => {
        if (kind !== 'item') return;
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          api.nudge(id, date, e.key === 'ArrowUp' ? -1 : 1);
        }
      }}
    >
      <span aria-hidden="true">⋮⋮</span>
    </button>
  );
}

/** Gaps shorter than this are not offered as "空檔" rows. */
const GAP_MIN = 60;

/** A day whose last timed item ends before this still has an open evening worth offering. */
const TAIL_FREE_AFTER = 17 * 60;



function isUrl(s: string): boolean {
  return /^https?:\/\/\S+$/i.test(s.trim());
}

function hostOf(u: string): string {
  try {
    return new URL(u.trim()).hostname.replace(/^www\./, '');
  } catch {
    return u;
  }
}

function timeOf(it: Item): string {
  return it.start ?? (it.kind === 'flight' && it.end ? it.end : '');
}

function subline(it: Item): string[] {
  const parts: string[] = [KIND_LABEL[it.kind]];
  const s = safeMinutes(it.start);
  const e = safeMinutes(it.end);
  if (s !== null && e !== null && e > s) parts.push(duration(e - s));
  else if (it.kind === 'poi' && it.minutes) parts.push(duration(it.minutes));
  if (it.kind === 'hotel') parts.push(`${it.nights} 晚`);
  if (it.kind === 'flight') parts.push(it.flightNo + (!it.start && it.end ? ' · 抵達' : ''));
  return parts;
}

function DayBlock({
  day,
  dayIdx,
  selection,
  onSelect,
  pending,
  api,
  edit,
  target,
}: {
  day: Day;
  dayIdx: number;
  selection: Selection | null;
  onSelect: (s: Selection) => void;
  pending: Candidate[];
  api: HandleApi;
  edit: EditApi | null;
  target: Target | null;
}) {
  const links = useMemo(() => {
    try {
      return dayMapsLinks(day);
    } catch {
      return [];
    }
  }, [day]);
  const selected = selKey(selection);
  const rows: React.ReactNode[] = [];
  const anyTime = day.items.some((it) => timeOf(it) !== '' || safeMinutes(it.end) !== null);
  let prevEnd: number | null = null;
  let prevWasTransit = false;
  /** End of the latest timed item, only when it states an explicit end (a bare start says nothing about duration). */
  let tailFrom: number | null = null;

  for (const [idx, it] of day.items.entries()) {
    const start = safeMinutes(it.start);
    if (prevEnd !== null && start !== null && start - prevEnd >= GAP_MIN && it.kind !== 'transit' && !prevWasTransit) {
      const from = fromMinutes(prevEnd);
      const to = fromMinutes(start);
      const isSel = selection?.type === 'gap' && selection.targetId === it.id;
      rows.push(
        <li key={`gap-${it.id}`}>
          <button
            type="button"
            className={`it-gap${isSel ? ' sel' : ''}`}
            onClick={() => onSelect({ type: 'gap', date: day.date, targetId: it.id, from, to })}
          >
            <span />
            <span />
            <span>空檔 {duration(start - prevEnd)} · 點此留言安排</span>
          </button>
        </li>,
      );
    }
    const key = `item:${it.id}`;
    if (it.kind === 'transit') {
      const tt = transitTime(day.items, idx);
      rows.push(
        <li key={it.id} className={`drow${api.draggingId === it.id ? ' dragging' : ''}`} data-item-id={it.id}>
          <Handle api={api} kind="item" id={it.id} title={it.title} date={day.date} />
          <button
            type="button"
            data-sel={key}
            className={`it-transit${selected === key ? ' sel' : ''}`}
            onClick={() => onSelect({ type: 'item', id: it.id })}
          >
            <time>{it.start ?? ''}</time>
            <span className="tnode" />
            <span className="t-text">
              <span className="t-mode">{MODE_LABEL[it.mode] ?? it.mode}</span>
              {tt && (tt.minutes !== null || tt.km !== null) && (
                <>
                  {' · '}
                  <span className={`t-dur${tt.estimated ? ' est' : ''}`} title={tt.tip}>
                    {tt.minutes !== null && `${tt.estimated ? '約 ' : ''}${duration(tt.minutes)}`}
                    {tt.minutes !== null && tt.estimated && tt.km !== null && ' · '}
                    {tt.estimated && tt.km !== null && `${tt.km < 10 ? tt.km.toFixed(1) : Math.round(tt.km)} km${tt.minutes === null ? '（直線）' : ''}`}
                  </span>
                </>
              )}
              {' · '}
              {it.title}
            </span>
          </button>
        </li>,
      );
    } else {
      // While a field is being edited the row is a <div>: an <input> cannot live inside a <button>.
      const editingHere = edit?.editing?.id === it.id ? edit.editing.field : null;
      const rowClass = `it${it.locked ? ' locked' : ''}${timeOf(it) ? '' : ' untimed'}${selected === key ? ' sel' : ''}${editingHere ? ' editing' : ''}`;
      const inner = (
        <>
          <time
            title={edit && it.start ? '按兩下改時間' : undefined}
            onDoubleClick={edit && it.start ? () => edit.start(it.id, 'start') : undefined}
          >
            {editingHere === 'start' && edit ? (
              <InlineEdit kind="time" value={it.start ?? ''} label={`「${it.title}」的開始時間`} onCommit={(v) => edit.commit(it.id, 'start', v)} onDone={edit.stop} />
            ) : (
              timeOf(it)
            )}
          </time>
          <span className="node" />
          <span className="it-main">
            <span className="it-title" title={edit ? '按兩下改名稱（或按 F2）' : undefined} onDoubleClick={edit ? () => edit.start(it.id, 'title') : undefined}>
              {editingHere === 'title' && edit ? (
                <InlineEdit kind="title" value={it.title} label="項目名稱" onCommit={(v) => edit.commit(it.id, 'title', v)} onDone={edit.stop} />
              ) : (
                it.title
              )}
            </span>
            <span className="it-sub">
              {subline(it).join(' · ')}
              {it.locked && <em className="tag lock">已確定</em>}
              {!hasLoc(it) && <em className="tag">無座標</em>}
            </span>
          </span>
        </>
      );
      rows.push(
        <li key={it.id} className={`drow${api.draggingId === it.id ? ' dragging' : ''}`} data-item-id={it.id}>
          <Handle api={api} kind="item" id={it.id} title={it.title} date={day.date} />
          {editingHere ? (
            <div data-sel={key} className={rowClass}>
              {inner}
            </div>
          ) : (
            <button
              type="button"
              data-sel={key}
              className={rowClass}
              onClick={() => onSelect({ type: 'item', id: it.id })}
              onKeyDown={edit ? (e) => e.key === 'F2' && (e.preventDefault(), edit.start(it.id, 'title')) : undefined}
            >
              {inner}
            </button>
          )}
        </li>,
      );
    }
    const end = safeMinutes(it.end) ?? start;
    // A gap row belongs to the following item; it never counts as a drop position.
    if (end !== null) prevEnd = end;
    if (start !== null || safeMinutes(it.end) !== null) tailFrom = safeMinutes(it.end);
    prevWasTransit = it.kind === 'transit';
  }

  // Most items carry no time, so the in-between gap rows rarely appear. Offer one at the end of
  // a day that is wide open: no times at all, or a last timed item that ends well before evening.
  const last = day.items[day.items.length - 1];
  if (last && last.kind !== 'transit') {
    let tail: { from: string; to: string; label: string } | null = null;
    if (!anyTime) {
      tail = { from: '白天', to: '晚上', label: '這天還很鬆' };
    } else if (tailFrom !== null && tailFrom <= TAIL_FREE_AFTER) {
      tail = { from: fromMinutes(tailFrom), to: '晚上', label: `${fromMinutes(tailFrom)} 之後還很鬆` };
    }
    if (tail) {
      const t = tail;
      const isSel = selection?.type === 'gap' && selection.targetId === last.id && selection.to === t.to;
      rows.push(
        <li key="gap-tail">
          <button
            type="button"
            className={`it-gap tail${isSel ? ' sel' : ''}`}
            onClick={() => onSelect({ type: 'gap', date: day.date, targetId: last.id, from: t.from, to: t.to })}
          >
            <span />
            <span />
            <span>{t.label} · 點此留言安排</span>
          </button>
        </li>,
      );
    }
  }

  for (const c of pending) {
    const k = `candidate:${c.id}`;
    rows.push(
      <li key={`pending-${c.id}`} className={`drow pending${api.draggingId === c.id ? ' dragging' : ''}`}>
        <Handle api={api} kind="cand" id={c.id} title={c.title} date={day.date} />
        <button type="button" data-sel={k} className={`it${selected === k ? ' sel' : ''}`} onClick={() => onSelect({ type: 'candidate', id: c.id })}>
          <time />
          <span className="node pending-node" />
          <span className="it-main">
            <span className="it-title">{c.title}</span>
            <span className="it-sub">
              <em className="tag pending-tag">待排入</em> 拖到想要的位置，或點「排入」
            </span>
          </span>
        </button>
      </li>,
    );
  }

  return (
    <section className={`day-block${anyTime ? '' : ' notimes'}`} data-date={day.date} style={{ ['--day-color' as string]: `var(${dayVar(dayIdx)})` }}>
      {target && target.date === day.date && <div className="drop-line" style={{ top: target.top }} aria-hidden="true" />}
      <header className="day-head">
        <div className="day-kicker">
          <span className="swatch" />
          DAY {dayIdx + 1} · {dateLabel(day.date)}
          {day.weather === 'clear' && <em className="tag weather">需好天氣</em>}
        </div>
        {day.title && <h2 className="day-name">{day.title}</h2>}
        <div className="day-links">
          <button type="button" className="link" onClick={() => onSelect({ type: 'day', date: day.date })}>
            整天留言
          </button>
          {links.map((url, i) => (
            <a key={url} href={url} target="_blank" rel="noreferrer noopener">
              在 Google 地圖開啟{links.length > 1 ? ` ${i + 1}` : ''} ↗
            </a>
          ))}
        </div>
      </header>
      {rows.length > 0 ? <ol className="itin">{rows}</ol> : <p className="day-empty">這天還沒有安排。</p>}
    </section>
  );
}

export function Itinerary({ trip, dayIdx, selection, onSelect, onEditField, onMove, onSchedule }: Props) {
  const root = useRef<HTMLDivElement | null>(null);
  const key = selKey(selection);
  const [editing, setEditing] = useState<EditApi['editing']>(null);
  const edit: EditApi | null = onEditField
    ? {
        editing,
        start: (id, field) => setEditing({ id, field }),
        stop: () => setEditing(null),
        commit: onEditField,
      }
    : null;
  const [drag, setDrag] = useState<Drag | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const targetRef = useRef<Target | null>(null);
  targetRef.current = target;

  useEffect(() => {
    if (!key || !root.current || drag) return;
    const el = root.current.querySelector(`[data-sel="${CSS.escape(key)}"]`);
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  /** Where would a drop at viewport y land? Picks the day block under (or nearest to) y. */
  const locate = (y: number, draggedId: string): Target | null => {
    const blocks = [...(root.current?.querySelectorAll<HTMLElement>('section.day-block') ?? [])];
    if (blocks.length === 0) return null;
    let block = blocks.find((b) => {
      const r = b.getBoundingClientRect();
      return y >= r.top && y <= r.bottom;
    });
    if (!block) {
      block = blocks.reduce((best, b) => {
        const r = b.getBoundingClientRect();
        const d = Math.min(Math.abs(y - r.top), Math.abs(y - r.bottom));
        const br = best.getBoundingClientRect();
        return d < Math.min(Math.abs(y - br.top), Math.abs(y - br.bottom)) ? b : best;
      });
    }
    const bRect = block.getBoundingClientRect();
    const rows = [...block.querySelectorAll<HTMLElement>('li[data-item-id]')].filter((r) => r.dataset.itemId !== draggedId);
    const next = rows.find((r) => {
      const rr = r.getBoundingClientRect();
      return rr.top + rr.height / 2 > y;
    });
    const list = block.querySelector('.itin');
    const top = next
      ? next.getBoundingClientRect().top - bRect.top
      : rows.length > 0
        ? rows[rows.length - 1]!.getBoundingClientRect().bottom - bRect.top
        : (list?.getBoundingClientRect().top ?? bRect.bottom - 8) - bRect.top;
    return { date: block.dataset.date ?? '', beforeId: next?.dataset.itemId ?? null, top };
  };

  useEffect(() => {
    if (!drag) return;
    const scroller = root.current?.closest('.rail-body') as HTMLElement | null;
    const move = (e: PointerEvent) => {
      setDrag((d) => (d ? { ...d, x: e.clientX, y: e.clientY } : d));
      setTarget(locate(e.clientY, drag.id));
      if (scroller) {
        const r = scroller.getBoundingClientRect();
        if (e.clientY < r.top + 48) scroller.scrollBy({ top: -14 });
        else if (e.clientY > r.bottom - 48) scroller.scrollBy({ top: 14 });
      }
    };
    const up = () => {
      const t = targetRef.current;
      setDrag(null);
      setTarget(null);
      if (!t || !t.date) return;
      if (drag.kind === 'cand') return onSchedule(drag.id, t.date, t.beforeId);
      // Skip no-op drops (same day, same neighbour).
      const day = trip.days.find((d) => d.date === drag.date);
      const idx = day?.items.findIndex((it) => it.id === drag.id) ?? -1;
      const nextId = day && idx >= 0 ? (day.items[idx + 1]?.id ?? null) : undefined;
      if (t.date === drag.date && t.beforeId === nextId) return;
      onMove(drag.id, t.date, t.beforeId);
    };
    const cancel = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setDrag(null);
        setTarget(null);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    window.addEventListener('keydown', cancel);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('keydown', cancel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag?.id]);

  const api: HandleApi = {
    draggingId: drag?.id ?? null,
    start: (e, kind, id, title, date) => {
      if (e.button !== 0) return;
      e.preventDefault();
      setDrag({ kind, id, title, date, x: e.clientX, y: e.clientY });
      setTarget(locate(e.clientY, id));
    },
    nudge: (id, date, dir) => {
      const day = trip.days.find((d) => d.date === date);
      if (!day) return;
      const i = day.items.findIndex((it) => it.id === id);
      if (dir === -1 && i > 0) onMove(id, date, day.items[i - 1]!.id);
      if (dir === 1 && i >= 0 && i < day.items.length - 1) onMove(id, date, day.items[i + 2]?.id ?? null);
    },
  };

  const pendingFor = (i: number) => trip.candidates.filter((c) => c.status === 'accepted' && c.day === i + 1);

  return (
    <div ref={root} className={drag ? 'is-dragging' : undefined}>
      {trip.days.map((day, i) =>
        dayIdx === null || dayIdx === i ? (
          <DayBlock
            key={day.date}
            day={day}
            dayIdx={i}
            selection={selection}
            onSelect={onSelect}
            pending={pendingFor(i)}
            api={api}
            edit={edit}
            target={target}
          />
        ) : null,
      )}
      {drag && (
        <div className="drag-ghost" style={{ left: drag.x + 14, top: drag.y - 14 }} aria-hidden="true">
          {drag.title}
        </div>
      )}
      {trip.candidates.length > 0 && (
        <section className="cands">
          <p className="section-label">候選景點 · {trip.candidates.length}</p>
          <ul>
            {trip.candidates.map((c) => {
              const k = `candidate:${c.id}`;
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    data-sel={k}
                    className={`cand-row${key === k ? ' sel' : ''}`}
                    onClick={() => onSelect({ type: 'candidate', id: c.id })}
                  >
                    <span className={`cand-mark s-${c.status}`} aria-hidden="true" />
                    <span className="cand-title">{c.title}</span>
                    <span className={`status-chip s-${c.status}`}>
                      {STATUS_LABEL[c.status]}
                      {c.status === 'accepted' && c.day ? ` · 第 ${c.day} 天` : ''}
                    </span>
                  </button>
                  {c.sources.some(isUrl) && (
                    <p className="cand-src">
                      來源：
                      {c.sources.filter(isUrl).map((u) => (
                        <a key={u} href={u} target="_blank" rel="noreferrer noopener" title={u}>
                          {hostOf(u)} ↗
                        </a>
                      ))}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
