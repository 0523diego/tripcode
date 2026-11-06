// 訂票清單 and 吃飯空檔: the two things the office page is for. Both are derived from the trip file on the page
// (src/core/bookings.ts, meals.ts); the buttons write through /__tripcode/booking and /__tripcode/meal and the
// viewer reloads with the new file. Nothing here pays: the links open the seller's own page in a new tab.
//
// Layout: one card per thing to buy, grouped by city. The colour of a card's left edge is its urgency; everything
// that is not needed to decide ("why is this here", cancellation terms, the 'I bought it' form) sits behind 「更多」.
import { useState } from 'react';
import type { BookingLink, BookingList, BookingTodo, Urgency } from '../../core/bookings.ts';
import { restaurantsNearUrl } from '../../core/meals.ts';
import { stageSummary } from '../../core/plan.ts';
import type { Stage } from '../../core/plan.ts';
import type { MealGap } from '../../core/meals.ts';
import type { ReadinessIssue } from '../../core/readiness.ts';
import type { Trip } from '../../core/types.ts';
import { post } from '../api.ts';
import { FILTER_LABEL, NEED_LABEL, URGENCY_LABEL, VIA_OPTIONS, anchorChoices, counts, countdowns, filterTodos, groupByPlace, insertionPoint, placeOf, shortDate, weekdayZh } from './booking-model.ts';
import type { Filter, Place, PlaceGroup } from './booking-model.ts';

type Say = (message: string, ok?: boolean) => void;

// ---------- 出發準備 ----------

const ACCEPTABLE = ['walking-heavy', 'day-time-tight', 'no-easy-day'];

