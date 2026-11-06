// Pure view logic for the step-0 page (#/idea/<id>): which card to show, the globe pins, default values and the
// prompts sent to the AI panel. No React here so it can be tested with node:test.
import { chosenPlace, ideaSummaryItems, nextStep, roundPlaces, whenText } from '../../core/idea.ts';
import type { Idea, IdeaParty, IdeaPlace, IdeaStep, SummaryItem, Who } from '../../core/idea.ts';

/** Every question card plus the non-question ones. `done` has no card: the page goes to the trip instead. */
export type CardStep = Exclude<IdeaStep, 'done'>;

/** The agent context for this page (src/agent/types.ts AgentTurnContext). */
export function ideaAgentContext(id: string): { tripId: string; tripTitle: string; idea: true } {
  return { tripId: id, tripTitle: '找方向', idea: true };
}

export const AGENT_LABEL = '找方向';

export const SUGGEST_PROMPT = '照 find-destination，根據我的回答給我 3 個點子。';
export const MORE_PROMPT = '這幾個都不要，照 find-destination 再給我 3 個不一樣的。';
export const LOCATE_PROMPT = '照 find-destination 把我說的目的地放到地球上。';

/** Steps whose card is a question (they get 「不知道／跳過」). */
const QUESTIONS: ReadonlySet<IdeaStep> = new Set(['known', 'origin', 'focus', 'budget', 'scenery', 'when', 'days', 'party']);
/** From `focus` on the user may say 「直接推薦」 (the file refuses it before known and origin are answered). */
const WANT_NOW_FROM: readonly IdeaStep[] = ['focus', 'budget', 'scenery', 'when', 'days', 'party'];

export const isQuestion = (step: IdeaStep): boolean => QUESTIONS.has(step);
export const canWantNow = (step: IdeaStep): boolean => WANT_NOW_FROM.includes(step);

/**
 * The card to show. `reopened` is a step the user went back to by clicking a chip; it wins over the computed
 * next step until they answer (the page then clears it). `done` never has a card.
 */
export function cardFor(idea: Idea, reopened: CardStep | null): CardStep | 'done' {
  const next = nextStep(idea);
  if (next === 'done') return 'done';
  return reopened ?? next;
}

/**
 * Where a chip leads, or null when the answer should not be changed from here. Once places exist, the destination
 * answer is fixed (changing it would leave the old places and the chosen one behind); a chosen place on the known
 * path is just the typed destination.
 */
export function chipTarget(idea: Idea, item: SummaryItem): CardStep | null {
  const step = item.step;
  if (step === 'done') return null;
  if (step === 'known' && idea.places.length > 0) return null;
  if (step === 'choose' && idea.known?.decided) return null;
  // 「直接推薦」 chip: undoing it is answering wantNow false, which the focus card offers; the card is the same.
  return step;
}

export interface ChipView {
  key: string;
  text: string;
  target: CardStep | null;
}

export function chipsFor(idea: Idea): ChipView[] {
  return ideaSummaryItems(idea).map((item, i) => ({ key: `${item.step}-${i}`, text: item.text, target: chipTarget(idea, item) }));
}

// ---------------------------------------------------------------------------------------------
// Globe

export interface PinView {
  id: string;
  label: string;
  lat: number;
  lng: number;
  state: 'normal' | 'active' | 'dim';
}

/** Places of the latest round that were not turned down (the chosen one is always there). `hoverId` is the card under the pointer. */
export function pinPlaces(idea: Idea): IdeaPlace[] {
  const shown = roundPlaces(idea).filter((p) => p.status !== 'rejected');
  const chosen = chosenPlace(idea);
  if (chosen && !shown.some((p) => p.id === chosen.id)) shown.unshift(chosen);
  return shown;
}

/** The hovered card only counts while its place is still on the globe (a rejected card unmounts without a pointerleave). */
function liveHover(idea: Idea, hoverId: string | null): string | null {
  return hoverId && pinPlaces(idea).some((p) => p.id === hoverId) ? hoverId : null;
}

export function ideaPins(idea: Idea, hoverId: string | null): PinView[] {
  const chosen = chosenPlace(idea);
  const focusId = liveHover(idea, hoverId) ?? chosen?.id ?? null;
  return pinPlaces(idea).map((p) => ({
    id: p.id,
    label: p.name,
    lat: p.lat,
    lng: p.lng,
    state: focusId === null ? 'normal' : p.id === focusId ? 'active' : 'dim',
  }));
}

