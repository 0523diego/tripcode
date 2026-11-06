// The question cards of step 0, one per `nextStep` (titles from STEP_TITLE). Each card keeps its draft in local state,
// starts from the stored answer (so a chip can reopen it) and ends in `ctx.answer` / `ctx.run`.
import { useState } from 'react';
import type { ReactNode } from 'react';
import { FOCUS_VALUES, SCENERY_LABEL, SCENERY_TAGS, STEP_TITLE, WHO_LABEL, WHO_VALUES, chosenPlace, ideaSummary, roundPlaces, suggestDates } from '../../core/idea.ts';
import type { Focus, Idea, IdeaPlace, SceneryTag, Who } from '../../core/idea.ts';
import {
  CURRENCIES,
  DAY_CHOICES,
  adultsFor,
  bestMonthsText,
  canWantNow,
  costView,
  dayCount,
  defaultTitle,
  isQuestion,
  parseAges,
  placeMeta,
  safeHref,
} from './idea-view.ts';
import type { CardStep } from './idea-view.ts';

export interface FinishForm {
  title: string;
  tz: string;
  adults: number;
  childrenAges: number[];
}

export interface CardCtx {
  idea: Idea;
  busy: boolean;
  error: string | null;
  /** True when the user came back to this card from a chip. */
  reopened: boolean;
  cancelReopen: () => void;
  /** Records an answer (null = 不知道／跳過) and moves on. */
  answer: (field: string, value: unknown) => Promise<boolean>;
  /** Any other `idea` op (choose, reject, reject-round, dates). */
  run: (body: Record<string, unknown>) => Promise<boolean>;
  /** Asks the AI panel; the page shows the 「AI 正在想…」 state until the answer lands in the file. */
  ask: (prompt: 'suggest' | 'more' | 'locate') => Promise<void>;
  thinking: boolean;
  agentReady: boolean;
  openAgent: () => void;
  hoverId: string | null;
  setHover: (id: string | null) => void;
  /** The place whose pin was clicked, to highlight its card. */
  pickedId: string | null;
  finish: (form: FinishForm) => Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Pieces

function Shell({ step, ctx, lead, children }: { step: CardStep; ctx: CardCtx; lead?: string; children: ReactNode }) {
  return (
    <section className="idea-card" data-step={step} aria-labelledby="idea-card-title">
      <h2 id="idea-card-title" className="idea-card__title" tabIndex={-1}>
        {STEP_TITLE[step]}
      </h2>
      {lead && <p className="idea-card__lead">{lead}</p>}
      {children}
      {ctx.error && (
        <p className="idea-error" role="alert">
          {ctx.error}
        </p>
      )}
      <div className="idea-card__foot">
        {isQuestion(step) && (
          <button type="button" className="idea-quiet" disabled={ctx.busy} onClick={() => void ctx.answer(step, null)}>
            不知道／跳過
          </button>
        )}
        {canWantNow(step) && !ctx.idea.wantNow && (
          <button type="button" className="idea-quiet" disabled={ctx.busy} onClick={() => void ctx.answer('wantNow', true)}>
            直接推薦
          </button>
        )}
        {ctx.reopened && (
          <button type="button" className="idea-quiet" onClick={ctx.cancelReopen}>
            不改了
          </button>
        )}
      </div>
    </section>
  );
}

function Next({ ctx, disabled, label = '下一步' }: { ctx: CardCtx; disabled?: boolean; label?: string }) {
  return (
    <button type="submit" className="idea-primary" disabled={disabled || ctx.busy}>
      {ctx.busy ? '儲存中…' : label}
    </button>
  );
}

function Tile({ on, onClick, children, hint }: { on?: boolean; onClick: () => void; children: ReactNode; hint?: string }) {
  return (
    <button type="button" className="idea-tile" aria-pressed={on} onClick={onClick}>
      <span>{children}</span>
      {hint && <small>{hint}</small>}
    </button>
  );
}

function Toggle({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className="idea-toggle" aria-pressed={on} onClick={onClick}>
      {children}
    </button>
  );
}

function Stepper({ value, min, max, onChange, label }: { value: number; min: number; max: number; onChange: (n: number) => void; label: string }) {
  return (
    <div className="idea-stepper" role="group" aria-label={label}>
      <button type="button" aria-label={`${label}減一`} disabled={value <= min} onClick={() => onChange(value - 1)}>
        −
      </button>
      <output aria-live="off">{value}</output>
      <button type="button" aria-label={`${label}加一`} disabled={value >= max} onClick={() => onChange(value + 1)}>
        ＋
      </button>
    </div>
  );
}

const form = (ctx: CardCtx, onSubmit: () => void) => ({
  className: 'idea-form',
  onSubmit: (e: React.FormEvent) => {
    e.preventDefault();
    if (!ctx.busy) onSubmit();
  },
});

// ---------------------------------------------------------------------------------------------
// Questions

function KnownCard({ ctx }: { ctx: CardCtx }) {
  const known = ctx.idea.known;
  const [typing, setTyping] = useState(known?.decided === true);
  const [place, setPlace] = useState(known?.decided ? known.place : '');
  return (
    <Shell step="known" ctx={ctx}>
      <div className="idea-tiles idea-tiles--2">
        <Tile on={typing} onClick={() => setTyping(true)} hint="直接告訴我地方">
          我已經想好了
        </Tile>
        <Tile on={known?.decided === false} onClick={() => void ctx.answer('known', { decided: false })} hint="我來幫你找">
          還沒有想法
        </Tile>
      </div>
      {typing && (
        <form {...form(ctx, () => void ctx.answer('known', { decided: true, place: place.trim() }))}>
          <label className="idea-field">
            <span>想去哪裡？</span>
            <input value={place} onChange={(e) => setPlace(e.target.value)} placeholder="例如：瑞士、京都、冰島" maxLength={80} autoFocus />
          </label>
          <Next ctx={ctx} disabled={!place.trim()} label="確定" />
        </form>
      )}
    </Shell>
  );
}

function OriginCard({ ctx }: { ctx: CardCtx }) {
  const [origin, setOrigin] = useState(ctx.idea.origin ?? '');
  return (
    <Shell step="origin" ctx={ctx}>
      <form {...form(ctx, () => void ctx.answer('origin', origin.trim()))}>
        <label className="idea-field">
          <span className="sr-only">出發地</span>
          <input value={origin} onChange={(e) => setOrigin(e.target.value)} placeholder="例如：台北" maxLength={80} autoFocus />
        </label>
        <Next ctx={ctx} disabled={!origin.trim()} />
      </form>
    </Shell>
  );
}

const FOCUS_HINT: Record<Focus, string> = { budget: '先看花多少錢', scenery: '先看想看什麼', both: '兩邊都顧' };
const FOCUS_TILE: Record<Focus, string> = { budget: '預算', scenery: '想看的風景與體驗', both: '兩個都在意' };

function FocusCard({ ctx }: { ctx: CardCtx }) {
  return (
    <Shell step="focus" ctx={ctx}>
      <div className="idea-tiles">
        {FOCUS_VALUES.map((f) => (
          <Tile key={f} on={ctx.idea.focus === f} hint={FOCUS_HINT[f]} onClick={() => void ctx.answer('focus', f)}>
            {FOCUS_TILE[f]}
          </Tile>
        ))}
      </div>
    </Shell>
  );
}

function BudgetCard({ ctx }: { ctx: CardCtx }) {
  const b = ctx.idea.budget;
  const [amount, setAmount] = useState(b ? String(b.amount) : '');
  const [currency, setCurrency] = useState<string>(b?.currency ?? 'TWD');
  const [per, setPer] = useState<'person' | 'total'>(b?.per ?? 'person');
  const n = Number(amount);
  const ok = Number.isFinite(n) && n > 0 && n <= 1e9;
  return (
    <Shell step="budget" ctx={ctx}>
      <form {...form(ctx, () => void ctx.answer('budget', { amount: n, currency, per }))}>
        <div className="idea-row">
          <label className="idea-field idea-field--grow">
            <span>金額</span>
            <input type="number" inputMode="decimal" min={1} step="any" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="例如：60000" autoFocus />
          </label>
          <label className="idea-field">
            <span>幣別</span>
            <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {CURRENCIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="idea-seg" role="group" aria-label="計算方式">
          <Toggle on={per === 'person'} onClick={() => setPer('person')}>
            每人
          </Toggle>
          <Toggle on={per === 'total'} onClick={() => setPer('total')}>
            總共
          </Toggle>
        </div>
        <Next ctx={ctx} disabled={!ok} />
      </form>
    </Shell>
  );
}

function SceneryCard({ ctx }: { ctx: CardCtx }) {
  const s = ctx.idea.scenery;
  const [tags, setTags] = useState<SceneryTag[]>(s?.tags ?? []);
  const [text, setText] = useState(s?.text ?? '');
  const flip = (t: SceneryTag) => setTags((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]));
  return (
    <Shell step="scenery" ctx={ctx} lead="可以選好幾個">
      <form {...form(ctx, () => void ctx.answer('scenery', { tags, ...(text.trim() ? { text: text.trim() } : {}) }))}>
        <div className="idea-tiles idea-tiles--chips" role="group" aria-label="想看什麼">
          {SCENERY_TAGS.map((t) => (
            <Toggle key={t} on={tags.includes(t)} onClick={() => flip(t)}>
              {SCENERY_LABEL[t]}
            </Toggle>
          ))}
        </div>
        <label className="idea-field">
          <span>還有別的想法？（選填）</span>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="例如：想泡溫泉" maxLength={200} />
        </label>
        <Next ctx={ctx} disabled={tags.length === 0 && !text.trim()} />
      </form>
    </Shell>
  );
}

function WhenCard({ ctx }: { ctx: CardCtx }) {
  const [months, setMonths] = useState<number[]>(ctx.idea.when?.months ?? []);
  const flip = (m: number) => setMonths((cur) => (cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m].sort((a, b) => a - b)));
  return (
    <Shell step="when" ctx={ctx} lead="可以選好幾個月">
      <form {...form(ctx, () => void ctx.answer('when', { months }))}>
        <div className="idea-months" role="group" aria-label="月份">
          {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
            <Toggle key={m} on={months.includes(m)} onClick={() => flip(m)}>
              {m} 月
            </Toggle>
          ))}
        </div>
        <Next ctx={ctx} disabled={months.length === 0} />
      </form>
    </Shell>
  );
}

