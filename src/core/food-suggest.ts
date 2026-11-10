// The fixed shape of what the AI hands back when it has looked up where to eat (`tripcode food suggest`). The AI reads the web and
// writes these fields; this file decides what is an acceptable answer, so a reply that is vague, rated, or has no page behind it
// is refused before anything reaches the user's screen. Pure: no network, no clock.
import { FoodError } from './food.ts';

export interface PlaceSuggestion {
  /** The name on the door, in the language of the place ("Trattoria Milanese"). */
  name: string;
  /** What to call it in Chinese, when it has an established one. */
  nameZh?: string;
  /** Street address as the pages give it ("Via Santa Marta 11, Milano"). Used to find the coordinates: no address, no card. */
  address: string;
  /** Ids of the dishes (from `food show`) this place is recommended for. */
  dishes: string[];
  /** One or two sentences: what kind of place it is and why it suits this meal. Our own words. */
  summary: string;
  /** What to order, as the pages say (up to 5). */
  order: string[];
  /** A price only if a page states it ("主菜約 €15–25"). */
  price?: string;
  /** What to know before going (a queue, cash only, closes early). */
  watch?: string;
  /** Opening hours exactly as a page writes them; shown as the page's claim, never checked against the clock. */
  hours?: string;
  /** The place's own website (https), whose picture the card uses. */
  website?: string;
  /** Pages the AI actually read about this place (1 to 3, https). The name must appear on at least one. */
  sources: string[];
}

export const MAX_SUGGESTIONS = 3;

const FIELDS = ['name', 'nameZh', 'address', 'dishes', 'summary', 'order', 'price', 'watch', 'hours', 'website', 'sources'];
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** A line that carries a rating or a score: never stored (Google's terms), and never smuggled in through our own words. */
const RATING_LIKE = /[★☆]|\d\s*[.,]\s*\d\s*(?:\/\s*\d+|分|stars?|星)|評分|分數|\bstars?\b|\d\s*\/\s*(?:5|10)\b|\d+\s*(?:則評論|reviews?)/i;

function text(v: unknown, where: string, max: number): string {
  if (typeof v !== 'string') throw new FoodError(`${where} 必須是文字`);
  const t = v.replace(/\s+/g, ' ').trim();
  if (t === '' || t.length > max) throw new FoodError(`${where} 要有內容，且不超過 ${max} 字`);
  return t;
}

/** Our own words: no rating or score. */
function words(v: unknown, where: string, max: number): string {
  const t = text(v, where, max);
  if (RATING_LIKE.test(t)) throw new FoodError(`${where}：不要寫評分、星等或評論數（這裡查不到可以核對的來源）`);
  return t;
}

function https(v: unknown, where: string): string {
  const u = text(v, where, 300);
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    throw new FoodError(`${where} 不是網址`);
  }
  if (parsed.protocol !== 'https:') throw new FoodError(`${where} 只接受 https 網址`);
  return parsed.toString();
}

export function parseSuggestion(v: unknown, where = 'place'): PlaceSuggestion {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new FoodError(`${where} 必須是物件`);
  const r = v as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!FIELDS.includes(k)) throw new FoodError(`${where} 有不認得的欄位：${k}（可用：${FIELDS.join('、')}）`);
  const list = (x: unknown, w: string, max: number, min: number): unknown[] => {
    if (!Array.isArray(x)) throw new FoodError(`${w} 必須是陣列`);
    if (x.length > max) throw new FoodError(`${w} 最多 ${max} 個`);
    if (x.length < min) throw new FoodError(`${w} 至少要 ${min} 個`);
    return x;
  };
  const sources = [...new Set(list(r.sources, `${where}.sources`, 3, 1).map((s, i) => https(s, `${where}.sources[${i}]`)))];
  return {
    name: text(r.name, `${where}.name`, 120),
    ...(r.nameZh !== undefined ? { nameZh: words(r.nameZh, `${where}.nameZh`, 60) } : {}),
    address: text(r.address, `${where}.address`, 200),
    dishes: [...new Set(list(r.dishes ?? [], `${where}.dishes`, 6, 0).map((d) => {
      if (typeof d !== 'string' || !ID_RE.test(d)) throw new FoodError(`${where}.dishes 要是菜的 id（food show 看得到）`);
      return d;
    }))],
    summary: words(r.summary, `${where}.summary`, 160),
    order: list(r.order ?? [], `${where}.order`, 5, 0).map((o, i) => words(o, `${where}.order[${i}]`, 40)),
    ...(r.price !== undefined ? { price: text(r.price, `${where}.price`, 40) } : {}),
    ...(r.watch !== undefined ? { watch: words(r.watch, `${where}.watch`, 120) } : {}),
    ...(r.hours !== undefined ? { hours: text(r.hours, `${where}.hours`, 200) } : {}),
    ...(r.website !== undefined ? { website: https(r.website, `${where}.website`) } : {}),
    sources,
  };
}

export function parseSuggestions(raw: unknown): PlaceSuggestion[] {
  if (!Array.isArray(raw)) throw new FoodError('要給一個陣列：[{店 1}, {店 2}, {店 3}]');
  if (raw.length === 0) throw new FoodError('至少要有一家店；找不到就直接告訴使用者找不到，不要硬湊');
  if (raw.length > MAX_SUGGESTIONS) throw new FoodError(`最多 ${MAX_SUGGESTIONS} 家：選最適合的，不要列一長串`);
  return raw.map((p, i) => parseSuggestion(p, `places[${i}]`));
}

/** Lower-case, accent-free, letters and digits only: how a name is compared with the text of a page. */
export function foldName(s: string): string {
  return s.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().replace(/&amp;|&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Does the page's text carry this place's name? (Whitespace, accents, case and punctuation do not matter.) */
export function pageMentions(pageText: string, name: string): boolean {
  const want = foldName(name);
  if (want.length < 3) return false;
  return foldName(pageText).includes(want);
}
