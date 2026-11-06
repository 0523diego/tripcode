import { useMemo, useRef, useState } from 'react';
import type { Trip } from '../../core/types.ts';
import { post } from '../api.ts';
import { removeCover, setCover } from '../cover.ts';
import { dayVar, lockedItems, parseInbox } from '../model.ts';
import { go } from '../route.ts';
import { STEP_TITLE } from '../../core/idea.ts';
import { createIdeaFile, useIdeaList } from '../idea/idea-store.ts';
import type { IdeaListEntry } from '../idea/idea-store.ts';
import { newIdeaId } from '../idea/idea-view.ts';
import type { TripEntry } from '../trips.ts';

function shortDate(date: string): string {
  const [, m, d] = date.split('-').map(Number);
  return m && d ? `${m}/${d}` : date;
}

/** Static route sketch for a trip card: each day's located stops, in order, in the day's color. */
function Sketch({ trip }: { trip: Trip }) {
  const W = 320;
  const H = 150;
  const days = trip.days.map((d) => d.items.filter((it) => it.kind !== 'transit' && it.loc).map((it) => it.loc!));
  const all = days.flat();
  if (all.length === 0) {
    return (
      <svg className="sketch" viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
        <text x={W / 2} y={H / 2} textAnchor="middle" className="sketch-empty">
          還沒有地點
        </text>
      </svg>
    );
  }
  const lats = all.map((p) => p.lat);
  const lngs = all.map((p) => p.lng);
  const [minLat, maxLat, minLng, maxLng] = [Math.min(...lats), Math.max(...lats), Math.min(...lngs), Math.max(...lngs)];
  const kx = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180);
  const s = Math.min((W - 40) / Math.max((maxLng - minLng) * kx, 0.01), (H - 36) / Math.max(maxLat - minLat, 0.01));
  const x = (lng: number) => W / 2 + (lng - (minLng + maxLng) / 2) * kx * s;
  const y = (lat: number) => H / 2 - (lat - (minLat + maxLat) / 2) * s;
  return (
    <svg className="sketch" viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      {days.map((pts, i) =>
        pts.length > 1 ? (
          <polyline
            key={i}
            points={pts.map((p) => `${x(p.lng)},${y(p.lat)}`).join(' ')}
            fill="none"
            stroke={`var(${dayVar(i)})`}
            strokeWidth={1.75}
            strokeLinejoin="round"
            opacity={0.85}
          />
        ) : null,
      )}
      {days.map((pts, i) =>
        pts.map((p, j) => <circle key={`${i}-${j}`} cx={x(p.lng)} cy={y(p.lat)} r={2.6} fill={`var(${dayVar(i)})`} />),
      )}
    </svg>
  );
}

/** The card's top: the user's photo when there is one, otherwise the route sketch. Pick, drop or remove a photo here. */
function CoverControls({ entry, onChanged }: { entry: TripEntry; onChanged: (msg: string, ok: boolean) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    const r = await setCover(entry.id, file);
    setBusy(false);
    onChanged(r.ok ? '封面換好了' : (r.error ?? '失敗'), r.ok);
  };
  const clear = async () => {
    setBusy(true);
    const r = await removeCover(entry.id);
    setBusy(false);
    onChanged(r.ok ? '封面移除了' : (r.error ?? '失敗'), r.ok);
  };
  return (
    <div className="cover-controls">
      <input ref={input} type="file" accept="image/*" hidden onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ''; }} />
      <button type="button" className="cover-btn" disabled={busy} onClick={() => input.current?.click()}>
        {busy ? '處理中…' : entry.cover ? '換封面' : '加封面照片'}
      </button>
      {entry.cover && (
        <button type="button" className="cover-btn" disabled={busy} onClick={() => void clear()} aria-label="移除封面">
          移除
        </button>
      )}
    </div>
  );
}

