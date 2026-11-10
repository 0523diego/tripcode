// 這餐吃什麼: opened from a meal that has no place yet. Decide what to eat first (the city's local dishes, with where each came
// from; or 「都可以」), then ask the AI to look the places up on the web. It hands its answer back through `food suggest` (a fixed
// shape, checked: each place has the pages it came from and a spot on the map), the cards appear here as they arrive, and one
// click adopts a place into the itinerary. The drawer never shows a rating: every place links to Google Maps for that.
import { useEffect, useMemo, useRef, useState } from 'react';
import { dishSearchUrl, visibleDishes } from '../../core/food.ts';
import type { MealGap } from '../../core/meals.ts';
import { restaurantsNearUrl } from '../../core/meals.ts';
import type { Trip } from '../../core/types.ts';
import { post } from '../api.ts';
import { anchorChoices, insertionPoint, shortDate, weekdayZh } from '../office/booking-model.ts';
import { AVOID_CHIPS, askPrompt, boardResults, listDishesPrompt, dishBadge, guessWikivoyagePage, reasonText, tagLabels } from './food-view.ts';
import { PlaceCard } from './PlaceCard.tsx';
import { useFood } from './useFood.ts';

/** How long the drawer keeps saying 「AI 正在查」 before it suggests looking at the AI panel instead. */
const WAIT_MS = 6 * 60_000;

export interface MealDrawerProps {
  gap: MealGap;
  trip: Trip;
  tripId: string;
  file: string;
  say: (message: string, ok?: boolean) => void;
  onClose: () => void;
  onAsk: (text: string) => void;
}

