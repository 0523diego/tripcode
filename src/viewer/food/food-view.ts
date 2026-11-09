// The words and small decisions of the 這餐吃什麼 drawer, kept out of the component so they can be tested: what each badge says, how a
// place's tier is named, which taste chips exist. Every badge says where the claim comes from; a claim with no source is not shown.
import type { Dish, FoodFile, ShortlistBatch } from '../../core/food-types.ts';
import type { MealChecks, Sourced } from '../../core/types.ts';
import { aiOnly } from '../../core/food.ts';
import type { NearOutput } from '../../../cli/food-service.ts';

export type NearResult = NearOutput['results'][number];
export type Tone = 'good' | 'neutral' | 'warn';
export interface Badge {
  tone: Tone;
  text: string;
}

export const TIER_LABEL: Record<NearResult['tier'], string> = { safe: '可以放心', likely: '大致可以', check: '要自己確認' };

/** What the drawer says about a dish's source. */
export function dishBadge(dish: Dish): Badge {
  if (aiOnly(dish)) return { tone: 'warn', text: 'AI 的印象，尚未查證' };
  const wv = dish.sources.find((s) => s.kind === 'wikivoyage');
  if (wv) return { tone: 'neutral', text: `Wikivoyage 指南列的${wv.revision ? `（版本 ${wv.revision}）` : ''}` };
  const web = dish.sources.find((s) => s.kind === 'web' || s.kind === 'michelin');
  if (web) return { tone: 'neutral', text: `${web.title ?? '網頁'}提到` };
  return { tone: 'neutral', text: '你自己加的' };
}

/** The badges under a place: existence, opening hours at the meal, how the dish was matched, and the warnings. Nothing about a rating: there is none. */
export function placeBadges(r: NearResult, generalMode: boolean, opts: { skipDishBadge?: boolean } = {}): Badge[] {
  const out: Badge[] = [{ tone: 'good', text: '已在地圖確認存在（OpenStreetMap）' }];
  const guide = r.evidence.find((e) => (e as { kind?: string }).kind === 'guide-wikivoyage') as { detail?: string } | undefined;
  if (guide) out.push({ tone: 'good', text: guide.detail ?? 'Wikivoyage 指南推薦' });
  if (r.open === 'open') out.push({ tone: 'good', text: `用餐時間有營業${r.hours ? `（OSM：${r.hours}）` : ''}` });
  else out.push({ tone: 'warn', text: r.hours ? `營業時間格式看不懂（OSM：${r.hours}），先查再去` : '營業時間沒寫，先查再去' });
  if (opts.skipDishBadge) {
    // The board has no dish match to show.
  } else if (!generalMode) {
    const how = r.matches[0]?.how;
    if (how === 'name') out.push({ tone: 'good', text: '店名就是這道菜' });
    else if (how === 'cuisine') out.push({ tone: 'neutral', text: '地圖標的菜系對得上' });
    else if (how === 'venue-word') out.push({ tone: 'warn', text: '只是這類傳統餐館，不確定有這道菜' });
  } else {
    out.push({ tone: 'warn', text: '無法確認有沒有這道菜' });
  }
  const evidenceDate = r.evidence.find((e) => (e as { detail?: string }).detail?.startsWith('OSM 資料檢查日')) as { detail?: string } | undefined;
  if (evidenceDate?.detail) out.push({ tone: 'neutral', text: evidenceDate.detail });
  if (r.flags.includes('fast-food')) out.push({ tone: 'warn', text: '快餐店' });
  if (r.flags.includes('chain')) out.push({ tone: 'warn', text: '連鎖店' });
  if (r.flags.includes('near-landmark')) out.push({ tone: 'neutral', text: '就在景點旁，常常比較觀光' });
  out.push({ tone: 'neutral', text: '沒有評分資料：到 Google 地圖看' });
  return out;
}

/** Quick taste chips: what the traveller can avoid with one tap. */
export const AVOID_CHIPS: { tag: string; label: string }[] = [
  { tag: 'pork', label: '豬' },
  { tag: 'beef', label: '牛' },
  { tag: 'seafood', label: '海鮮' },
  { tag: 'raw', label: '生食' },
  { tag: 'offal', label: '內臟' },
  { tag: 'spicy', label: '辣' },
];

/** The text for a country's Wikivoyage page when the city's name is the Chinese one: a small table of common destinations, never a guess beyond it. */
const WIKIVOYAGE_TITLES: Record<string, string> = {
  羅馬: 'Rome', 米蘭: 'Milan', 佛羅倫斯: 'Florence', 威尼斯: 'Venice', 那不勒斯: 'Naples', 巴黎: 'Paris', 倫敦: 'London', 巴塞隆納: 'Barcelona', 馬德里: 'Madrid',
  里斯本: 'Lisbon', 波爾圖: 'Porto', 阿姆斯特丹: 'Amsterdam', 布拉格: 'Prague', 維也納: 'Vienna', 布達佩斯: 'Budapest', 柏林: 'Berlin', 慕尼黑: 'Munich',
  東京: 'Tokyo', 京都: 'Kyoto', 大阪: 'Osaka', 札幌: 'Sapporo', 福岡: 'Fukuoka', 首爾: 'Seoul', 釜山: 'Busan', 台北: 'Taipei', 台南: 'Tainan', 高雄: 'Kaohsiung',
  曼谷: 'Bangkok', 清邁: 'Chiang Mai', 河內: 'Hanoi', 胡志明市: 'Ho Chi Minh City', 新加坡: 'Singapore', 香港: 'Hong Kong', 蘇黎世: 'Zurich', 琉森: 'Lucerne',
};