function TripCard({ entry, bust, onCover }: { entry: TripEntry; bust: number; onCover: (msg: string, ok: boolean) => void }) {
  const trip = entry.files[0]!.trip;
  const locked = lockedItems(trip).length;
  const pending = entry.inbox.map(parseInbox).filter((n) => n.status === 'pending').length;
  const open = trip.candidates.filter((c) => c.status === 'unconfirmed' || c.status === 'discuss').length;
  const { adults, childrenAges } = trip.party;
  const [over, setOver] = useState(false);
  const [busyDrop, setBusyDrop] = useState(false);
  const drop = async (e: React.DragEvent) => {
    e.preventDefault();
    setOver(false);
    const file = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/'));
    if (!file) return onCover('請拖一張圖片進來', false);
    setBusyDrop(true);
    const r = await setCover(entry.id, file);
    setBusyDrop(false);
    onCover(r.ok ? '封面換好了' : (r.error ?? '失敗'), r.ok);
  };
  return (
    <li
      className={`trip-card-wrap${over ? ' drop' : ''}${busyDrop ? ' busy' : ''}`}
      onDragOver={(e) => {
        if ([...e.dataTransfer.types].includes('Files')) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => void drop(e)}
    >
      <CoverControls entry={entry} onChanged={onCover} />
      <a className="trip-card card" href={`#/trip/${entry.id}`}>
        {entry.cover ? <img className="cover-img" src={`${entry.cover}${entry.cover.includes('?') ? '&' : '?'}v=${bust}`} alt="" draggable={false} /> : <Sketch trip={trip} />}
        <div className="trip-card-body">
          <h2>{trip.title}</h2>
          <p className="muted">
            {shortDate(trip.start)} – {shortDate(trip.end)} · {trip.days.length} 天 · {adults} 位大人
            {childrenAges.length ? ` · ${childrenAges.length} 位小孩` : ''}
          </p>
          <p className="trip-card-stats">
            <span>已確定 {locked}</span>
            <span>候選 {open}</span>
            {pending > 0 && <span className="hot">待解析匯入 {pending}</span>}
            {entry.files.length > 1 && <span>{entry.files.length} 個方案</span>}
          </p>
        </div>
      </a>
    </li>
  );
}

const ZONES: [string, string][] = [
  ['Asia/Tokyo', '日本'],
  ['Asia/Seoul', '韓國'],
  ['Asia/Taipei', '台灣'],
  ['Asia/Bangkok', '泰國'],
  ['Asia/Singapore', '新加坡'],
  ['Europe/Zurich', '瑞士'],
  ['Europe/Paris', '法國'],
  ['Europe/London', '英國'],
  ['Europe/Rome', '義大利'],
  ['Europe/Madrid', '西班牙'],
  ['America/New_York', '美東'],
  ['America/Los_Angeles', '美西'],
  ['Australia/Sydney', '澳洲東岸'],
];

function slugify(title: string): string {
  const ascii = title
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return ascii;
}

function NewTripForm({ onCancel }: { onCancel: () => void }) {
  const [title, setTitle] = useState('');
  const [id, setId] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [tz, setTz] = useState('Asia/Tokyo');
  const [adults, setAdults] = useState(2);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const autoId = slugify(title) || (start ? `trip-${start}` : '');
  const tripId = id || autoId;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return setError('請輸入旅程名稱');
    if (!/^[a-z0-9-]+$/.test(tripId)) return setError('資料夾名稱只能用小寫英文、數字和連字號');
    if (!start || !end || end < start) return setError('請確認出發與回程日期');
    setBusy(true);
    setError(null);
    const res = await post('new-trip', { tripId, title: title.trim(), start, end, tz, adults, childrenAges: [] });
    setBusy(false);
    if (!res.ok) return setError(res.error ?? '建立失敗');
    go(`/trip/${tripId}`);
  };

  return (
    <form className="new-trip card" onSubmit={(e) => void submit(e)}>
      <h2>新增旅程</h2>
      <label className="wide">
        旅程名稱
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：京都賞楓 5 天" autoFocus />
      </label>
      <label>
        出發
        <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
      </label>
      <label>
        回程
        <input type="date" value={end} min={start || undefined} onChange={(e) => setEnd(e.target.value)} />
      </label>
      <label>
        目的地時區
        <select value={tz} onChange={(e) => setTz(e.target.value)}>
          {ZONES.map(([z, name]) => (
            <option key={z} value={z}>
              {name}（{z}）
            </option>
          ))}
        </select>
      </label>
      <label>
        大人
        <input type="number" min={1} max={20} value={adults} onChange={(e) => setAdults(Number(e.target.value) || 1)} />
      </label>
      <label className="wide">
        資料夾名稱（英文）
        <input value={id} onChange={(e) => setId(e.target.value.toLowerCase())} placeholder={autoId || 'kyoto-2027-11'} />
      </label>
      {error && (
        <p className="form-error wide" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions wide">
        <button type="button" className="btn" onClick={onCancel}>
          取消
        </button>
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? '建立中…' : '建立旅程'}
        </button>
      </div>
      <p className="muted wide small">也可以直接跟 Claude Code 說「我想去京都 5 天」，它會帶你完成 onboarding。</p>
    </form>
  );
}

/** An idea in progress (no trip yet): a dark, space-style card that opens the idea page. */
function IdeaCard({ entry }: { entry: IdeaListEntry }) {
  const chips = entry.summary.slice(0, 6);
  return (
    <li className="trip-card-wrap">
      <a className="trip-card idea-home-card" href={`#/idea/${entry.id}`}>
        <div className="idea-home-card__body">
          <span className="idea-home-card__badge">構想中</span>
          <h2>新的旅程</h2>
          <p className="idea-home-card__next">下一步：{STEP_TITLE[entry.next]}</p>
          {chips.length > 0 ? (
            <ul className="idea-home-card__chips">
              {chips.map((c) => (
                <li key={c}>{c}</li>
              ))}
              {entry.summary.length > chips.length && <li>…</li>}
            </ul>
          ) : (
            <p className="idea-home-card__next">還沒回答任何問題</p>
          )}
        </div>
      </a>
    </li>
  );
}

export function Home({ trips }: { trips: TripEntry[] }) {
  const [creating, setCreating] = useState(false);
  // A replaced photo keeps its file name, so the page asks for it again with a new number after each change.
  const [bust, setBust] = useState(() => Date.now());
  const [toast, setToast] = useState<{ text: string; ok: boolean } | null>(null);
  const onCover = (text: string, ok: boolean) => {
    if (ok) setBust(Date.now());
    setToast({ text, ok });
    setTimeout(() => setToast(null), ok ? 3000 : 7000);
  };
  const ideas = useIdeaList();
  // Starting an idea needs the dev server (it writes trips/<id>/idea.json); a static build keeps the plain form.
  const canIdea = import.meta.env.DEV;
  const [starting, setStarting] = useState(false);
  const startIdea = async () => {
    if (!canIdea) return setCreating(true);
    setStarting(true);
    const id = newIdeaId(new Date());
    const r = await createIdeaFile(id);
    setStarting(false);
    if (!r.ok) return onCover(r.error ?? '無法開始', false);
    go(`/idea/${id}`);
  };
  const sorted = useMemo(
    () =>
      trips
        .filter((t) => !t.fixture && t.files.length > 0)
        .sort((a, b) => a.files[0]!.trip.start.localeCompare(b.files[0]!.trip.start)),
    [trips],
  );
  return (
    <main className="home">
      <header className="home-head">
        <span className="brand">TripCode</span>
        <div className="home-actions">
          {canIdea && (
            <button type="button" className="btn" onClick={() => setCreating(true)}>
              已經決定去哪和日期
            </button>
          )}
          <button type="button" className="btn primary" disabled={starting} onClick={() => void startIdea()}>
            ＋ 新增旅程
          </button>
        </div>
      </header>
      <h1 className="home-title">你的旅程</h1>
      <p className="muted home-sub">每趟旅程都是 trips/ 裡的一個資料夾，由你和 Claude Code 一起編輯。</p>
      {creating && <NewTripForm onCancel={() => setCreating(false)} />}
      {sorted.length === 0 && ideas.length === 0 && !creating ? (
        <div className="home-empty card">
          <p>還沒有任何旅程。</p>
          <button type="button" className="btn primary" disabled={starting} onClick={() => void startIdea()}>
            建立第一趟旅程
          </button>
        </div>
      ) : (
        <ul className="trip-grid">
          {ideas.map((i) => (
            <IdeaCard key={i.id} entry={i} />
          ))}
          {sorted.map((t) => (
            <TripCard key={t.id} entry={t} bust={bust} onCover={onCover} />
          ))}
        </ul>
      )}
      {toast && (
        <div className="cover-toast" role="status" data-ok={toast.ok}>
          {toast.text}
        </div>
      )}
    </main>
  );
}