export function MealDrawer({ gap, trip, tripId, file, say, onClose, onAsk }: MealDrawerProps) {
  const { food, status, run } = useFood(tripId);
  const choices = anchorChoices(gap);
  const [anchor, setAnchor] = useState<MealGap['defaultAnchor']>(gap.defaultAnchor);
  const [page, setPage] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [allDishes, setAllDishes] = useState(false);
  const [typedCity, setTypedCity] = useState('');
  const [askedAt, setAskedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const day = trip.days.find((d) => d.date === gap.date);
  const cities = useMemo(() => [...new Set((food?.dishes ?? []).map((d) => d.city))], [food]);
  const city = day?.city ?? (cities.length === 1 ? cities[0] : undefined) ?? (typedCity.trim() || undefined);
  const view = useMemo(() => (food && city ? visibleDishes(food, city, gap.slot) : { shown: [], hidden: [] }), [food, city, gap.slot]);
  const wanted = view.shown.filter((d) => food?.votes[d.id] === 'want');
  const picked = choices.find((c) => c.key === anchor) ?? choices[0];
  const slotLabel = gap.slot === 'lunch' ? '午餐' : '晚餐';

  useEffect(() => {
    if (!page && city) setPage(guessWikivoyagePage(city));
  }, [city, page]);

  // The city's dishes are read once, by themselves, when the drawer opens on a city that has none yet (a small request to Wikivoyage).
  const autoRead = useRef('');
  useEffect(() => {
    if (status !== 'ready' || !city || view.shown.length > 0 || view.hidden.length > 0 || !page.trim() || autoRead.current === city) return;
    autoRead.current = city;
    setBusy('guide');
    void run({ op: 'guide', city, page: page.trim() }).finally(() => setBusy(null));
  }, [status, city, page, view.shown.length, view.hidden.length, run]);

  // The newest answer the AI handed back for this very meal.
  const batch = useMemo(() => [...(food?.shortlist ?? [])].reverse().find((b) => b.date === gap.date && b.slot === gap.slot), [food, gap.date, gap.slot]);
  const cards = useMemo(() => (food && batch ? boardResults(food, batch, tripId) : []), [food, batch, tripId]);
  const arrived = askedAt !== null && batch !== undefined && Date.parse(batch.at) >= askedAt - 1000;
  const waiting = askedAt !== null && !arrived && now - askedAt < WAIT_MS;
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, [waiting]);

  const askAi = (dishes: typeof wanted) => {
    if (!picked) return;
    setAskedAt(Date.now());
    setNow(Date.now());
    onAsk(askPrompt({ tripId, date: gap.date, slot: gap.slot, window: gap.window, anchorKey: anchor, anchorTitle: picked.title, city, wanted: dishes.map((d) => ({ id: d.id, nameZh: d.nameZh, nameLocal: d.nameLocal })), avoid: (food?.taste.avoidTags ?? []).map((t) => AVOID_CHIPS.find((c) => c.tag === t)?.label ?? t) }));
  };

  const vote = (dishId: string, v: 'want' | 'no' | 'clear') => void run({ op: 'vote', dishId, vote: v });
  const toggleAvoid = (tag: string) => {
    const now = food?.taste.avoidTags ?? [];
    void run({ op: 'taste', patch: { avoidTags: now.includes(tag) ? now.filter((t) => t !== tag) : [...now, tag] } });
  };
  const readGuide = async () => {
    if (!city || !page.trim()) return;
    setBusy('guide');
    const r = await run({ op: 'guide', city, page: page.trim() });
    setBusy(null);
    say(r.ok ? `讀到 ${(r as unknown as { found?: number }).found ?? 0} 道${city}的在地菜` : (r.error ?? '讀不到'), r.ok);
  };
  const adopt = async (r: (typeof cards)[number]) => {
    setBusy(r.key);
    const known = food?.places.find((p) => p.key === r.key);
    const res = await post('meal', {
      tripId,
      file,
      date: gap.date,
      slot: gap.slot,
      place: { key: r.key, name: r.name, loc: r.loc, dishes: known?.dishes ?? [], evidence: r.evidence },
      ...(gap.existingItemId ? { existingItemId: gap.existingItemId } : { beforeItemId: insertionPoint(day, gap, anchor) }),
    });
    setBusy(null);
    say(res.ok ? `「${r.name}」加進行程了。要改回去按 ⌘Z` : (res.error ?? '失敗'), res.ok);
    if (res.ok) onClose();
  };
  const reject = (r: (typeof cards)[number]) => void run({ op: 'reject', key: r.key, reason: 'meh' });

  const shown = allDishes ? view.shown : view.shown.slice(0, 6);
  const noMapsFallback = view.shown[0] && picked ? dishSearchUrl(view.shown[0], picked.title) : restaurantsNearUrl(picked?.title ?? '', city);

  return (
    <aside className="fd" role="dialog" aria-label={`${slotLabel}吃什麼`}>
      <header className="fd-head">
        <div>
          <h2>
            {shortDate(gap.date)} {weekdayZh(gap.date)} · {slotLabel}吃什麼
          </h2>
          <p className="muted">
            {gap.window.from}–{gap.window.to}
            {gap.kind === 'undecided' ? ' · 會填進原本「待選」的那一餐' : ''}
          </p>
        </div>
        <button type="button" className="fd-x" onClick={onClose} aria-label="關閉">
          ×
        </button>
      </header>

      <div className="fd-body">
        {choices.length === 0 ? (
          <p className="fd-note warn">前後的地點和住宿都沒有座標，先替它們補上座標，AI 才知道要在哪一帶找。</p>
        ) : (
          <label className="fd-anchor">
            <span className="muted">在哪一帶吃</span>
            <select value={anchor} onChange={(e) => setAnchor(e.target.value as MealGap['defaultAnchor'])}>
              {choices.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
        )}

        <section className="fd-sec" aria-label="想吃什麼">
          <h3>
            1. 想吃什麼
            {city && <span className="muted"> · {city}</span>}
          </h3>
          <div className="fd-chips" role="group" aria-label="不吃的東西">
            <span className="muted">不吃：</span>
            {AVOID_CHIPS.map((c) => {
              const on = food?.taste.avoidTags.includes(c.tag) ?? false;
              return (
                <button key={c.tag} type="button" className={on ? 'on' : undefined} aria-pressed={on} onClick={() => toggleAvoid(c.tag)} disabled={status !== 'ready'}>
                  {c.label}
                </button>
              );
            })}
          </div>
          {status === 'loading' && <p className="muted">讀取中…</p>}
          {status === 'ready' && !city && (
            <div className="fd-empty">
              <p>這一天沒有標城市，不知道要列哪座城市的菜。告訴我城市：</p>
              <div className="fd-guide">
                <label>
                  城市
                  <input type="text" value={typedCity} placeholder="例如 米蘭" onChange={(e) => { setTypedCity(e.target.value); setPage(''); }} />
                </label>
              </div>
            </div>
          )}
          {status === 'ready' && city && view.shown.length === 0 && (
            <div className="fd-empty">
              {busy === 'guide' ? (
                <p className="muted" role="status">正在讀 Wikivoyage 上「{city}」的必吃…</p>
              ) : (
                <>
                  <p>
                    {autoRead.current === city ? `Wikivoyage 沒有列出「${city}」像樣的必吃菜（很多城市的頁面只寫散文）。` : `還沒有「${city}」的在地菜。`}
                    請 AI 上網查、列出必吃，每道附它讀過的網頁：
                  </p>
                  <div className="fd-guide">
                    <button type="button" className="btn primary" onClick={() => onAsk(listDishesPrompt(tripId, city))}>
                      請 AI 列出「{city}」必吃
                    </button>
                  </div>
                  <details className="fd-details">
                    <summary>改從 Wikivoyage 讀（要給英文頁面名稱）</summary>
                    <div className="fd-guide">
                      <label>
                        英文 Wikivoyage 頁面名稱
                        <input type="text" value={page} placeholder="例如 Milan" onChange={(e) => setPage(e.target.value)} />
                      </label>
                      <button type="button" className="btn" onClick={() => void readGuide()} disabled={!page.trim()}>
                        讀這個頁面
                      </button>
                    </div>
                  </details>
                </>
              )}
            </div>
          )}
          {shown.length > 0 && (
            <ul className="fd-dishes">
              {shown.map((d) => {
                const b = dishBadge(d);
                const v = food?.votes[d.id];
                return (
                  <li key={d.id} data-vote={v}>
                    <div className="fd-dish-top">
                      <b>{d.nameZh}</b>
                      {d.nameLocal !== d.nameZh && <small>{d.nameLocal}</small>}
                    </div>
                    {reasonText(d) ? <p>{reasonText(d)}</p> : tagLabels(d).length > 0 && <p className="fd-tags">{tagLabels(d).join(' · ')}</p>}
                    <div className="fd-dish-foot">
                      <span className={`fd-badge ${b.tone}`}>{b.text}</span>
                      <span className="fd-votes">
                        <button type="button" className={v === 'want' ? 'on' : undefined} aria-pressed={v === 'want'} onClick={() => vote(d.id, v === 'want' ? 'clear' : 'want')}>
                          想吃
                        </button>
                        <button type="button" onClick={() => vote(d.id, 'no')}>
                          不要
                        </button>
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {view.shown.length > 6 && (
            <button type="button" className="fd-more" onClick={() => setAllDishes((a) => !a)}>
              {allDishes ? '收起' : `看全部 ${view.shown.length} 道`}
            </button>
          )}
          {view.hidden.length > 0 && <p className="muted fd-hiddennote">另有 {view.hidden.length} 道因為你的口味或選擇被藏起來（{view.hidden.slice(0, 3).map((h) => `${h.dish.nameZh}：${h.why}`).join('；')}{view.hidden.length > 3 ? '…' : ''}）。</p>}
        </section>

        <section className="fd-sec" aria-label="請 AI 找店">
          <h3>2. 請 AI 上網找店</h3>
          <div className="fd-ask">
            <button type="button" className="btn primary" onClick={() => askAi(wanted)} disabled={!picked || waiting || wanted.length === 0}>
              照我想吃的找{wanted.length > 0 ? `（${wanted.length} 道）` : ''}
            </button>
            <button type="button" className="btn" onClick={() => askAi([])} disabled={!picked || waiting}>
              都可以，讓 AI 挑
            </button>
          </div>
          <p className="muted fd-note-small">AI 會上網讀幾個網頁再挑最多 3 家，通常要 1–2 分鐘；結果會直接出現在下面。沒有評分，要看評分到 Google 地圖。</p>
          {waiting && (
            <p className="fd-note" role="status">
              AI 正在上網查…（它的進度在 AI 助手那邊看得到）
            </p>
          )}
          {askedAt !== null && !arrived && !waiting && (
            <p className="fd-note warn" role="alert">
              還沒收到 AI 的結果。到 AI 助手看它說了什麼（可能在等你按「允許」），或再按一次。也可以先到 Google 地圖找：
              <a href={noMapsFallback} target="_blank" rel="noopener noreferrer">
                {' '}在地圖搜尋 ↗
              </a>
            </p>
          )}
          {cards.length > 0 && (
            <>
              <p className="muted fd-note-small">
                {arrived ? '剛剛 AI 找的：' : batch ? `上次找的（${batch.at.slice(5, 10).replace('-', '/')}）：` : ''}
                每一家都附它讀過的網頁，座標是用地名查到的；營業時間以網頁為準，出發前到 Google 地圖確認。
              </p>
              <ol className="fd-places">
                {cards.map((r, i) => (
                  <PlaceCard key={r.key} r={r} rank={i + 1} generalMode={false} skipDishBadge dishNames="">
                    <div className="fd-place-foot">
                      <button type="button" className="btn primary" onClick={() => void adopt(r)} disabled={busy !== null}>
                        {busy === r.key ? '加入中…' : gap.existingItemId ? '填進這餐' : '加入這餐'}
                      </button>
                      <a href={r.mapsUrl} target="_blank" rel="noopener noreferrer">
                        Google 地圖看評分 ↗
                      </a>
                      {r.website && /^https?:\/\//i.test(r.website) && (
                        <a href={r.website} target="_blank" rel="noopener noreferrer">
                          官網 ↗
                        </a>
                      )}
                      <button type="button" className="fd-reject" onClick={() => reject(r)}>
                        不要這家
                      </button>
                    </div>
                  </PlaceCard>
                ))}
              </ol>
            </>
          )}
          {cards.length === 0 && askedAt === null && (
            <p className="muted fd-note-small">
              想自己找也可以：
              <a href={noMapsFallback} target="_blank" rel="noopener noreferrer">
                在 Google 地圖搜尋 ↗
              </a>
              ，挑好後用左邊的「貼上選好的店」。
            </p>
          )}
          <p className="muted fd-credit">菜名：Wikivoyage 指南 (CC BY-SA)；店的介紹是 AI 讀過網頁後用自己的話寫的，每家附來源；座標：© OpenStreetMap 貢獻者。</p>
        </section>
      </div>
    </aside>
  );
}
