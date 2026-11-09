// The restaurants the AI just looked at, shown on the left of the screen while the conversation is on the right: each place as a
// card with its own photo and what it is like. It reads trips/<id>/food.json (written by `tripcode food near --save`, `food profile`
// and `food photo`), so a card appears when the AI searches and fills in as it reads about the place: nobody has to wait for the
// chat reply to see what the places look like.
import { useEffect, useState } from 'react';
import type { FoodFile } from '../../core/food-types.ts';
import { PlaceCard } from './PlaceCard.tsx';
import { boardResults } from './food-view.ts';
import { useFood } from './useFood.ts';

const weekday = ['日', '一', '二', '三', '四', '五', '六'];
const dateText = (date: string) => {
  const d = new Date(`${date}T00:00:00Z`);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}（${weekday[d.getUTCDay()]}）`;
};
const agoText = (iso: string, now: number) => {
  const min = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  return min < 1 ? '剛剛' : min < 60 ? `${min} 分鐘前` : min < 1440 ? `${Math.round(min / 60)} 小時前` : `${Math.round(min / 1440)} 天前`;
};

export function FoodBoard({ tripId, canUseFor, onUseFor }: { tripId: string; /** Is there a meal still to decide for this date and slot? */ canUseFor: (date: string, slot: 'lunch' | 'dinner') => boolean; onUseFor: (date: string, slot: 'lunch' | 'dinner') => void }) {
  const { food } = useFood(tripId);
  const [shown, setShown] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const batches = (food as FoodFile | null)?.shortlist ?? [];
  if (!food || batches.length === 0) return null;
  const batch = batches.find((b) => b.at === shown) ?? batches[batches.length - 1]!;
  const cards = boardResults(food, batch, tripId);
  const slot = batch.slot === 'lunch' ? '午餐' : '晚餐';
  const withIntro = cards.filter((c) => c.profile).length;
  return (
    <section className="of-section fd-board" aria-label="餐廳推薦">
      <header className="of-section-head">
        <h2>餐廳推薦</h2>
        <span className="muted">
          {dateText(batch.date)}
          {slot} · 「{batch.anchor}」附近 · {agoText(batch.at, now)}找的
        </span>
        <button type="button" className="link fd-board-fold" onClick={() => setCollapsed((c) => !c)}>
          {collapsed ? '展開' : '收起'}
        </button>
      </header>
      {!collapsed && (
        <>
          {batches.length > 1 && (
            <div className="fd-board-tabs" role="tablist">
              {[...batches].reverse().map((b) => (
                <button key={b.at} type="button" role="tab" aria-selected={b.at === batch.at} className={b.at === batch.at ? 'on' : undefined} onClick={() => setShown(b.at)}>
                  {dateText(b.date)}
                  {b.slot === 'lunch' ? '午餐' : '晚餐'}
                </button>
              ))}
            </div>
          )}
          <p className="muted fd-board-note">
            在 AI 助手問餐廳，找到的店會出現在這裡。{withIntro > 0 ? `有介紹的 ${withIntro} 家，是 AI 讀過網路上的網頁（每家附網址）。` : '還沒有 AI 讀過網頁的介紹；請 AI「幫我查前三家」。'}照片是店家自己網頁的圖。地圖沒有評分，每家附 Google 地圖連結。
          </p>
          <ol className="fd-places fd-board-grid">
            {cards.map((r, i) => (
              <PlaceCard key={r.key} r={r} rank={i + 1} generalMode={false} skipDishBadge>
                <div className="fd-place-foot">
                  {canUseFor(batch.date, batch.slot) && (
                    <button type="button" className="btn primary" onClick={() => onUseFor(batch.date, batch.slot)}>
                      選這餐 →
                    </button>
                  )}
                  <a href={r.mapsUrl} target="_blank" rel="noopener noreferrer">
                    Google 地圖看評分 ↗
                  </a>
                  {r.website && /^https?:\/\//i.test(r.website) && (
                    <a href={r.website} target="_blank" rel="noopener noreferrer">
                      官網 ↗
                    </a>
                  )}
                </div>
              </PlaceCard>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
