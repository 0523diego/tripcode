// `tripcode food suggest`: the AI has read the web about where to eat; this is where its answer is checked and turned into the
// cards on the user's screen. Nothing the AI says is taken on trust:
//   - the answer has a fixed shape (src/core/food-suggest.ts): at most 3 places, each with an address, why, what to order and the
//     pages it came from; a rating or a score is refused;
//   - each place's pages are fetched (public https only) and must carry the place's name, so a restaurant that exists only in the
//     AI's memory cannot get a card; a page that cannot be read at all is allowed but marked 「要自己確認」;
//   - the coordinates come from an OpenStreetMap name lookup (one small request per place, not an area search), within reach of
//     where the user will be; a place that cannot be found on a map is refused rather than pinned somewhere.
// Network, clock and trip loading are injected so tests never touch the network.
import { createHash } from 'node:crypto';
import { CliError } from './context.ts';
import { fetchPublicHttps, SafeFetchError } from './safe-fetch.ts';
import { photoForPlace, mealContext } from './food-service.ts';
import type { FoodDeps } from './food-service.ts';
import { updateFood } from './food-store.ts';
import { searchPlacesOsm, userAgentFor } from './osm.ts';
import { foldName, pageMentions, parseSuggestions } from '../src/core/food-suggest.ts';
import type { PlaceSuggestion } from '../src/core/food-suggest.ts';
import { FoodError, putPlace, putShortlist } from '../src/core/food.ts';
import type { Evidence, FoodPlace, ShortlistItem } from '../src/core/food-types.ts';
import { meters, walkMinutes } from '../src/core/food-find.ts';

const MAX_PAGE_BYTES = 1_500_000;
/** A restaurant the user is going to eat at is in the city they are in: farther than this from the meal's stop is a different place. */
const MAX_FROM_ANCHOR_M = 20_000;
const iso = (d: Date) => d.toISOString().replace(/\.\d+Z$/, 'Z');

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', agrave: 'à', egrave: 'è', eacute: 'é', igrave: 'ì', ograve: 'ò', ugrave: 'ù', aacute: 'á', iacute: 'í', oacute: 'ó', uacute: 'ú', ccedil: 'ç', ntilde: 'ñ', ouml: 'ö', uuml: 'ü', auml: 'ä' };

/** The readable text of an HTML page: no scripts, styles or tags; character references decoded. */
export function pageText(html: string): string {
  return html
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n: string) => ENTITIES[n.toLowerCase()] ?? m);
}

type PageVerdict = 'mentions' | 'missing' | 'unreadable';

async function checkPage(deps: FoodDeps, url: string, name: string): Promise<PageVerdict> {
  try {
    const res = await fetchPublicHttps(url, { maxBytes: MAX_PAGE_BYTES, accept: 'text/html,application/xhtml+xml', userAgent: userAgentFor(deps.root) }, deps.safe);
    if (!/html|xml|text/i.test(res.contentType) && res.contentType !== '') return 'unreadable';
    return pageMentions(pageText(new TextDecoder('utf-8', { fatal: false }).decode(res.bytes)), name) ? 'mentions' : 'missing';
  } catch (e) {
    if (e instanceof SafeFetchError) return 'unreadable';
    throw e;
  }
}

export interface SuggestArgs {
  file?: string | undefined;
  date: string;
  slot: 'lunch' | 'dinner';
  anchor?: string | undefined;
  /** The AI's answer: an array of places (see PlaceSuggestion). */
  places: unknown;
  /** 'wait' (the CLI) fetches the photos before answering; 'none' skips them. */
  photos?: 'wait' | 'none';
}

export interface SuggestOutput {
  date: string;
  slot: 'lunch' | 'dinner';
  anchor: { title: string };
  city: string | null;
  saved: { key: string; name: string; distanceM: number; walkMin: number; tier: 'likely' | 'check'; checked: string; photo: boolean }[];
  refused: { name: string; reason: string }[];
  note: string;
}

const digest = (name: string, city: string) => createHash('sha1').update(`${foldName(name)}|${foldName(city)}`).digest('hex').slice(0, 12);

