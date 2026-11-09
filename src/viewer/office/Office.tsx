// 訂票清單 page: where a planned trip turns into the things the user buys themselves. It lists what to book with the
// official page and Klook / Trip.com links, the meals that still have no place, and what is left to do before leaving
// (see Bookings.tsx). The AI panel is docked beside it. TripCode does not pay for anything; the optional section at the
// bottom only shows price and sale-date watches and their alerts.
import { useEffect, useMemo, useState } from 'react';
import type { WatchView } from '../../purchase/office.ts';
import { AgentPanel } from '../agent/AgentPanel.tsx';
import { sendMessage } from '../agent/agent-store.ts';
import { deriveBookingTodos } from '../../core/bookings.ts';
import { findMealGaps } from '../../core/meals.ts';
import { planStages } from '../../core/plan.ts';
import { readiness, readinessSummary } from '../../core/readiness.ts';
import { post } from '../api.ts';
import { go } from '../route.ts';
import { profileText } from '../trips.ts';
import type { TripEntry } from '../trips.ts';
import { BOOKING_PROMPTS, relTime } from './booking-model.ts';
import { BookingSection, MealSection, ReadinessCard } from './Bookings.tsx';
import { TripSide } from './TripSide.tsx';
import { useOffice } from './useOffice.ts';

/** Below this width the 行程 and AI panels cannot sit side by side without squeezing the list. */
const BOTH_PANELS_MIN = 1180;

const money = (n: number, c: string) => `${c} ${Math.round(n * 100) / 100}`;

