import { useState } from 'react';
import type { Trip } from '../../core/types.ts';
import { post, type Send } from '../api.ts';

interface Result {
  name: string;
  address?: string;
  loc?: { lat: number; lng: number };
  placeId?: string;
}

interface SearchResponse {
  ok: boolean;
  error?: string;
  source?: string;
  results?: Result[];
}

interface Props {
  trip: Trip;
  dayIdx: number | null;
  send: Send;
}

/** Center of everything already on the map, used to bias the search toward the trip's area. */
function near(trip: Trip): { lat: number; lng: number } | undefined {
  const pts = [...trip.days.flatMap((d) => d.items), ...trip.candidates].flatMap((x) => (x.loc ? [x.loc] : []));
  if (pts.length === 0) return undefined;
  return { lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length, lng: pts.reduce((s, p) => s + p.lng, 0) / pts.length };
}

export function AddPlace({ trip, dayIdx, send }: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Result[] | null>(null);
  const [source, setSource] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [day, setDay] = useState<number>(dayIdx !== null ? dayIdx + 1 : 0);

  const search = async () => {
    const text = q.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    const res = (await post('search', { q: text, lang: 'zh-TW', ...(near(trip) ? { near: near(trip) } : {}) })) as SearchResponse;
    setBusy(false);
    if (!res.ok) {
      setResults(null);
      setError(res.error ?? '搜尋失敗');
      return;
    }
    // Results without coordinates can't become map pins.
    setResults((res.results ?? []).filter((r) => r.loc));
    setSource(res.source ?? '');
  };

  const add = async (r: Result) => {
    if (!r.loc) return;
    const ok = await send(
      'add-candidate',
      { title: r.name, loc: r.loc, ...(r.placeId ? { placeId: r.placeId } : {}), ...(day > 0 ? { day } : {}) },
      day > 0 ? `已加入第 ${day} 天，請 Claude 排進行程` : '已加入候選景點',
    );
    if (ok) {
      setResults(null);
      setQ('');
      setOpen(false);
    }
  };

  if (!open) {
    return (
      <button type="button" className="add-place-btn" onClick={() => setOpen(true)}>
        ＋ 加入景點
      </button>
    );
  }

  return (
    <div className="add-place">
      <form
        className="add-place-row"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <label className="grow">
          <span className="sr-only">景點名稱</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜尋景點、餐廳、車站…" autoFocus />
        </label>
        <button type="submit" className="btn primary" disabled={!q.trim() || busy}>
          {busy ? '搜尋中…' : '搜尋'}
        </button>
        <button type="button" className="close-x" aria-label="關閉加入景點" onClick={() => setOpen(false)}>
          ×
        </button>
      </form>
      <label className="add-place-day">
        加入到
        <select value={day} onChange={(e) => setDay(Number(e.target.value))}>
          <option value={0}>候選景點（之後再決定）</option>
          {trip.days.map((d, i) => (
            <option key={d.date} value={i + 1}>
              第 {i + 1} 天{d.title ? ` · ${d.title}` : ''}
            </option>
          ))}
        </select>
      </label>
      {error && <p className="form-error">{error}</p>}
      {results && results.length === 0 && <p className="muted small">找不到結果，換個名稱或加上城市試試。</p>}
      {results && results.length > 0 && (
        <ul className="add-place-results">
          {results.map((r, i) => (
            <li key={`${r.name}-${i}`}>
              <button type="button" onClick={() => void add(r)}>
                <span className="r-name">{r.name}</span>
                {r.address && <span className="r-addr">{r.address}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {source && results && (
        <p className="muted small">資料來源：{source === 'openstreetmap-nominatim' ? '© OpenStreetMap 貢獻者' : source}</p>
      )}
    </div>
  );
}