/** One line while closed (where you are in the five steps); the steps and every note open under it. */
export function ReadinessCard({ issues, summary, stages, onAsk, onAccept }: { issues: ReadinessIssue[]; summary: string; stages: Stage[]; onAsk: (text: string) => void; onAccept: (date: string, code: string) => void }) {
  const cur = stages.find((s) => s.status === 'doing');
  const warns = issues.filter((i) => i.level === 'warn');
  const infos = issues.filter((i) => i.level === 'info');
  return (
    <details className="of-ready bk-ready" aria-label="出發準備度" data-state={warns.length > 0 ? 'warn' : 'ok'}>
      <summary>
        <b>出發準備</b>
        <span className="bk-dots" aria-hidden="true">
          {stages.map((s) => (
            <i key={s.id} data-status={s.status} />
          ))}
        </span>
        <span className="muted">{stages.length > 0 ? stageSummary(stages) : summary}</span>
      </summary>
      <ol className="of-stages" aria-label="規劃的五個步驟">
        {stages.map((s) => (
          <li key={s.id} data-status={s.status} title={s.criteria}>
            <span className="of-stage-n" aria-hidden="true">
              {s.status === 'done' ? '✓' : s.n}
            </span>
            <span>{s.title}</span>
            {s.status === 'doing' && <em>{s.open}</em>}
          </li>
        ))}
      </ol>
      <p className="muted bk-sum">{summary}</p>
      {cur && (
        <p className="of-next-step">
          下一步：{cur.next}
          <button type="button" className="btn of-small" onClick={() => onAsk(`我們在規劃的第 ${cur.n} 步「${cur.title}」。照 ${cur.skill} 技能做：先說你看到什麼，再問我需要確認的。`)}>
            請 AI 做這一步
          </button>
        </p>
      )}
      {warns.length > 0 && (
        <ul className="of-list">
          {warns.map((i, n) => (
            <li key={`${i.code}-${n}`}>
              <span>{i.message}</span>
            </li>
          ))}
        </ul>
      )}
      {infos.length > 0 && (
        <details className="of-more">
          <summary>{infos.length} 項提醒</summary>
          <ul className="of-list">
            {infos.map((i, n) => (
              <li key={`${i.code}-${n}`}>
                <span>{i.message}</span>
                {i.date && ACCEPTABLE.includes(i.code) && (
                  <button type="button" className="btn of-small" onClick={() => onAccept(i.date!, i.code)} title="我看過了，這天就想這樣排：這條提醒不再出現">
                    這天就這樣
                  </button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </details>
  );
}

// ---------- shared bits ----------

function GroupHead({ g, count, unit }: { g: PlaceGroup<unknown>; count: number; unit: string }) {
  const range = g.from === g.to ? shortDate(g.from) : `${shortDate(g.from)}–${shortDate(g.to)}`;
  return (
    <h3 className="bk-group-head">
      <span className="bk-place" data-kind={g.kind}>
        {g.kind === 'stay' ? `住 ${g.label}` : g.label}
      </span>
      <span className="muted">
        {range} · {count} {unit}
      </span>
    </h3>
  );
}

const hasStayGroup = (groups: PlaceGroup<unknown>[]) => groups.some((g) => g.kind === 'stay');

// ---------- 訂票清單 ----------

function LinkButton({ link }: { link: BookingLink }) {
  const checked = link.urlKind !== 'search';
  const title = checked
    ? `${link.urlKind === 'site' ? '官網首頁' : '確認過的購票頁'}${link.source ? `。來源：${link.source}` : ''}${link.fetchedAt ? `（${link.fetchedAt.slice(0, 10)} 查）` : ''}`
    : '只是搜尋，不是特定商品：打開後請自己確認是不是這個景點與日期';
  return (
    <a className={`of-link${link.key === 'official' ? ' main' : ''}${checked ? '' : ' search'}`} href={link.url} target="_blank" rel="noopener noreferrer" title={title}>
      {link.label}
      {!checked && link.key !== 'official' ? ' 搜尋' : ''} ↗
    </a>
  );
}

function Card({ t, tripId, file, today, say, onAsk }: { t: BookingTodo; tripId: string; file: string; today: string; say: Say; onAsk: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  const [via, setVia] = useState<string>('官方');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [busy, setBusy] = useState(false);
  const isGap = t.basis === 'gap';

  const act = async (action: 'booked' | 'not-needed' | 'todo', ok: string, extra: Record<string, unknown> = {}) => {
    setBusy(true);
    const r = await post('booking', { tripId, file, itemId: t.itemId, action, need: t.need, ...extra });
    setBusy(false);
    say(r.ok ? ok : (r.error ?? '失敗'), r.ok);
    if (r.ok) {
      setAsking(false);
      setOpen(false);
    }
  };
  const cd = t.status === 'todo' ? countdowns(t, today) : [];
  const urgencyLabel = t.status === 'todo' ? URGENCY_LABEL[t.urgency] : '';

  return (
    <li className="bk-card" data-urgency={t.urgency} data-status={t.status} data-open={open}>
      <div className="bk-top">
        <time>
          {shortDate(t.date)} <span className="muted">{weekdayZh(t.date)}</span>
        </time>
        <span className="bk-pills">
          {t.status === 'booked' ? <i className="bk-pill ok">已買{t.boughtVia ? `・${t.boughtVia}` : ''}</i> : t.status === 'not-needed' ? <i className="bk-pill">不需要</i> : <i className={`bk-pill ${t.need}`}>{NEED_LABEL[t.need]}</i>}
          {t.conflict && (
            <i className="bk-pill err" title={t.conflict}>
              來源不一致
            </i>
          )}
        </span>
      </div>
      <b className="bk-title">{t.title}</b>
      {(cd.length > 0 || (urgencyLabel && (t.urgency === 'overdue' || t.urgency === 'now'))) && <p className="bk-when">{cd.length > 0 ? cd.join('・') : urgencyLabel}</p>}

      {t.links.length > 0 && t.status !== 'not-needed' && (
        <div className="bk-links" aria-label="購買連結">
          {t.links.map((l) => (
            <LinkButton key={l.key} link={l} />
          ))}
        </div>
      )}
      {isGap && t.status === 'todo' && (
        <div className="bk-links">
          <button type="button" className="btn of-small" onClick={() => onAsk(`${t.title}。照 plan-trip 的住宿規則，先把一個「待選」的住宿放進行程，並列出 2–3 個選項讓我選，不要直接決定。`)}>
            請 AI 幫我挑住宿
          </button>
        </div>
      )}

      <div className="bk-foot">
        {!isGap && t.status === 'todo' && !asking && (
          <button type="button" className="btn" onClick={() => { setOpen(true); setAsking(true); }} disabled={busy}>
            我買好了
          </button>
        )}
        <button type="button" className="bk-more-btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? '收起' : '更多'}
        </button>
      </div>

      {open && (
        <div className="bk-more">
          <dl>
            <dt>為什麼列出</dt>
            <dd>{t.reason}</dd>
            <dt>取消條件</dt>
            <dd>{t.cancellation ?? '還沒查'}</dd>
            {t.timedSlots && (
              <>
                <dt>票種</dt>
                <dd>要選時段</dd>
              </>
            )}
            {t.status === 'booked' && !t.hasVoucher && (
              <>
                <dt>票券</dt>
                <dd>還沒上傳（到地圖頁點這個項目）</dd>
              </>
            )}
          </dl>
          {t.conflict && <p className="of-conflict">{t.conflict}</p>}
          {!isGap && (
            <div className="of-actions">
              {t.status === 'todo' && (
                <button type="button" className="btn of-quiet" onClick={() => void act('not-needed', '記成不需要了')} disabled={busy}>
                  這個不需要
                </button>
              )}
              {t.status !== 'todo' && (
                <button type="button" className="btn of-quiet" onClick={() => void act('todo', '改回待買')} disabled={busy}>
                  改回待買
                </button>
              )}
            </div>
          )}
          {asking && (
            <form
              className="of-form"
              onSubmit={(e) => {
                e.preventDefault();
                void act('booked', '記下了：已買、已鎖定', { via: via === '官方' ? 'official' : via, ...(start ? { start } : {}), ...(end ? { end } : {}) });
              }}
            >
              <label>
                在哪裡買的
                <select value={via} onChange={(e) => setVia(e.target.value)}>
                  {VIA_OPTIONS.map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
              <label>
                入場時間（選填）
                <input type="time" value={start} onChange={(e) => setStart(e.target.value)} />
              </label>
              <label>
                到
                <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
              </label>
              <div className="of-actions">
                <button type="submit" className="btn primary" disabled={busy}>
                  確定，已買好
                </button>
                <button type="button" className="btn of-quiet" onClick={() => setAsking(false)}>
                  取消
                </button>
              </div>
              <p className="muted of-hint">會把這一項標成已買並鎖定。要復原按 ⌘Z。價格和票券之後再補也可以。</p>
            </form>
          )}
        </div>
      )}
    </li>
  );
}

const LEGEND: { u: Urgency | 'booked'; label: string }[] = [
  { u: 'overdue', label: '已過期' },
  { u: 'now', label: '現在要訂' },
  { u: 'soon', label: '這個月內' },
  { u: 'later', label: '之後' },
  { u: 'booked', label: '已買' },
];

export function BookingSection({ list, trip, tripId, file, today, say, onAsk }: { list: BookingList; trip: Trip; tripId: string; file: string; today: string; say: Say; onAsk: (text: string) => void }) {
  const [filter, setFilter] = useState<Filter>('todo');
  const c = counts(list);
  const rows = filterTodos(list, filter);
  const groups = groupByPlace(rows, placeOf(trip));
  const urgent = list.items.filter((t) => t.status === 'todo' && (t.urgency === 'overdue' || t.urgency === 'now')).length;
  const searchOnly = list.items.filter((t) => t.status === 'todo' && t.basis !== 'gap' && t.links[0]?.urlKind === 'search');
  return (
    <section className="of-section" aria-label="訂票清單">
      <header className="of-section-head">
        <h2>訂票清單</h2>
        <span className="muted">{c.todo > 0 ? `還有 ${c.todo} 件待買${urgent > 0 ? `，${urgent} 件現在就要處理` : ''}` : '沒有待買的項目'}</span>
        <div className="seg" role="group" aria-label="篩選">
          {(['todo', 'booked', 'not-needed', 'all'] as Filter[]).map((f) => (
            <button key={f} type="button" className={f === filter ? 'on' : ''} aria-pressed={f === filter} onClick={() => setFilter(f)}>
              {FILTER_LABEL[f]} {c[f]}
            </button>
          ))}
        </div>
      </header>
      <ul className="bk-legend" aria-label="顏色說明">
        {LEGEND.map((l) => (
          <li key={l.u} data-urgency={l.u === 'booked' ? 'none' : l.u} data-status={l.u === 'booked' ? 'booked' : 'todo'}>
            <i aria-hidden="true" />
            {l.label}
          </li>
        ))}
      </ul>
      {rows.length === 0 && (
        <p className="of-empty muted">
          {filter === 'todo' ? '這個清單是從行程推導出來的：機票、住宿、城際交通，以及備註裡寫了「尚未訂票」「要預約」的景點。目前沒有待買的。' : '這裡還沒有項目。'}
        </p>
      )}
      {groups.map((g) => (
        <div key={g.key} className="bk-group">
          <GroupHead g={g} count={g.items.length} unit="件" />
          <ul className="bk-grid">
            {g.items.map((t) => (
              <Card key={t.itemId} t={t} tripId={tripId} file={file} today={today} say={say} onAsk={onAsk} />
            ))}
          </ul>
        </div>
      ))}
      {hasStayGroup(groups) && <p className="of-note muted bk-hint">這幾組是依「你睡在哪間住宿」分的。在行程裡替每一天填上 city（例如「米蘭」），這裡就會改顯示城市名。</p>}
      {searchOnly.length > 0 && filter === 'todo' && (
        <p className="bk-hint muted">
          {searchOnly.length} 項的官方連結還只是搜尋，不是特定購票頁。
          <button type="button" className="btn of-small" onClick={() => onAsk('照 booking-checklist 技能，幫我把訂票清單裡還沒有官方購票連結的項目補上：從官網點到購票頁、附證據，找不到就明說，不要用轉售商當官方。')}>
            請 AI 補官方連結
          </button>
        </p>
      )}
      {list.unknown.length > 0 && (
        <details className="of-more">
          <summary>這 {list.unknown.length} 個地點沒有訂票資訊：{list.unknown.map((u) => u.title).join('、')}</summary>
          <p className="muted">它們有票價或提到票，但不知道要不要預約。要請 AI 去官網查嗎？</p>
          <button type="button" className="btn" onClick={() => onAsk(`這幾個地點沒有訂票資訊：${list.unknown.map((u) => u.title).join('、')}。照 booking-checklist 技能查官方頁，確認要不要預約，寫進 booking 並附來源。`)}>
            請 AI 查
          </button>
        </details>
      )}
    </section>
  );
}

// ---------- 吃飯空檔 ----------

function GapCard({ gap, trip, tripId, file, say, city }: { gap: MealGap; trip: Trip; tripId: string; file: string; say: Say; city?: string }) {
  const choices = anchorChoices(gap);
  const [anchor, setAnchor] = useState(gap.defaultAnchor);
  const [open, setOpen] = useState(false);
  const [mapsUrl, setMapsUrl] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const picked = choices.find((c) => c.key === anchor) ?? choices[0];
  const day = trip.days.find((d) => d.date === gap.date);

  const add = async () => {
    setBusy(true);
    const r = await post('meal', { tripId, file, date: gap.date, title: name, mapsUrl, ...(gap.existingItemId ? { existingItemId: gap.existingItemId } : { beforeItemId: insertionPoint(day, gap, anchor) }) });
    setBusy(false);
    say(r.ok ? '加進行程了。要改回去按 ⌘Z' : (r.error ?? '失敗'), r.ok);
    if (r.ok) {
      setMapsUrl('');
      setName('');
      setOpen(false);
    }
  };

  return (
    <li className="bk-card meal" data-open={open}>
      <div className="bk-top">
        <time>
          {shortDate(gap.date)} <span className="muted">{weekdayZh(gap.date)}</span>
        </time>
        <span className="bk-pills">
          <i className="bk-pill">
            {gap.window.from}–{gap.window.to}
          </i>
        </span>
      </div>
      <b className="bk-title">{gap.slot === 'lunch' ? '午餐' : '晚餐'}還沒決定</b>
      {choices.length === 0 ? (
        <p className="bk-when muted">前後的地點都沒有座標，先替它們補上座標才找得到附近的餐廳。</p>
      ) : (
        <>
          <label className="bk-anchor">
            <span className="muted">在哪一帶吃</span>
            <select value={anchor} onChange={(e) => setAnchor(e.target.value as MealGap['defaultAnchor'])}>
              {choices.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <div className="bk-links">
            <a className="of-link main" href={restaurantsNearUrl(picked!.title, city)} target="_blank" rel="noopener noreferrer">
              在 Google 地圖找附近餐廳 ↗
            </a>
          </div>
        </>
      )}
      <div className="bk-foot">
        <button type="button" className="bk-more-btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? '收起' : '貼上選好的店'}
        </button>
      </div>
      {open && (
        <div className="bk-more">
          {gap.kind === 'undecided' && <p className="muted bk-note">這餐已經有「待選」佔位，會填進去而不是再加一餐。</p>}
          {gap.basis === 'positional' && <p className="muted bk-note">這天的項目沒有填時間，位置是依順序推估的。</p>}
          {gap.blockedBy && <p className="muted bk-note">因為「{gap.blockedBy}」，晚餐時間往前提。</p>}
          <div className="of-form inline">
            <label>
              Google 地圖連結
              <input type="url" placeholder="https://www.google.com/maps/place/…" value={mapsUrl} onChange={(e) => setMapsUrl(e.target.value)} />
            </label>
            <label>
              店名（連結裡有就可以不填）
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <button type="button" className="btn" onClick={() => void add()} disabled={busy || (mapsUrl.trim() === '' && name.trim() === '')}>
              {gap.existingItemId ? '填進這餐' : '加進行程'}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

export function MealSection({ gaps, trip, tripId, file, say, city }: { gaps: MealGap[]; trip: Trip; tripId: string; file: string; say: Say; city?: string }) {
  const place: (date: string) => Place = placeOf(trip);
  const groups = groupByPlace(gaps, place);
  return (
    <section className="of-section" aria-label="吃飯空檔">
      <header className="of-section-head">
        <h2>吃飯空檔</h2>
        <span className="muted">{gaps.length > 0 ? `${gaps.length} 餐還沒決定` : '每一餐都決定了'}</span>
      </header>
      {gaps.length === 0 ? (
        <p className="of-empty muted">午餐與晚餐都有地點，或那幾天沒有安排。</p>
      ) : (
        groups.map((g) => (
          <div key={g.key} className="bk-group">
            <GroupHead g={g} count={g.items.length} unit="餐" />
            <ul className="bk-grid">
              {g.items.map((m) => (
                <GapCard key={`${m.date}-${m.slot}`} gap={m} trip={trip} tripId={tripId} file={file} say={say} city={city} />
              ))}
            </ul>
          </div>
        ))
      )}
      <p className="of-note muted bk-hint">排序與評分要用 Google 的資料，之後會加。現在先用地圖連結找，挑好貼回來。</p>
    </section>
  );
}