function Spark({ values, className }: { values: number[]; className?: string }) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${22 - ((v - min) / span) * 18}`).join(' ');
  return (
    <svg className={className ?? 'of-spark'} viewBox="0 0 100 26" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={pts} />
    </svg>
  );
}

function WatchCard({ w, nowMs }: { w: WatchView; nowMs: number }) {
  const price = w.last?.ok && w.last.amount !== undefined ? money(w.last.amount, w.last.currency ?? w.currency ?? '') : undefined;
  let host = '';
  try {
    host = new URL(w.url).hostname.replace(/^www\./, '');
  } catch {
    /* validated when created */
  }
  return (
    <li className="of-card">
      <div className="of-card-top">
        <b>{w.title}</b>
        <span className="muted">{host}</span>
      </div>
      <div className="of-card-mid">
        <strong>{price ?? (w.last && !w.last.ok ? '讀不到' : w.kind === 'availability' ? (w.last?.available ? '可以買了' : '還不能買') : '尚未讀取')}</strong>
        <Spark values={w.history} />
      </div>
      <div className="of-card-foot muted">
        {w.targetPrice !== undefined && <span>目標 {money(w.targetPrice, w.currency ?? '')}</span>}
        {w.lowest !== undefined && <span>最低 {w.lowest}</span>}
        {w.render && <span>用 Chrome 讀</span>}
        {w.opensAt && <span>開賣 {w.opensAt.slice(0, 16).replace('T', ' ')}</span>}
        {w.last && <span>{relTime(w.last.at, nowMs)}看過</span>}
      </div>
    </li>
  );
}


// ---------- watching: prices and sale dates ----------

function Watching({ entry, say }: { entry: TripEntry; say: (message: string, ok?: boolean) => void }) {
  const tripId = entry.id;
  const { state, error, nowMs, refresh, act } = useOffice(tripId);
  const trip = state?.trips.find((t) => t.id === tripId);
  const unseen = (trip?.alerts ?? []).filter((a) => !a.seen);
  const feed = state ? [...state.activity].filter((a) => !a.tripId || a.tripId === tripId).reverse().slice(0, 10) : [];
  const run = async (endpoint: string, body: Record<string, unknown>, ok: string) => {
    const r = await act(endpoint, body);
    say(r.ok ? ok : (r.error ?? '失敗'), r.ok);
  };
  if (error && !state) {
    return (
      <div className="of-offline card" role="alert">
        <b>連不上本機伺服器</b>
        <p className="muted">這一區需要 <code>npm run dev</code> 開著。</p>
        <button type="button" className="btn" onClick={() => void refresh()}>
          再試一次
        </button>
      </div>
    );
  }
  if (!state) return null;
  const watches = trip?.watches.filter((w) => w.active) ?? [];
  return (
    <div className="of-adv">
      <div className="of-chips">
        <button type="button" className="btn" onClick={() => void run('scan', { tripId, force: true }, '已經看過一輪')} disabled={watches.length === 0}>
          現在看一次
        </button>
        {unseen.length > 0 && (
          <button type="button" className="btn" onClick={() => void run('ack', { tripId }, '都標成已讀')}>
            提醒全部已讀（{unseen.length}）
          </button>
        )}
      </div>
      {watches.length === 0 ? (
        <p className="of-empty muted">還沒有要盯的東西。固定價格的門票不用盯；有開賣日的，可以對 AI 說「幫我設開賣提醒」。機票請用 Google Flights 自己的「追蹤價格」。</p>
      ) : (
        <ul className="of-cards">
          {watches.map((w) => (
            <WatchCard key={w.id} w={w} nowMs={nowMs} />
          ))}
        </ul>
      )}
      {(trip?.alerts.length ?? 0) > 0 && (
        <ul className="of-list">
          {trip!.alerts.slice(0, 8).map((a) => (
            <li key={a.id} className={a.seen ? 'seen' : ''}>
              <span>{a.message}</span>
              <time className="muted">{relTime(a.at, nowMs)}</time>
            </li>
          ))}
        </ul>
      )}
      {feed.length > 0 && (
        <ul className="of-list feed" aria-live="polite">
          {feed.map((a, n) => (
            <li key={`${a.at}-${n}`} data-level={a.level}>
              <i data-agent={a.actor} aria-hidden="true" />
              <span>{a.text}</span>
              <time className="muted">{relTime(a.at, nowMs)}</time>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------- the page ----------

export function Office({ entry }: { entry: TripEntry }) {
  const tripId = entry.id;
  const main = entry.files[0];
  const trip = main?.trip;
  const file = main?.file ?? 'trip.ts';
  const title = trip?.title ?? tripId;
  const [now, setNow] = useState(() => new Date());
  const [agentOpen, setAgentOpen] = useState(false);
  const [tripOpen, setTripOpen] = useState(false);
  const [watchOpen, setWatchOpen] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);
  const say = (text: string, ok = true) => {
    setMsg({ text, ok });
    setTimeout(() => setMsg(null), ok ? 3500 : 8000);
  };
  // Two side panels need room: on a narrower screen opening one closes the other.
  const roomForBoth = () => window.innerWidth >= BOTH_PANELS_MIN;
  const openAgent = () => {
    setAgentOpen(true);
    if (!roomForBoth()) setTripOpen(false);
  };
  const ask = (text: string) => {
    openAgent();
    void sendMessage(text, { tripId, tripTitle: title });
  };
  const accept = async (date: string, code: string) => {
    const have = trip?.days.find((d) => d.date === date)?.accepted ?? [];
    const r = await post('accept', { tripId, file, date, codes: [...new Set([...have, code])] });
    say(r.ok ? '好，這天就這樣。要改回來按 ⌘Z' : (r.error ?? '失敗'), r.ok);
  };
  const today = now.toISOString().slice(0, 10);
  const list = useMemo(() => (trip ? deriveBookingTodos(trip, now) : { items: [], unknown: [] }), [trip, now]);
  const gaps = useMemo(() => (trip ? findMealGaps(trip).filter((g) => g.date >= today) : []), [trip, today]);
  const profile = useMemo(() => profileText(), []);
  const issues = useMemo(() => (trip ? readiness(trip, { now, profile }) : []), [trip, now, profile]);
  const summary = readinessSummary(issues);
  const stages = useMemo(() => (trip ? planStages(trip, { now, brief: entry.brief, profile }) : []), [trip, now, entry.brief, profile]);

  return (
    <div className="office">
      <header className="of-head">
        <button type="button" className="brand home-link" onClick={() => go(`/trip/${tripId}`)} aria-label="回到地圖與行程">
          ‹ 回到行程
        </button>
        <div className="of-title">
          <h1>訂票清單</h1>
          <span className="muted">{title}</span>
        </div>
        <div className="of-chips">
          <span className="of-chip" data-state={summary.warn > 0 ? 'warn' : 'ok'}>
            {summary.text}
          </span>
          <button
            type="button"
            className="btn"
            aria-pressed={tripOpen}
            onClick={() => {
              setTripOpen((o) => !o);
              if (!tripOpen && !roomForBoth()) setAgentOpen(false);
            }}
          >
            行程
          </button>
          <button type="button" className="btn" aria-pressed={agentOpen} onClick={() => (agentOpen ? setAgentOpen(false) : openAgent())}>
            AI 助手
          </button>
        </div>
      </header>

      <div className={`of-body${agentOpen || tripOpen ? '' : ' no-side'}${tripOpen ? (agentOpen ? ' both' : ' trip-only') : ''}`}>
        <main className="of-main">
          {trip && (
            <>
              <ReadinessCard issues={issues} summary={summary.text} stages={stages} onAsk={ask} onAccept={(date, code) => void accept(date, code)} />
              <BookingSection list={list} trip={trip} tripId={tripId} file={file} today={today} say={say} onAsk={ask} />
              <MealSection gaps={gaps} trip={trip} tripId={tripId} file={file} say={say} onAsk={ask} />
            </>
          )}
          <details className="of-adv-wrap" onToggle={(e) => setWatchOpen((e.currentTarget as HTMLDetailsElement).open)}>
            <summary>盯價與開賣提醒（選用）</summary>
            {watchOpen && <Watching entry={entry} say={say} />}
          </details>
        </main>

        {tripOpen && trip && <TripSide trip={trip} onClose={() => setTripOpen(false)} />}

        {agentOpen && (
          <aside className="of-side">
            <div className="of-prompts of-prompts-top">
              {BOOKING_PROMPTS.map((p) => (
                <button key={p.label} type="button" className="of-prompt" onClick={() => ask(p.text)}>
                  {p.label}
                </button>
              ))}
            </div>
            <div className="of-agent">
              <AgentPanel context={{ tripId, tripTitle: title }} contextLabel={`訂票 · ${title}`} onClose={() => setAgentOpen(false)} />
            </div>
          </aside>
        )}
      </div>

      {msg && (
        <div className="of-toast" role="status" data-ok={msg.ok}>
          {msg.text}
        </div>
      )}
    </div>
  );
}
