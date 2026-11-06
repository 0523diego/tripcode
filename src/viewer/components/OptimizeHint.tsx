import { useEffect, useState } from 'react';
import type { Trip } from '../../core/types.ts';
import { post, type Send } from '../api.ts';
import { dateLabel } from '../model.ts';

/** Reply of the `optimize` endpoint (minutes are travel minutes for the whole day). */
export interface OptimizeResult {
  ok: true;
  currentMinutes: number;
  bestMinutes: number;
  savedMinutes: number;
  order: string[];
  /** 'haversine-estimate' (straight-line guess) or a provider tag such as 'google-routes'. */
  source: string;
}

/** Worth mentioning: below this the suggestion is noise. */
export const MIN_SAVED_MINUTES = 10;

export function parseOptimize(r: unknown): OptimizeResult | null {
  const o = r as Partial<OptimizeResult> | null;
  if (!o || o.ok !== true) return null;
  if (typeof o.savedMinutes !== 'number' || typeof o.currentMinutes !== 'number' || typeof o.bestMinutes !== 'number') return null;
  if (!Array.isArray(o.order) || o.order.some((x) => typeof x !== 'string')) return null;
  if (typeof o.source !== 'string') return null;
  return o as OptimizeResult;
}

interface Props {
  tripId: string;
  file: string;
  trip: Trip;
  dayIdx: number | null;
  send: Send;
}

/**
 * Single-day view only: "this day could save N minutes". Never applies the order itself — the only
 * action is a comment asking Claude to do it. Hidden whenever the endpoint is missing or fails.
 */
export function OptimizeHint({ tripId, file, trip, dayIdx, send }: Props) {
  const [res, setRes] = useState<{ key: string; r: OptimizeResult } | null>(null);
  const [open, setOpen] = useState(false);
  const key = `${tripId}/${file}/${dayIdx}`;

  useEffect(() => {
    setOpen(false);
    if (dayIdx === null) return;
    let live = true;
    const t = setTimeout(() => {
      void post('optimize', { tripId, ...(file !== 'trip.ts' ? { file } : {}), day: dayIdx + 1 }).then((r) => {
        const parsed = parseOptimize(r);
        if (live && parsed) setRes({ key, r: parsed });
      });
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [tripId, file, dayIdx, key]);

  const day = dayIdx !== null ? trip.days[dayIdx] : undefined;
  const r = res && res.key === key ? res.r : null;
  if (!day || !r || r.savedMinutes < MIN_SAVED_MINUTES) return null;

  // Anything that is not a verified route provider is labelled an estimate: never present a guess as fact.
  const estimate = r.source !== 'google-routes';
  const titles = r.order.map((id) => day.items.find((i) => i.id === id)?.title ?? id);
  const ask = () =>
    send(
      'comment',
      {
        targetId: day.date,
        anchor: 'day',
        text: `請依順路建議重排這天：${titles.join(' → ')}（預估可省約 ${r.savedMinutes} 分鐘，${estimate ? '直線估算' : 'Google 路線資料'}；鎖定的項目與有時間限制的票請維持原樣）`,
      },
      '已留言請 Claude 重排這天，等它套用',
    );

  return (
    <section className={`opt-hint${open ? ' open' : ''}`} aria-label="順路建議">
      <button type="button" className="opt-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>
          這天可省{estimate ? '約 ' : ' '}
          {r.savedMinutes} 分鐘 · {open ? '收起' : '看看'}
        </span>
        {estimate && <em>直線估算</em>}
      </button>
      {open && (
        <div className="opt-body">
          <p className="opt-compare">
            {dateLabel(day.date)} 移動時間 {r.currentMinutes} → {r.bestMinutes} 分鐘
          </p>
          <ol className="opt-order">
            {titles.map((t, i) => (
              <li key={`${r.order[i]}-${i}`}>{t}</li>
            ))}
          </ol>
          <p className={`opt-source${estimate ? ' warn' : ''}`}>
            {estimate ? '直線估算，僅供參考：沒有用真實路線與交通時刻。' : '依 Google 路線資料計算。'}
            這裡只是建議，不會自動改動行程。
          </p>
          <button type="button" className="btn primary" onClick={() => void ask()}>
            留言請 Claude 套用
          </button>
        </div>
      )}
    </section>
  );
}