function DaysCard({ ctx }: { ctx: CardCtx }) {
  const d = ctx.idea.days;
  const [days, setDays] = useState(d ? String(d) : '');
  const n = Number(days);
  const ok = Number.isInteger(n) && n >= 1 && n <= 90;
  return (
    <Shell step="days" ctx={ctx}>
      <form {...form(ctx, () => void ctx.answer('days', n))}>
        <div className="idea-chips-row" role="group" aria-label="常見天數">
          {DAY_CHOICES.map((c) => (
            <Toggle key={c} on={days === String(c)} onClick={() => setDays(String(c))}>
              {c} 天
            </Toggle>
          ))}
        </div>
        <label className="idea-field">
          <span>或自己填天數</span>
          <input type="number" inputMode="numeric" min={1} max={90} value={days} onChange={(e) => setDays(e.target.value)} placeholder="例如：6" />
        </label>
        <Next ctx={ctx} disabled={!ok} />
      </form>
    </Shell>
  );
}

function PartyFields({ who, adults, setAdults, ages, setAges, agesOk }: { who: Who; adults: number; setAdults: (n: number) => void; ages: string; setAges: (s: string) => void; agesOk: boolean }) {
  return (
    <>
      <div className="idea-row idea-row--center">
        <span className="idea-label">大人</span>
        <Stepper label="大人" value={adults} min={1} max={20} onChange={setAdults} />
      </div>
      {who !== 'solo' && (
        <label className="idea-field">
          <span>小孩年齡（選填，用逗號分開）</span>
          <input value={ages} onChange={(e) => setAges(e.target.value)} placeholder="例如：5, 8" aria-invalid={!agesOk} />
          {!agesOk && <small className="idea-error">請填 0–17 的整數，例如 5, 8</small>}
        </label>
      )}
    </>
  );
}

