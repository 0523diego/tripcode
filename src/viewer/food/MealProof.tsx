// In the detail panel of a meal that was chosen from the drawer: what is known about the place, each fact with where and when it was
// seen, and the one thing a map cannot say (a rating), with the link to look it up.
import type { Item } from '../../core/types.ts';
import { go } from '../route.ts';
import { proofLines } from './food-view.ts';

export function MealProof({ tripId, item }: { tripId: string; item: Item }) {
  if (item.kind !== 'meal') return null;
  const lines = proofLines(item.checks);
  if (lines.length === 0 && !item.placeId) {
    // No place chosen yet: the 這餐吃什麼 drawer lives on the 訂票清單 page, next to the other meals that have no place.
    if (item.loc) return null;
    return (
      <div className="detail-section">
        <p className="detail-kicker">還沒決定去哪吃</p>
        <button type="button" className="btn primary" onClick={() => go(`/trip/${tripId}/office`)}>
          找吃的 →
        </button>
        <p className="muted proof-note">先選想吃的在地菜，再看附近真的存在、那個時段有開的店。</p>
      </div>
    );
  }
  const maps = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(item.title)}`;
  return (
    <div className="detail-section">
      <p className="detail-kicker">這家店查證過的</p>
      <ul className="proof">
        {lines.map((l) => (
          <li key={l.text}>{l.href ? <a href={l.href} target="_blank" rel="noopener noreferrer">{l.text}</a> : l.text}</li>
        ))}
      </ul>
      <p className="muted proof-note">
        沒有評分資料（地圖上沒有）。
        <a href={maps} target="_blank" rel="noopener noreferrer">
          在 Google 地圖看評分 ↗
        </a>
      </p>
    </div>
  );
}
