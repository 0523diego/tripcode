// One place as a card: its picture on top, then the name and how far it is, what it is like (the AI's introduction, with the pages
// it comes from), a few chips, and the proof behind them folded away. Used by the meal drawer and by the board on the left of the
// screen. The buttons at the bottom are the caller's.
import type { ReactNode } from 'react';
import { fileUrl } from '../agent/files.ts';
import { TIER_LABEL, chipBadges, placeBadges } from './food-view.ts';
import type { NearResult } from './food-view.ts';

const host = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return u;
  }
};

export function PlaceCard({ r, rank, generalMode, dishNames, skipDishBadge, children }: { r: NearResult; rank: number; generalMode: boolean; dishNames?: string; skipDishBadge?: boolean; children?: ReactNode }) {
  return (
    <li data-tier={r.tier} className="fd-card">
      <div className={`fd-media${r.photo ? '' : ' none'}`}>
        {r.photo ? <img src={fileUrl(r.photo.path)} alt={`${r.name} 的照片`} loading="lazy" /> : <span className="fd-nophoto">這家的網頁沒有可用的照片</span>}
        <span className="fd-rank">{rank}</span>
        <span className={`fd-tier ${r.tier}`}>{TIER_LABEL[r.tier]}</span>
        {r.photo && (
          <a className="fd-credit-link" href={r.photo.pageUrl} target="_blank" rel="noopener noreferrer" title="照片來自店家自己的網頁，版權屬於店家">
            照片：店家網頁 ↗
          </a>
        )}
      </div>
      <div className="fd-body">
        <h3 className="fd-name">{r.name}</h3>
        <p className="fd-meta">
          走 {r.walkMin} 分鐘 · {r.distanceM} m{dishNames ? ` · ${dishNames}` : ''}
        </p>
        {r.profile ? (
          <div className="fd-profile">
            <p className="fd-summary">{r.profile.summary}</p>
            <dl className="fd-facts">
              {r.profile.order && r.profile.order.length > 0 && (
                <>
                  <dt>點什麼</dt>
                  <dd>{r.profile.order.join('、')}</dd>
                </>
              )}
              {r.profile.price && (
                <>
                  <dt>價位</dt>
                  <dd>{r.profile.price}</dd>
                </>
              )}
              {r.profile.watch && (
                <>
                  <dt>注意</dt>
                  <dd>{r.profile.watch}</dd>
                </>
              )}
            </dl>
            <p className="fd-sources">
              依據{' '}
              {r.profile.sources.map((u, n) => (
                <a key={u} href={u} target="_blank" rel="noopener noreferrer">
                  {n > 0 ? '、' : ''}
                  {host(u)}
                </a>
              ))}{' '}
              · {r.profile.fetchedAt.slice(0, 10)}
            </p>
          </div>
        ) : (
          <p className="fd-pending">AI 還沒查過這家。在 AI 助手說「幫我查前三家」。</p>
        )}
        <div className="fd-chips">
          {chipBadges(r).map((b) => (
            <span key={b.text} className={`fd-chip ${b.tone}`}>
              {b.text}
            </span>
          ))}
        </div>
        <details className="fd-details">
          <summary>查證細節</summary>
          <ul>
            {placeBadges(r, generalMode, { skipDishBadge }).map((b) => (
              <li key={b.text}>{b.text}</li>
            ))}
            {r.photo && <li>照片來自店家自己的網頁，版權屬於店家</li>}
          </ul>
        </details>
      </div>
      {children}
    </li>
  );
}