function PartyCard({ ctx }: { ctx: CardCtx }) {
  const p = ctx.idea.party;
  const [who, setWho] = useState<Who | null>(p?.who ?? null);
  const [adults, setAdults] = useState(p?.adults ?? 2);
  const [ages, setAges] = useState(p?.childrenAges.join(', ') ?? '');
  const parsed = who === 'solo' ? [] : parseAges(ages);
  const pick = (w: Who) => {
    setWho(w);
    setAdults(adultsFor(w)); // a sensible start; the stepper is right there
    if (w === 'solo') setAges('');
  };
  return (
    <Shell step="party" ctx={ctx}>
      <form {...form(ctx, () => who && parsed && void ctx.answer('party', { who, adults: who === 'solo' ? 1 : adults, childrenAges: parsed }))}>
        <div className="idea-tiles idea-tiles--chips" role="group" aria-label="跟誰去">
          {WHO_VALUES.map((w) => (
            <Toggle key={w} on={who === w} onClick={() => pick(w)}>
              {WHO_LABEL[w]}
            </Toggle>
          ))}
        </div>
        {who && <PartyFields who={who} adults={who === 'solo' ? 1 : adults} setAdults={setAdults} ages={ages} setAges={setAges} agesOk={parsed !== null} />}
        <Next ctx={ctx} disabled={!who || parsed === null} />
      </form>
    </Shell>
  );
}

