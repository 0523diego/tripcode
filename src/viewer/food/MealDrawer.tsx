// 這餐吃什麼: opened from a meal that has no place yet. Decide what to eat first (the city's local dishes, with where each came
// from), then see real places nearby that fit it, each with the proof that it exists and is open then, and adopt one into the
// itinerary in one click. The drawer never shows a rating (a map has none): every place links to Google Maps for that.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NearOutput } from '../../../cli/food-service.ts';
import { dishSearchUrl, visibleDishes } from '../../core/food.ts';
import type { MealGap } from '../../core/meals.ts';
import { restaurantsNearUrl } from '../../core/meals.ts';
import type { Trip } from '../../core/types.ts';
import { post } from '../api.ts';
import type { ApiResult } from '../api.ts';
import { anchorChoices, insertionPoint, shortDate, weekdayZh } from '../office/booking-model.ts';
import { AVOID_CHIPS, dishBadge, guessWikivoyagePage, photoFromFood, reasonText, tagLabels } from './food-view.ts';
import type { NearResult } from './food-view.ts';
import { PlaceCard } from './PlaceCard.tsx';
import { useFood } from './useFood.ts';

type Near = { state: 'idle' } | { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; out: NearOutput };
type NearReply = ApiResult & Partial<NearOutput>;

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
  const [near, setNear] = useState<Near>({ state: 'idle' });
  const [page, setPage] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [allDishes, setAllDishes] = useState(false);
  const day = trip.days.find((d) => d.date === gap.date);
  const cities = useMemo(() => [...new Set((food?.dishes ?? []).map((d) => d.city))], [food]);
  const city = day?.city ?? (cities.length === 1 ? cities[0] : undefined);
  const view = useMemo(() => (food && city ? visibleDishes(food, city, gap.slot) : { shown: [], hidden: [] }), [food, city, gap.slot]);
  const wanted = view.shown.filter((d) => food?.votes[d.id] === 'want').map((d) => d.id);
  const picked = choices.find((c) => c.key === anchor) ?? choices[0];
  const slotLabel = gap.slot === 'lunch' ? '午餐' : '晚餐';

  useEffect(() => {
    if (!page && city) setPage(guessWikivoyagePage(city));
  }, [city, page]);

  const seq = useRef(0);
  const find = useCallback(async () => {
    if (!picked) return;
    const mine = ++seq.current;
    setNear({ state: 'loading' });
    const r = (await post('food', { tripId, op: 'near', file, date: gap.date, slot: gap.slot, anchor, ...(wanted.length > 0 ? { dishes: wanted } : {}) })) as NearReply;
    if (mine !== seq.current) return; // a newer search replaced this one
    if (r.ok && r.results) setNear({ state: 'ready', out: r as NearOutput });
    else setNear({ state: 'error', message: r.error ?? '查不到' });
  }, [tripId, gap.date, gap.slot, anchor, picked, wanted.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  // First look when the guide has loaded, and again whenever the starting point changes. A vote does not search by itself
  // (each search is a request to a shared public server): the button does.
  const firstFor = useRef('');
  useEffect(() => {
    if (status !== 'ready') return;
    const key = `${gap.date}-${gap.slot}-${anchor}`;
    if (firstFor.current === key) return;
    firstFor.current = key;
    void find();
  }, [status, gap.date, gap.slot, anchor, find]);

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
  const adopt = async (r: NearResult) => {
    setBusy(r.key);
    const res = await post('meal', {
      tripId,
      file,
      date: gap.date,
      slot: gap.slot,
      place: { key: r.key, name: r.name, loc: r.loc, dishes: r.matches.map((m) => m.dishId), evidence: r.evidence },
      ...(gap.existingItemId ? { existingItemId: gap.existingItemId } : { beforeItemId: insertionPoint(day, gap, anchor) }),
    });
    setBusy(null);
    say(res.ok ? `「${r.name}」加進行程了。要改回去按 ⌘Z` : (res.error ?? '失敗'), res.ok);
    if (res.ok) onClose();
  };
  const reject = async (r: NearResult) => {
    const res = await run({ op: 'reject', key: r.key, reason: 'meh' });
    if (res.ok && near.state === 'ready') setNear({ state: 'ready', out: { ...near.out, results: near.out.results.filter((x) => x.key !== r.key) } });
  };

  // A photo or介紹 the AI or the background fetch added after this search started: take it from the guide.
  const withPhoto = (r: NearResult): NearResult => photoFromFood(r, food, tripId);

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
          <p className="fd-note warn">前後的地點和住宿都沒有座標，先替它們補上座標才找得到附近的店。</p>
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
            想吃什麼
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
          {status === 'ready' && view.shown.length === 0 && (
            <div className="fd-empty">
              <p>{city ? `還沒有「${city}」的在地菜。` : '這一天沒有標城市，所以不知道要列哪座城市的菜。'}先決定吃什麼，找店才有方向。</p>
              {city && (
                <div className="fd-guide">
                  <label>
                    英文 Wikivoyage 頁面名稱
                    <input type="text" value={page} placeholder="例如 Rome" onChange={(e) => setPage(e.target.value)} />
                  </label>
                  <button type="button" className="btn primary" onClick={() => void readGuide()} disabled={busy === 'guide' || !page.trim()}>
                    {busy === 'guide' ? '讀取中…' : '從 Wikivoyage 讀這座城市的必吃'}
                  </button>
                  <button type="button" className="btn" onClick={() => onAsk(`照 fill-meals 技能，先決定「${city}」要吃什麼：先跑 food show 看已有的菜，沒有就用 food guide 讀 Wikivoyage 的 Eat 段，再補中文名、一句理由和標籤；你自己想到的菜要標成 AI 的印象（kind: ai），不要寫成有來源。`)}>
                    請 AI 列出
                  </button>
                </div>
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

        <section className="fd-sec" aria-label="附近的店">
          <h3>
            附近的店
            <button type="button" className="fd-refind" onClick={() => void find()} disabled={near.state === 'loading' || !picked}>
              {near.state === 'loading' ? '查詢中…' : wanted.length > 0 ? '照「想吃」重新找' : '重新找'}
            </button>
          </h3>
          {near.state === 'loading' && <p className="muted" role="status">正在查 OpenStreetMap 上「{picked?.title}」附近的店…</p>}
          {near.state === 'error' && (
            <div className="fd-note warn" role="alert">
              <p>{near.message}</p>
              <p>
                先用 Google 地圖找也可以：
                <a href={noMapsFallback} target="_blank" rel="noopener noreferrer">
                  在地圖搜尋{view.shown[0] ? `「${view.shown[0].nameLocal}」` : '附近的餐廳'} ↗
                </a>
              </p>
            </div>
          )}
          {near.state === 'ready' && (
            <>
              {near.out.results.length > 0 && !near.out.results.some((r) => r.evidence.some((e) => (e as { kind?: string }).kind === 'guide-wikivoyage')) && (
                <p className="fd-note">想分辨哪幾家是被旅遊指南推薦的、不是隨便一家？在上面讀 Wikivoyage 時填這一區的分區頁（例如 Rome/Colosseo、Osaka/Minami），會一起讀到編輯推薦的店，附近有的就會排前面並標出來。</p>
              )}
              {near.out.generalMode && <p className="fd-note warn">沒有任何一家店的店名或菜系對得上這幾道菜（在義大利很常見：店名不會寫菜名）。下面是這個時間有營業、走得到的店；有沒有這道菜，請到 Google 地圖看菜單和評論。</p>}
              {near.out.results.length === 0 ? (
                <div className="fd-note">
                  <p>走路 {near.out.maxWalkMin} 分鐘內沒有符合的店（略過：{near.out.dropped.closed} 家那時沒開、{near.out.dropped.far} 家太遠、{near.out.dropped.noMatch} 家對不上菜）。</p>
                  <p>
                    <a href={noMapsFallback} target="_blank" rel="noopener noreferrer">
                      在 Google 地圖搜尋 ↗
                    </a>
                  </p>
                </div>
              ) : (
                <ol className="fd-places">
                  {near.out.results.map((r, i) => (
                    <PlaceCard key={r.key} r={withPhoto(r)} rank={i + 1} generalMode={near.out.generalMode} dishNames={r.matches.length > 0 && food ? r.matches.map((m) => food.dishes.find((d) => d.id === m.dishId)?.nameZh).filter(Boolean).join('、') : ''}>
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
                        <button type="button" className="fd-reject" onClick={() => void reject(r)}>
                          不要這家
                        </button>
                      </div>
                    </PlaceCard>
                  ))}
                </ol>
              )}
              <p className="muted fd-credit">
                地圖資料只能確認店存在、營業時間（有寫的話）和菜系，沒有評分和評論數。{near.out.attribution}；菜名：Wikivoyage 指南 (CC BY-SA)。
              </p>
            </>
          )}
        </section>
      </div>
    </aside>
  );
}