const mapsSearchUrl = (name: string, city: string | undefined) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([name, city].filter(Boolean).join(' '))}`;

export async function suggestForTrip(deps: FoodDeps, tripId: string, args: SuggestArgs): Promise<SuggestOutput> {
  let suggestions: PlaceSuggestion[];
  try {
    suggestions = parseSuggestions(args.places);
  } catch (e) {
    if (e instanceof FoodError) throw new CliError(e.message);
    throw e;
  }
  const { anchor, food, city } = await mealContext(deps, tripId, args);
  const known = new Set(food.dishes.map((d) => d.id));
  for (const s of suggestions) {
    const bad = s.dishes.filter((d) => !known.has(d));
    if (bad.length > 0) throw new CliError(`「${s.name}」的 dishes 裡有不存在的菜：${bad.join('、')}（food show 看有哪些；這家不是為特定的菜，就給空陣列）`);
  }
  const fetchedAt = iso(deps.now());
  const rejected = new Set(food.rejected.map((r) => r.key));
  const refused: SuggestOutput['refused'] = [];
  const built: { place: FoodPlace; item: ShortlistItem; tier: 'likely' | 'check'; checked: string; website?: string }[] = [];
  const seen = new Set<string>();

  for (const s of suggestions) {
    const key = `web-${digest(s.name, city ?? '')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (rejected.has(key)) {
      refused.push({ name: s.name, reason: '使用者按過「不要這家」' });
      continue;
    }
    // 1. the pages must carry the name
    const verdicts: { url: string; verdict: PageVerdict }[] = [];
    for (const url of s.sources) verdicts.push({ url, verdict: await checkPage(deps, url, s.name) });
    const mentioning = verdicts.filter((v) => v.verdict === 'mentions');
    const readable = verdicts.filter((v) => v.verdict !== 'unreadable');
    if (mentioning.length === 0 && readable.length > 0) {
      refused.push({ name: s.name, reason: `來源網頁讀得到，但裡面找不到店名「${s.name}」：請換成真的寫到這家店的網頁，或確認店名拼法` });
      continue;
    }
    // 2. the coordinates, from a name lookup near where the user will be
    let loc: { lat: number; lng: number } | undefined;
    for (const q of [`${s.name}, ${s.address}`, s.address]) {
      const found = await searchPlacesOsm({ fetch: deps.fetch, now: deps.now, userAgent: userAgentFor(deps.root), ...(deps.throttle ? { throttle: deps.throttle } : {}) }, q, { near: anchor.loc }).catch(() => undefined);
      const hit = found?.results.find((r) => r.loc && meters(anchor.loc, r.loc) <= MAX_FROM_ANCHOR_M);
      if (hit?.loc) {
        loc = { lat: hit.loc.lat, lng: hit.loc.lng };
        break;
      }
    }
    if (!loc) {
      refused.push({ name: s.name, reason: `地圖上查不到「${s.address}」（或離這一餐的起點超過 ${MAX_FROM_ANCHOR_M / 1000} 公里）：請給完整的街名門牌，或換一家` });
      continue;
    }
    const verified = mentioning.length > 0;
    const evidence: Evidence[] = (verified ? mentioning : verdicts.slice(0, 1)).map((v) => ({
      kind: 'web' as const,
      claim: 'exists' as const,
      source: v.url,
      fetchedAt,
      confidence: verified ? ('recent' as const) : ('reference' as const),
      detail: verified ? '網頁裡寫到這家店' : '網頁沒能自動核對',
    }));
    const prior = food.places.find((p) => p.key === key);
    const distanceM = Math.round(meters(anchor.loc, loc));
    const place: FoodPlace = {
      key,
      name: s.name,
      ...(s.nameZh ? { nameLocal: s.nameZh } : {}),
      loc: { lat: loc.lat, lng: loc.lng, fetchedAt },
      city: city ?? '未知',
      dishes: s.dishes,
      evidence,
      profile: { summary: s.summary, ...(s.order.length ? { order: s.order } : {}), ...(s.price ? { price: s.price } : {}), ...(s.watch ? { watch: s.watch } : {}), sources: s.sources, fetchedAt },
      ...(prior?.photo ? { photo: prior.photo } : {}),
    };
    const tier = verified ? 'likely' : 'check';
    built.push({
      place,
      tier,
      checked: verified ? `${mentioning.length}/${s.sources.length} 個來源網頁寫到店名` : '來源網頁沒能自動讀取，要自己確認',
      ...(s.website ? { website: s.website } : {}),
      item: {
        key,
        distanceM,
        walkMin: walkMinutes(distanceM),
        tier,
        why: s.dishes.map((d) => food.dishes.find((x) => x.id === d)?.nameZh).filter((x): x is string => !!x).slice(0, 4),
        flags: [],
        open: 'unknown',
        ...(s.hours ? { hours: s.hours } : {}),
        ...(s.website ? { website: s.website } : {}),
        mapsUrl: mapsSearchUrl(s.name, city),
      },
    });
  }

  if (built.length === 0) throw new CliError(`沒有一家可以收：\n${refused.map((r) => `- ${r.name}：${r.reason}`).join('\n')}`);

  await updateFood(deps.root, tripId, (f) => {
    let next = f;
    for (const b of built) next = putPlace(next, b.place);
    return putShortlist(next, { at: fetchedAt, date: args.date, slot: args.slot, anchor: anchor.title.slice(0, 120), ...(city ? { city } : {}), items: built.map((b) => b.item) });
  });

  // The place's own picture, from its own website (best effort: no picture is fine).
  const photoOk = new Set<string>();
  if (args.photos !== 'none') {
    for (const b of built) {
      const site = b.website ?? undefined;
      if (!site || b.place.photo) {
        if (b.place.photo) photoOk.add(b.place.key);
        continue;
      }
      try {
        await photoForPlace({ root: deps.root, now: deps.now, ...(deps.safe ?? {}) }, tripId, { place: b.place.key, pageUrl: site });
        photoOk.add(b.place.key);
      } catch {
        /* no picture for this one */
      }
    }
  }

  return {
    date: args.date,
    slot: args.slot,
    anchor: { title: anchor.title },
    city: city ?? null,
    saved: built.map((b) => ({ key: b.place.key, name: b.place.name, distanceM: b.item.distanceM, walkMin: b.item.walkMin, tier: b.tier, checked: b.checked, photo: photoOk.has(b.place.key) })),
    refused,
    note: '卡片已經出現在使用者的畫面上。沒有評分：請使用者按卡片上的 Google 地圖連結看。營業時間以網頁寫的為準，要使用者出發前確認。',
  };
}