// ---------------------------------------------------------------------------------------------
// Ask the AI

function Thinking() {
  return (
    <p className="idea-thinking" role="status">
      <span className="idea-thinking__dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      AI 正在想…
    </p>
  );
}

function AgentHint({ ctx }: { ctx: CardCtx }) {
  if (ctx.agentReady) return null;
  return (
    <p className="idea-hint">
      AI 助手還沒連接。
      <button type="button" className="idea-link" onClick={ctx.openAgent}>
        打開右邊的 AI 助手
      </button>
      ，按「安裝並連接」就能用。
    </p>
  );
}

function SuggestCard({ ctx }: { ctx: CardCtx }) {
  const lines = ideaSummary(ctx.idea);
  return (
    <Shell step="suggest" ctx={ctx} lead="我會根據你的回答，給 3 種不一樣的旅行。">
      {lines.length > 0 && <p className="idea-recap">{lines.join(' · ')}</p>}
      {ctx.thinking ? (
        <Thinking />
      ) : (
        <button type="button" className="idea-primary idea-primary--big" onClick={() => void ctx.ask('suggest')}>
          給我 3 個點子
        </button>
      )}
      <AgentHint ctx={ctx} />
    </Shell>
  );
}

function LocateCard({ ctx }: { ctx: CardCtx }) {
  const place = ctx.idea.known?.decided ? ctx.idea.known.place : '';
  return (
    <Shell step="locate" ctx={ctx} lead="AI 會把它放到地球上，並查好時區。">
      {ctx.thinking ? (
        <Thinking />
      ) : (
        <button type="button" className="idea-primary idea-primary--big" onClick={() => void ctx.ask('locate')}>
          把『{place}』放到地球上
        </button>
      )}
      <AgentHint ctx={ctx} />
    </Shell>
  );
}

// ---------------------------------------------------------------------------------------------
// Choose

function PlaceCard({ place, ctx }: { place: IdeaPlace; ctx: CardCtx }) {
  const cost = costView(place);
  const months = bestMonthsText(place);
  const href = cost?.source ? safeHref(cost.source) : undefined;
  return (
    <article
      className="idea-place"
      id={`idea-place-${place.id}`}
      data-chosen={place.status === 'chosen'}
      data-picked={ctx.pickedId === place.id}
      onPointerEnter={() => ctx.setHover(place.id)}
      onFocus={() => ctx.setHover(place.id)}
    >
      <header>
        <h3>{place.name}</h3>
        <span className="idea-place__meta">{placeMeta(place)}</span>
      </header>
      <p className="idea-place__why">{place.why}</p>
      <ul className="idea-place__facts">
        {months && <li>{months}</li>}
        {cost && (
          <li>
            {cost.text}
            {cost.estimate ? (
              <span className="idea-badge">估計</span>
            ) : href ? (
              <>
                {' '}
                <a href={href} target="_blank" rel="noreferrer noopener">
                  來源
                </a>
              </>
            ) : (
              <span className="idea-place__source">（來源：{cost.source}）</span>
            )}
          </li>
        )}
      </ul>
      <div className="idea-place__actions">
        <button type="button" className="idea-primary" disabled={ctx.busy || place.status === 'chosen'} onClick={() => void ctx.run({ op: 'choose', placeId: place.id })}>
          {place.status === 'chosen' ? '已選這個' : '選這個'}
        </button>
        <button type="button" className="idea-ghost" disabled={ctx.busy} onClick={() => void ctx.run({ op: 'reject', placeId: place.id })}>
          不要
        </button>
      </div>
    </article>
  );
}

function ChooseCard({ ctx }: { ctx: CardCtx }) {
  const places = roundPlaces(ctx.idea).filter((p) => p.status !== 'rejected');
  return (
    <Shell step="choose" ctx={ctx}>
      <div className="idea-places" onPointerLeave={() => ctx.setHover(null)} onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && ctx.setHover(null)}>
        {places.map((p) => (
          <PlaceCard key={p.id} place={p} ctx={ctx} />
        ))}
      </div>
      <button type="button" className="idea-ghost idea-ghost--wide" disabled={ctx.busy || ctx.thinking} onClick={() => void ctx.ask('more')}>
        再給我別的
      </button>
    </Shell>
  );
}