export function guessWikivoyagePage(city: string | undefined): string {
  return (city && WIKIVOYAGE_TITLES[city.trim()]) || '';
}

// ---------- dish cards ----------

const TAG_LABEL: Record<string, string> = {
  pork: '豬肉', beef: '牛肉', offal: '內臟', seafood: '海鮮', raw: '生食', pasta: '麵食', noodle: '麵', 'street-food': '路邊小吃', dessert: '甜點', spicy: '辣', 'vegetarian-ok': '可以吃素',
};

export const tagLabels = (dish: Dish): string[] => dish.tags.map((t) => TAG_LABEL[t]).filter((x): x is string => !!x);

/** The one-line reason, unless it is the stock sentence a Wikivoyage seed gets (then the tags say more than a repeated sentence does). */
export const reasonText = (dish: Dish): string | undefined => (/的 Wikivoyage 指南把它列為值得吃的在地料理$/.test(dish.why) ? undefined : dish.why);

// ---------- what was checked about the chosen place ----------

export interface ProofLine {
  text: string;
  href?: string;
}

const where = (source: string): string => {
  if (source.startsWith('osm:')) return 'OpenStreetMap';
  try {
    return new URL(source).hostname.replace(/^www\./, '');
  } catch {
    return source;
  }
};
const day = (s: Sourced<unknown>) => s.fetchedAt.slice(0, 10);

/** The facts a meal's `checks` hold, each with where and when. A claim with no source is not a line. */
export function proofLines(checks: MealChecks | undefined): ProofLine[] {
  const out: ProofLine[] = [];
  if (checks?.exists?.value === true && checks.exists.source) out.push({ text: `已在地圖確認存在（${where(checks.exists.source)}，${day(checks.exists)}）` });
  if (checks?.openAtSlot?.value === true && checks.openAtSlot.source) out.push({ text: `用餐時間有營業（${where(checks.openAtSlot.source)}，${day(checks.openAtSlot)}）` });
  for (const r of checks?.recommendedBy ?? []) if (/^https:\/\//.test(r.source)) out.push({ text: `${r.value}（${where(r.source)}，${day(r)}）`, href: r.source });
  return out;
}

/** Fills in the photo and介紹 the guide holds for this place now (a search result may be older than the picture that was fetched after it). */
export function photoFromFood(r: NearResult, food: FoodFile | null, tripId: string): NearResult {
  const known = food?.places.find((p) => p.key === r.key || p.alsoKeys?.includes(r.key));
  if (!known) return r;
  return {
    ...r,
    ...(!r.profile && known.profile ? { profile: known.profile } : {}),
    ...(!r.photo && known.photo ? { photo: { path: `trips/${tripId}/${known.photo.file}`, pageUrl: known.photo.pageUrl } } : {}),
  };
}

/** What the board shows for the newest search: each place as a card, the ones the AI wrote about first. Places the guide no longer has, ones the user rejected, and fast food are left out. */
export function boardResults(food: FoodFile, batch: ShortlistBatch, tripId: string): NearResult[] {
  const out: NearResult[] = [];
  for (const item of batch.items) {
    const place = food.places.find((p) => p.key === item.key);
    if (!place || food.rejected.some((x) => x.key === place.key)) continue;
    // Fast food is not a recommendation: it stays out of the board (the drawer still lists it, last, with a badge).
    if (item.flags.includes('fast-food') && !place.profile) continue;
    out.push({
      key: place.key,
      name: place.name,
      loc: place.loc,
      distanceM: item.distanceM,
      walkMin: item.walkMin,
      tier: item.tier,
      score: 0,
      why: item.why,
      flags: item.flags,
      open: item.open,
      ...(item.hours ? { hours: item.hours } : {}),
      ...(item.website ? { website: item.website } : {}),
      matches: [],
      mapsUrl: item.mapsUrl,
      evidence: place.evidence,
      ...(place.profile ? { profile: place.profile } : {}),
      ...(place.photo ? { photo: { path: `trips/${tripId}/${place.photo.file}`, pageUrl: place.photo.pageUrl } } : {}),
    });
  }
  return out.sort((a, b) => Number(!!b.profile) - Number(!!a.profile));
}

/** The few chips a card shows up front; the sources and dates behind them are in `placeBadges` (the card's details). */
export function chipBadges(r: NearResult): Badge[] {
  const out: Badge[] = [{ tone: 'good', text: '地圖確認有這家店' }];
  const guide = r.evidence.some((e) => (e as { kind?: string }).kind === 'guide-wikivoyage');
  if (guide) out.push({ tone: 'good', text: '旅遊指南推薦' });
  out.push(r.open === 'open' ? { tone: 'good', text: '用餐時間有營業' } : { tone: 'warn', text: '營業時間要先確認' });
  if (r.flags.includes('fast-food')) out.push({ tone: 'warn', text: '快餐店' });
  else if (r.flags.includes('chain')) out.push({ tone: 'warn', text: '連鎖店' });
  if (r.flags.includes('near-landmark')) out.push({ tone: 'neutral', text: '在景點旁，偏觀光' });
  return out;
}