/** Where the globe looks: the hovered card, else the chosen place, else nowhere (it keeps turning). */
export function ideaFocus(idea: Idea, hoverId: string | null): { lat: number; lng: number } | null {
  const hovered = liveHover(idea, hoverId);
  const place = (hovered ? idea.places.find((p) => p.id === hovered) : undefined) ?? chosenPlace(idea);
  return place ? { lat: place.lat, lng: place.lng } : null;
}

// ---------------------------------------------------------------------------------------------
// Defaults and parsing for the cards

/** Adults prefilled from 「跟誰去」. */
export function adultsFor(who: Who): number {
  switch (who) {
    case 'solo':
      return 1;
    case 'partner':
      return 2;
    case 'friends':
      return 3;
    case 'family':
      return 2;
    case 'parents':
      return 3;
  }
}

export function defaultParty(who: Who): IdeaParty {
  return { who, adults: adultsFor(who), childrenAges: [] };
}

/** "5, 8" / "5、8" / "" -> [5, 8] / []; null when something is not an age 0–17. */
export function parseAges(text: string): number[] | null {
  const parts = text.split(/[\s,，、]+/).filter(Boolean);
  const ages: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,2}$/.test(part)) return null;
    const n = Number(part);
    if (n > 17) return null;
    ages.push(n);
  }
  return ages;
}

/** Inclusive number of days between two YYYY-MM-DD dates; undefined for bad or reversed input. */
export function dayCount(start: string, end: string): number | undefined {
  const s = Date.parse(`${start}T00:00:00Z`);
  const e = Date.parse(`${end}T00:00:00Z`);
  if (Number.isNaN(s) || Number.isNaN(e) || e < s) return undefined;
  return Math.round((e - s) / 86_400_000) + 1;
}

/** 「瑞士 5 天」; without dates just the name. */
export function defaultTitle(idea: Idea): string {
  const place = chosenPlace(idea);
  if (!place) return '';
  const n = idea.dates ? dayCount(idea.dates.start, idea.dates.end) : undefined;
  return n ? `${place.name} ${n} 天` : place.name;
}

export const CURRENCIES = ['TWD', 'JPY', 'USD', 'EUR', 'HKD', 'KRW', 'CNY', 'GBP'] as const;
export const DAY_CHOICES = [3, 5, 7, 10, 14] as const;

// ---------------------------------------------------------------------------------------------
// Place cards

/** 「最適合：6–8 月」, or undefined when the AI gave no months. */
export function bestMonthsText(place: IdeaPlace): string | undefined {
  return place.bestMonths && place.bestMonths.length ? `最適合：${whenText({ months: place.bestMonths })}` : undefined;
}

export interface CostView {
  text: string;
  /** No source: shown with a small 「估計」 badge. */
  estimate: boolean;
  source?: string;
}

export function costView(place: IdeaPlace): CostView | undefined {
  const c = place.cost;
  if (!c) return undefined;
  // The badge already says 估計, so a trailing 「（估計）」 written by the AI is not repeated next to it.
  const text = c.source ? c.text : c.text.replace(/\s*[（(]?\s*估計\s*[）)]?\s*$/, '').trim() || c.text;
  return { text, estimate: !c.source, ...(c.source ? { source: c.source } : {}) };
}

const KIND_LABEL = { country: '國家', region: '地區', city: '城市' } as const;

/** 「地區 · 義大利」 */
export function placeMeta(place: IdeaPlace): string {
  return [KIND_LABEL[place.kind], place.country].filter(Boolean).join(' · ');
}

/** A source is only linked when it is an http(s) URL; anything else is shown as text. */
export function safeHref(source: string): string | undefined {
  try {
    const u = new URL(source);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/** A new idea id: `idea-<yyyymmdd>-<4 random base36>`. */
export function newIdeaId(now: Date, random: () => number = Math.random): string {
  const d = now.toISOString().slice(0, 10).replaceAll('-', '');
  let r = '';
  for (let i = 0; i < 4; i++) r += Math.floor(random() * 36).toString(36);
  return `idea-${d}-${r}`;
}