// ---------------------------------------------------------------------------------------------
// Dates and finish

function DatesCard({ ctx }: { ctx: CardCtx }) {
  const [initial] = useState(() => ctx.idea.dates ?? suggestDates(ctx.idea, new Date()));
  const [start, setStart] = useState(initial?.start ?? '');
  const [end, setEnd] = useState(initial?.end ?? '');
  const n = start && end ? dayCount(start, end) : undefined;
  const place = chosenPlace(ctx.idea);
  return (
    <Shell step="dates" ctx={ctx} lead={place ? `${place.name}${ctx.idea.days ? `，你說大約 ${ctx.idea.days} 天` : ''}` : undefined}>
      <form {...form(ctx, () => void ctx.run({ op: 'dates', start, end }))}>
        <div className="idea-row">
          <label className="idea-field idea-field--grow">
            <span>出發</span>
            <input type="date" value={start} onChange={(e) => setStart(e.target.value)} autoFocus />
          </label>
          <label className="idea-field idea-field--grow">
            <span>回來</span>
            <input type="date" value={end} min={start || undefined} onChange={(e) => setEnd(e.target.value)} />
          </label>
        </div>
        <p className="idea-note">{n ? `共 ${n} 天` : start && end ? '回來的日期要在出發之後' : initial ? '' : '填好兩個日期'}</p>
        <Next ctx={ctx} disabled={!n} label="確定" />
      </form>
    </Shell>
  );
}

function zones(extra: string): string[] {
  let list: string[] = [];
  try {
    list = Intl.supportedValuesOf('timeZone');
  } catch {
    /* old browser: only the place's own zone */
  }
  return list.includes(extra) ? list : [extra, ...list];
}

function FinishCard({ ctx }: { ctx: CardCtx }) {
  const { idea } = ctx;
  const place = chosenPlace(idea)!;
  const [title, setTitle] = useState(() => defaultTitle(idea));
  const [tz, setTz] = useState(place.tz);
  const [adults, setAdults] = useState(idea.party?.adults ?? 2);
  const [ages, setAges] = useState(idea.party?.childrenAges.join(', ') ?? '');
  const parsed = idea.party?.who === 'solo' ? [] : parseAges(ages);
  const n = idea.dates ? dayCount(idea.dates.start, idea.dates.end) : undefined;
  return (
    <Shell step="finish" ctx={ctx}>
      <div className="idea-summary">
        <strong>{place.name}</strong>
        <span>{placeMeta(place)}</span>
        {idea.dates && (
          <span>
            {idea.dates.start} ~ {idea.dates.end}
            {n ? `（${n} 天）` : ''}
          </span>
        )}
      </div>
      <form {...form(ctx, () => parsed && void ctx.finish({ title: title.trim(), tz, adults, childrenAges: parsed }))}>
        <label className="idea-field">
          <span>行程名稱</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
        </label>
        <label className="idea-field">
          <span>目的地時區</span>
          <select value={tz} onChange={(e) => setTz(e.target.value)}>
            {zones(place.tz).map((z) => (
              <option key={z}>{z}</option>
            ))}
          </select>
        </label>
        <PartyFields who={idea.party?.who ?? 'friends'} adults={adults} setAdults={setAdults} ages={ages} setAges={setAges} agesOk={parsed !== null} />
        <Next ctx={ctx} disabled={!title.trim() || parsed === null} label="建立行程" />
      </form>
    </Shell>
  );
}

export function IdeaCard({ step, ctx }: { step: CardStep; ctx: CardCtx }) {
  switch (step) {
    case 'known':
      return <KnownCard ctx={ctx} />;
    case 'origin':
      return <OriginCard ctx={ctx} />;
    case 'focus':
      return <FocusCard ctx={ctx} />;
    case 'budget':
      return <BudgetCard ctx={ctx} />;
    case 'scenery':
      return <SceneryCard ctx={ctx} />;
    case 'when':
      return <WhenCard ctx={ctx} />;
    case 'days':
      return <DaysCard ctx={ctx} />;
    case 'party':
      return <PartyCard ctx={ctx} />;
    case 'suggest':
      return <SuggestCard ctx={ctx} />;
    case 'choose':
      return <ChooseCard ctx={ctx} />;
    case 'locate':
      return <LocateCard ctx={ctx} />;
    case 'dates':
      return <DatesCard ctx={ctx} />;
    case 'finish':
      return <FinishCard ctx={ctx} />;
  }
}
