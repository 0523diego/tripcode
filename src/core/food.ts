// Pure operations on a trip's food file (see food-types.ts). Like idea.ts: every operation returns a NEW file and ends in
// parseFood, so whatever comes out is valid; errors are FoodError with a Traditional Chinese message; unknown keys are rejected.
import { DIETS, MEAL_SLOTS, REJECT_REASONS } from './food-types.ts';
import type { Dish, Diet, Evidence, FoodFile, FoodPlace, FoodSource, GuideListing, MealSlot, PlacePhoto, PlaceProfile, RejectReason, ShortlistBatch, ShortlistItem, Taste } from './food-types.ts';

export class FoodError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FoodError';
  }
}

export const DEFAULT_WALK_MIN = 10;

export function emptyFood(): FoodFile {
  return { version: 1, taste: { avoidDishes: [], avoidTags: [], likeTags: [], diet: [] }, dishes: [], votes: {}, places: [], shortlist: [], listings: [], rejected: [], attribution: [] };
}

// ---------- validation ----------

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const TAG_RE = /^[a-z][a-z0-9-]{0,23}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const SOURCE_KINDS: FoodSource['kind'][] = ['wikivoyage', 'wikipedia', 'web', 'michelin', 'ai', 'user'];
const EVIDENCE_KINDS: Evidence['kind'][] = ['map-osm', 'map-google', 'guide-wikivoyage', 'web', 'michelin', 'user-link', 'ai-memory'];
const CLAIMS: Evidence['claim'][] = ['exists', 'open-at-slot', 'closed-at-slot', 'recommended', 'serves-dish', 'permanently-closed'];

type Rec = Record<string, unknown>;

function rec(v: unknown, where: string, allowed: string[]): Rec {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new FoodError(`${where} 必須是物件`);
  for (const k of Object.keys(v as Rec)) if (!allowed.includes(k)) throw new FoodError(`${where} 有不認得的欄位：${k}`);
  return v as Rec;
}

function str(v: unknown, where: string, max: number, opts: { optional?: boolean } = {}): string | undefined {
  if (v === undefined && opts.optional) return undefined;
  if (typeof v !== 'string') throw new FoodError(`${where} 必須是文字`);
  const t = v.replace(/\s+/g, ' ').trim();
  if (t === '' || t.length > max) throw new FoodError(`${where} 要有內容，且不超過 ${max} 字`);
  return t;
}

function list<T>(v: unknown, where: string, max: number, each: (x: unknown, i: number) => T): T[] {
  if (!Array.isArray(v)) throw new FoodError(`${where} 必須是陣列`);
  if (v.length > max) throw new FoodError(`${where} 最多 ${max} 個`);
  return v.map(each);
}

const tagList = (v: unknown, where: string): string[] => [...new Set(list(v, where, 12, (x) => {
  if (typeof x !== 'string' || !TAG_RE.test(x)) throw new FoodError(`${where} 的標籤要是小寫英文（可加 -）：${String(x)}`);
  return x;
}))];

function httpsUrl(v: unknown, where: string): string {
  const u = str(v, where, 300)!;
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    throw new FoodError(`${where} 不是網址`);
  }
  if (parsed.protocol !== 'https:') throw new FoodError(`${where} 只接受 https 網址`);
  return parsed.toString();
}

function iso(v: unknown, where: string): string {
  if (typeof v !== 'string' || !ISO_RE.test(v)) throw new FoodError(`${where} 必須是 ISO 時間（2026-11-07T12:00:00Z）`);
  return v;
}

export function parseSource(v: unknown, where = 'source'): FoodSource {
  const r = rec(v, where, ['kind', 'url', 'title', 'revision', 'fetchedAt']);
  if (!SOURCE_KINDS.includes(r.kind as FoodSource['kind'])) throw new FoodError(`${where}.kind 要是 ${SOURCE_KINDS.join('、')} 之一`);
  const kind = r.kind as FoodSource['kind'];
  if (kind === 'ai' && r.url !== undefined) throw new FoodError('AI 自己的印象不能附網址（附了網址就要用 web 之類的來源）');
  if (kind !== 'ai' && kind !== 'user' && r.url === undefined) throw new FoodError(`${where}.url：${kind} 來源一定要有網址`);
  return {
    kind,
    ...(r.url !== undefined ? { url: httpsUrl(r.url, `${where}.url`) } : {}),
    ...(r.title !== undefined ? { title: str(r.title, `${where}.title`, 120)! } : {}),
    ...(r.revision !== undefined ? { revision: str(r.revision, `${where}.revision`, 40)! } : {}),
    fetchedAt: iso(r.fetchedAt, `${where}.fetchedAt`),
  };
}

export function parseDish(v: unknown, where = 'dish'): Dish {
  const r = rec(v, where, ['id', 'city', 'nameZh', 'nameLocal', 'romanized', 'why', 'howTo', 'slots', 'tags', 'match', 'sources']);
  const id = str(r.id, `${where}.id`, 40)!;
  if (!ID_RE.test(id)) throw new FoodError(`${where}.id 要是小寫英數與 -：${id}`);
  const m = rec(r.match, `${where}.match`, ['names', 'cuisines', 'venueWords']);
  const words = (x: unknown, w: string) => list(x, w, 10, (s, i) => str(s, `${w}[${i}]`, 40)!);
  return {
    id,
    city: str(r.city, `${where}.city`, 40)!,
    nameZh: str(r.nameZh, `${where}.nameZh`, 40)!,
    nameLocal: str(r.nameLocal, `${where}.nameLocal`, 80)!,
    ...(r.romanized !== undefined ? { romanized: str(r.romanized, `${where}.romanized`, 80)! } : {}),
    why: str(r.why, `${where}.why`, 200)!,
    ...(r.howTo !== undefined ? { howTo: str(r.howTo, `${where}.howTo`, 200)! } : {}),
    ...(r.slots !== undefined
      ? { slots: [...new Set(list(r.slots, `${where}.slots`, 4, (s) => {
          if (!MEAL_SLOTS.includes(s as MealSlot)) throw new FoodError(`${where}.slots 只能是 ${MEAL_SLOTS.join('、')}`);
          return s as MealSlot;
        }))] }
      : {}),
    tags: tagList(r.tags ?? [], `${where}.tags`),
    match: {
      names: words(m.names ?? [], `${where}.match.names`),
      ...(m.cuisines !== undefined ? { cuisines: words(m.cuisines, `${where}.match.cuisines`) } : {}),
      ...(m.venueWords !== undefined ? { venueWords: words(m.venueWords, `${where}.match.venueWords`) } : {}),
    },
    sources: (() => {
      const s = list(r.sources, `${where}.sources`, 6, (x, i) => parseSource(x, `${where}.sources[${i}]`));
      if (s.length === 0) throw new FoodError(`${where}.sources 至少要有一個來源（AI 的印象也要標成 ai）`);
      return s;
    })(),
  };
}

export function parseTaste(v: unknown): Taste {
  const r = rec(v, 'taste', ['avoidDishes', 'avoidTags', 'likeTags', 'diet', 'allergies', 'budget', 'queue', 'kids', 'maxWalkMin']);
  const budget = r.budget;
  if (budget !== undefined && budget !== 'low' && budget !== 'mid' && budget !== 'high') throw new FoodError('taste.budget 要是 low、mid 或 high');
  const queue = r.queue;
  if (queue !== undefined && queue !== 'no' && queue !== 'short' && queue !== 'ok') throw new FoodError('taste.queue 要是 no、short 或 ok');
  if (r.kids !== undefined && typeof r.kids !== 'boolean') throw new FoodError('taste.kids 要是 true 或 false');
  if (r.maxWalkMin !== undefined && (!Number.isInteger(r.maxWalkMin) || (r.maxWalkMin as number) < 3 || (r.maxWalkMin as number) > 40)) throw new FoodError('taste.maxWalkMin 要是 3 到 40 的整數（分鐘）');
  return {
    avoidDishes: [...new Set(list(r.avoidDishes ?? [], 'taste.avoidDishes', 60, (x) => {
      if (typeof x !== 'string' || !ID_RE.test(x)) throw new FoodError('taste.avoidDishes 要是菜的 id');
      return x;
    }))],
    avoidTags: tagList(r.avoidTags ?? [], 'taste.avoidTags'),
    likeTags: tagList(r.likeTags ?? [], 'taste.likeTags'),
    diet: [...new Set(list(r.diet ?? [], 'taste.diet', 7, (x) => {
      if (!DIETS.includes(x as Diet)) throw new FoodError(`taste.diet 只能是 ${DIETS.join('、')}`);
      return x as Diet;
    }))],
    ...(r.allergies !== undefined ? { allergies: str(r.allergies, 'taste.allergies', 120)! } : {}),
    ...(budget !== undefined ? { budget } : {}),
    ...(queue !== undefined ? { queue } : {}),
    ...(r.kids !== undefined ? { kids: r.kids } : {}),
    ...(r.maxWalkMin !== undefined ? { maxWalkMin: r.maxWalkMin as number } : {}),
  };
}

export function parseEvidence(v: unknown, where = 'evidence'): Evidence {
  const r = rec(v, where, ['kind', 'claim', 'source', 'fetchedAt', 'confidence', 'detail']);
  if (!EVIDENCE_KINDS.includes(r.kind as Evidence['kind'])) throw new FoodError(`${where}.kind 不合法`);
  if (!CLAIMS.includes(r.claim as Evidence['claim'])) throw new FoodError(`${where}.claim 不合法`);
  if (r.confidence !== 'live' && r.confidence !== 'recent' && r.confidence !== 'reference') throw new FoodError(`${where}.confidence 要是 live、recent 或 reference`);
  const source = str(r.source, `${where}.source`, 300)!;
  const kind = r.kind as Evidence['kind'];
  // A web or Michelin claim without an address cannot be checked by the person reading it, so it is not evidence.
  if ((kind === 'web' || kind === 'michelin' || kind === 'guide-wikivoyage') && !/^https:\/\//.test(source)) throw new FoodError(`${where}.source：${kind} 的證據一定要有 https 網址`);
  return {
    kind,
    claim: r.claim as Evidence['claim'],
    source,
    fetchedAt: iso(r.fetchedAt, `${where}.fetchedAt`),
    confidence: r.confidence,
    ...(r.detail !== undefined ? { detail: str(r.detail, `${where}.detail`, 80)! } : {}),
  };
}

function parseLoc(v: unknown, where: string): { lat: number; lng: number; fetchedAt: string } {
  const r = rec(v, where, ['lat', 'lng', 'fetchedAt']);
  const lat = r.lat;
  const lng = r.lng;
  if (typeof lat !== 'number' || typeof lng !== 'number' || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new FoodError(`${where} 的座標不合法`);
  return { lat, lng, fetchedAt: iso(r.fetchedAt, `${where}.fetchedAt`) };
}

/** A line that carries a rating or a score. Ratings are never stored (Google's terms), and our own words must not smuggle one in. */
const RATING_LIKE = /[★☆]|\d\s*[.,]\s*\d|評分|分數|\bstars?\b|\d\s*\/\s*(?:5|10)\b/i;

function plainLine(v: unknown, where: string, max: number): string {
  const text = str(v, where, max)!;
  if (RATING_LIKE.test(text)) throw new FoodError(`${where}：不要寫評分或分數（沒有來源可以查證，Google 的條款也不允許存）`);
  return text;
}

export function parseProfile(v: unknown, where = 'profile'): PlaceProfile {
  const r = rec(v, where, ['summary', 'order', 'price', 'watch', 'sources', 'fetchedAt']);
  const sources = list(r.sources, `${where}.sources`, 3, (x, i) => httpsUrl(x, `${where}.sources[${i}]`));
  if (sources.length === 0) throw new FoodError(`${where}.sources：要附上你讀過的網頁（至少一個 https 網址）`);
  return {
    summary: plainLine(r.summary, `${where}.summary`, 160),
    ...(r.order !== undefined ? { order: list(r.order, `${where}.order`, 5, (x, i) => plainLine(x, `${where}.order[${i}]`, 40)) } : {}),
    // A price is a number a page gave; only the sources above make it checkable. (A price like 12.50 is a price, not a score.)
    ...(r.price !== undefined ? { price: str(r.price, `${where}.price`, 40)! } : {}),
    ...(r.watch !== undefined ? { watch: plainLine(r.watch, `${where}.watch`, 120) } : {}),
    sources,
    fetchedAt: iso(r.fetchedAt, `${where}.fetchedAt`),
  };
}

const PHOTO_FILE_RE = /^attachments\/food-[a-f0-9]{10}\.(?:png|jpg|webp)$/;

export function parsePhoto(v: unknown, where = 'photo'): PlacePhoto {
  const r = rec(v, where, ['file', 'pageUrl', 'fetchedAt']);
  const file = str(r.file, `${where}.file`, 80)!;
  if (!PHOTO_FILE_RE.test(file)) throw new FoodError(`${where}.file 不合法`);
  return { file, pageUrl: httpsUrl(r.pageUrl, `${where}.pageUrl`), fetchedAt: iso(r.fetchedAt, `${where}.fetchedAt`) };
}

export function parsePlace(v: unknown, where = 'place'): FoodPlace {
  const r = rec(v, where, ['key', 'name', 'nameLocal', 'loc', 'alsoKeys', 'city', 'dishes', 'evidence', 'profile', 'photo']);
  return {
    key: str(r.key, `${where}.key`, 80)!,
    name: str(r.name, `${where}.name`, 120)!,
    ...(r.nameLocal !== undefined ? { nameLocal: str(r.nameLocal, `${where}.nameLocal`, 120)! } : {}),
    loc: parseLoc(r.loc, `${where}.loc`),
    ...(r.alsoKeys !== undefined ? { alsoKeys: list(r.alsoKeys, `${where}.alsoKeys`, 10, (x) => str(x, `${where}.alsoKeys`, 80)!) } : {}),
    city: str(r.city, `${where}.city`, 40)!,
    dishes: list(r.dishes ?? [], `${where}.dishes`, 20, (x) => {
      if (typeof x !== 'string' || !ID_RE.test(x)) throw new FoodError(`${where}.dishes 要是菜的 id`);
      return x;
    }),
    evidence: list(r.evidence ?? [], `${where}.evidence`, 20, (x, i) => parseEvidence(x, `${where}.evidence[${i}]`)),
    ...(r.profile !== undefined ? { profile: parseProfile(r.profile, `${where}.profile`) } : {}),
    ...(r.photo !== undefined ? { photo: parsePhoto(r.photo, `${where}.photo`) } : {}),
  };
}

export function parseListing(v: unknown, where = 'listing'): GuideListing {
  const r = rec(v, where, ['name', 'alt', 'loc', 'city', 'source', 'lastedit']);
  const src = rec(r.source, `${where}.source`, ['url', 'title', 'revision', 'fetchedAt']);
  const loc = rec(r.loc, `${where}.loc`, ['lat', 'lng']);
  if (typeof loc.lat !== 'number' || typeof loc.lng !== 'number' || Math.abs(loc.lat) > 90 || Math.abs(loc.lng) > 180) throw new FoodError(`${where}.loc 的座標不合法`);
  if (r.lastedit !== undefined && !(typeof r.lastedit === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.lastedit))) throw new FoodError(`${where}.lastedit 要是 YYYY-MM-DD`);
  return {
    name: str(r.name, `${where}.name`, 120)!,
    ...(r.alt !== undefined ? { alt: str(r.alt, `${where}.alt`, 120)! } : {}),
    loc: { lat: loc.lat, lng: loc.lng },
    city: str(r.city, `${where}.city`, 40)!,
    source: { url: httpsUrl(src.url, `${where}.source.url`), title: str(src.title, `${where}.source.title`, 120)!, ...(src.revision !== undefined ? { revision: str(src.revision, `${where}.source.revision`, 40)! } : {}), fetchedAt: iso(src.fetchedAt, `${where}.source.fetchedAt`) },
    ...(r.lastedit !== undefined ? { lastedit: r.lastedit as string } : {}),
  };
}

const TIERS = ['safe', 'likely', 'check'] as const;
const OPENS = ['open', 'closed', 'unknown'] as const;

function parseShortItem(v: unknown, where: string): ShortlistItem {
  const r = rec(v, where, ['key', 'distanceM', 'walkMin', 'tier', 'why', 'flags', 'open', 'hours', 'website', 'mapsUrl']);
  const num = (x: unknown, name: string): number => {
    if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > 100_000) throw new FoodError(`${where}.${name} 不合法`);
    return x;
  };
  if (!TIERS.includes(r.tier as (typeof TIERS)[number])) throw new FoodError(`${where}.tier 不合法`);
  if (!OPENS.includes(r.open as (typeof OPENS)[number])) throw new FoodError(`${where}.open 不合法`);
  return {
    key: str(r.key, `${where}.key`, 80)!,
    distanceM: num(r.distanceM, 'distanceM'),
    walkMin: num(r.walkMin, 'walkMin'),
    tier: r.tier as ShortlistItem['tier'],
    why: list(r.why ?? [], `${where}.why`, 4, (x) => str(x, `${where}.why`, 120)!),
    flags: list(r.flags ?? [], `${where}.flags`, 8, (x) => str(x, `${where}.flags`, 24)!),
    open: r.open as ShortlistItem['open'],
    ...(r.hours !== undefined ? { hours: str(r.hours, `${where}.hours`, 200)! } : {}),
    ...(r.website !== undefined ? { website: str(r.website, `${where}.website`, 300)! } : {}),
    mapsUrl: httpsUrl(r.mapsUrl, `${where}.mapsUrl`),
  };
}

export function parseBatch(v: unknown, where = 'shortlist'): ShortlistBatch {
  const r = rec(v, where, ['at', 'date', 'slot', 'anchor', 'city', 'items']);
  if (r.slot !== 'lunch' && r.slot !== 'dinner') throw new FoodError(`${where}.slot 不合法`);
  if (typeof r.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) throw new FoodError(`${where}.date 不合法`);
  return {
    at: iso(r.at, `${where}.at`),
    date: r.date,
    slot: r.slot,
    anchor: str(r.anchor, `${where}.anchor`, 120)!,
    ...(r.city !== undefined ? { city: str(r.city, `${where}.city`, 40)! } : {}),
    items: list(r.items, `${where}.items`, 12, (x, i) => parseShortItem(x, `${where}.items[${i}]`)),
  };
}

export function parseFood(raw: unknown): FoodFile {
  const r = rec(raw, 'food.json', ['version', 'taste', 'dishes', 'votes', 'places', 'shortlist', 'listings', 'rejected', 'attribution']);
  if (r.version !== 1) throw new FoodError('food.json 的 version 要是 1');
  const dishes = list(r.dishes ?? [], 'dishes', 300, (d, i) => parseDish(d, `dishes[${i}]`));
  const ids = new Set<string>();
  for (const d of dishes) {
    if (ids.has(d.id)) throw new FoodError(`菜的 id 重複：${d.id}`);
    ids.add(d.id);
  }
  const votesRaw = rec(r.votes ?? {}, 'votes', Object.keys((r.votes as Rec) ?? {}));
  const votes: FoodFile['votes'] = {};
  for (const [k, v] of Object.entries(votesRaw)) {
    if (!ids.has(k)) throw new FoodError(`votes 裡有不存在的菜：${k}`);
    if (v !== 'want' && v !== 'no') throw new FoodError(`votes.${k} 要是 want 或 no`);
    votes[k] = v;
  }
  const places = list(r.places ?? [], 'places', 500, (p, i) => parsePlace(p, `places[${i}]`));
  const keys = new Set<string>();
  for (const p of places) {
    if (keys.has(p.key)) throw new FoodError(`店的 key 重複：${p.key}`);
    keys.add(p.key);
    for (const d of p.dishes) if (!ids.has(d)) throw new FoodError(`店「${p.name}」列了不存在的菜：${d}`);
  }
  return {
    version: 1,
    taste: parseTaste(r.taste ?? {}),
    dishes,
    votes,
    places,
    shortlist: list(r.shortlist ?? [], 'shortlist', 3, (x, i) => parseBatch(x, `shortlist[${i}]`)),
    listings: list(r.listings ?? [], 'listings', 1500, (x, i) => parseListing(x, `listings[${i}]`)),
    rejected: list(r.rejected ?? [], 'rejected', 500, (x, i) => {
      const o = rec(x, `rejected[${i}]`, ['key', 'reason', 'at']);
      if (o.reason !== undefined && !REJECT_REASONS.includes(o.reason as RejectReason)) throw new FoodError(`rejected[${i}].reason 不合法`);
      return { key: str(o.key, `rejected[${i}].key`, 80)!, ...(o.reason !== undefined ? { reason: o.reason as RejectReason } : {}), at: iso(o.at, `rejected[${i}].at`) };
    }),
    attribution: [...new Set(list(r.attribution ?? [], 'attribution', 10, (x) => str(x, 'attribution', 120)!))],
  };
}

// ---------- operations ----------

const same = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** Adds a dish, or replaces the one with the same id. */
export function putDish(food: FoodFile, dish: unknown): FoodFile {
  const d = parseDish(dish);
  const next = same(food);
  const i = next.dishes.findIndex((x) => x.id === d.id);
  if (i >= 0) next.dishes[i] = d;
  else next.dishes.push(d);
  return parseFood(next);
}

export function removeDish(food: FoodFile, id: string): FoodFile {
  if (!food.dishes.some((d) => d.id === id)) throw new FoodError(`找不到菜：${id}`);
  const next = same(food);
  next.dishes = next.dishes.filter((d) => d.id !== id);
  delete next.votes[id];
  for (const p of next.places) p.dishes = p.dishes.filter((d) => d !== id);
  next.taste.avoidDishes = next.taste.avoidDishes.filter((d) => d !== id);
  return parseFood(next);
}

export function voteDish(food: FoodFile, id: string, vote: 'want' | 'no' | 'clear'): FoodFile {
  if (!food.dishes.some((d) => d.id === id)) throw new FoodError(`找不到菜：${id}`);
  const next = same(food);
  if (vote === 'clear') delete next.votes[id];
  else next.votes[id] = vote;
  return parseFood(next);
}

/** Merges taste changes; arrays given here replace the old ones. */
export function setTaste(food: FoodFile, patch: Record<string, unknown>): FoodFile {
  const next = same(food);
  next.taste = parseTaste({ ...next.taste, ...patch });
  return parseFood(next);
}

/** Adds guide listings; an entry with the same name at (about) the same spot is replaced by the newer reading. */
export function putListings(food: FoodFile, listings: unknown[]): FoodFile {
  const next = same(food);
  for (const raw of listings) {
    const l = parseListing(raw);
    const i = next.listings.findIndex((x) => x.name === l.name && Math.abs(x.loc.lat - l.loc.lat) < 0.0005 && Math.abs(x.loc.lng - l.loc.lng) < 0.0005);
    if (i >= 0) next.listings[i] = l;
    else next.listings.push(l);
  }
  return parseFood(next);
}

export function putPlace(food: FoodFile, place: unknown): FoodFile {
  const p = parsePlace(place);
  const next = same(food);
  const i = next.places.findIndex((x) => x.key === p.key);
  if (i >= 0) next.places[i] = p;
  else next.places.push(p);
  return parseFood(next);
}

function withPlace(food: FoodFile, key: string, change: (p: FoodPlace) => void): FoodFile {
  const next = same(food);
  const place = next.places.find((p) => p.key === key);
  if (!place) throw new FoodError(`找不到店：${key}（先用 food near --save 找到它）`);
  change(place);
  return parseFood(next);
}

/** Replaces the place's profile (what it is, what to order, price, caveats) with what the pages said. */
export function setProfile(food: FoodFile, key: string, profile: unknown): FoodFile {
  const p = parseProfile(profile);
  return withPlace(food, key, (place) => void (place.profile = p));
}

export function setPhoto(food: FoodFile, key: string, photo: unknown): FoodFile {
  const p = parsePhoto(photo);
  return withPlace(food, key, (place) => void (place.photo = p));
}

/** Records a search so the board can show it. The same meal and start replaces the older one; only the latest three are kept. */
export function putShortlist(food: FoodFile, batch: unknown): FoodFile {
  const b = parseBatch(batch);
  const next = same(food);
  next.shortlist = [...next.shortlist.filter((x) => !(x.date === b.date && x.slot === b.slot && x.anchor === b.anchor)), b].slice(-3);
  return parseFood(next);
}

export function addEvidence(food: FoodFile, key: string, evidence: unknown): FoodFile {
  const e = parseEvidence(evidence);
  const next = same(food);
  const place = next.places.find((p) => p.key === key);
  if (!place) throw new FoodError(`找不到店：${key}（先用 food near 找到它）`);
  // The same claim from the same source replaces the older one.
  place.evidence = place.evidence.filter((x) => !(x.kind === e.kind && x.claim === e.claim && x.source === e.source));
  place.evidence.push(e);
  return parseFood(next);
}

export function rejectPlace(food: FoodFile, key: string, reason: RejectReason | undefined, at: string): FoodFile {
  const next = same(food);
  next.rejected = next.rejected.filter((r) => r.key !== key);
  next.rejected.push({ key, ...(reason ? { reason } : {}), at });
  return parseFood(next);
}

export function addAttribution(food: FoodFile, ...credits: string[]): FoodFile {
  const next = same(food);
  next.attribution = [...new Set([...next.attribution, ...credits])];
  return parseFood(next);
}

// ---------- what to show ----------

/** Tags a diet rules out (vegetarian and vegan are handled separately: they need the dish to say it is fine). */
const DIET_AVOIDS: Partial<Record<Diet, string[]>> = {
  'no-pork': ['pork'],
  'no-beef': ['beef'],
  'no-seafood': ['seafood'],
  'no-raw': ['raw'],
  halal: ['pork', 'alcohol'],
};

export interface DishView {
  shown: Dish[];
  /** Hidden because of what the travellers said (voted no, avoided dish or tag, diet): shown as a count so nothing vanishes silently. */
  hidden: { dish: Dish; why: string }[];
}

/** The dishes of a city for a slot, after the travellers' taste. Wanted dishes come first. */
export function visibleDishes(food: FoodFile, city: string, slot?: MealSlot): DishView {
  const t = food.taste;
  const avoid = new Set([...t.avoidTags, ...t.diet.flatMap((d) => DIET_AVOIDS[d] ?? [])]);
  const needsVeg = t.diet.includes('vegetarian') || t.diet.includes('vegan');
  const shown: Dish[] = [];
  const hidden: DishView['hidden'] = [];
  for (const dish of food.dishes.filter((d) => d.city === city)) {
    if (slot && dish.slots && !dish.slots.includes(slot)) continue;
    const bad = dish.tags.find((x) => avoid.has(x));
    if (food.votes[dish.id] === 'no' || t.avoidDishes.includes(dish.id)) hidden.push({ dish, why: '你說不要' });
    else if (bad) hidden.push({ dish, why: `不吃（${bad}）` });
    else if (needsVeg && !dish.tags.includes('vegetarian-ok')) hidden.push({ dish, why: '不是素食' });
    else shown.push(dish);
  }
  const rank = (d: Dish) => (food.votes[d.id] === 'want' ? 0 : t.likeTags.some((x) => d.tags.includes(x)) ? 1 : 2);
  shown.sort((a, b) => rank(a) - rank(b));
  return { shown, hidden };
}

/** True when the only thing behind a dish is the AI's own memory. */
export const aiOnly = (dish: Dish): boolean => dish.sources.every((s) => s.kind === 'ai');

/**
 * A Google Maps search for a dish near a named stop: "carbonara 競技場 羅馬". Needs no coordinates and no key; the user reads the
 * ratings on Google's page themselves. Far more useful than "restaurants near …".
 */
export function dishSearchUrl(dish: Pick<Dish, 'nameLocal' | 'nameZh' | 'city'>, anchorTitle: string | undefined): string {
  const anchor = anchorTitle?.replace(/[（(].*?[）)]/g, '').trim();
  const q = [dish.nameLocal, anchor, dish.city].filter(Boolean).join(' ');
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

// ---------- adopting a place into the itinerary ----------

export interface MealFromPlace {
  title: string;
  loc: { lat: number; lng: number; fetchedAt: string };
  placeId: string;
  slot?: MealSlot;
  dishes: string[];
  checks: Record<string, unknown>;
}

const PLACE_KEY_RE = /^(osm:(node|way|relation)\/\d{1,15}|[A-Za-z0-9_-]{10,200})$/;

/**
 * What goes into the meal item when the traveller picks a place. Only a place that was seen on a map (it has an `exists` proof)
 * can be chosen: a name the AI remembers is not enough. The checks keep the source and the date; nothing else about the place
 * (no rating) is written.
 */
export function mealFromPlace(raw: unknown, opts: { slot?: unknown; now: string }): MealFromPlace {
  const r = rec(raw, 'place', ['key', 'name', 'loc', 'dishes', 'evidence']);
  const key = str(r.key, 'place.key', 200)!;
  if (!PLACE_KEY_RE.test(key)) throw new FoodError('place.key 不合法');
  const loc = r.loc as { lat?: unknown; lng?: unknown } | undefined;
  if (!loc || typeof loc.lat !== 'number' || typeof loc.lng !== 'number' || Math.abs(loc.lat) > 90 || Math.abs(loc.lng) > 180) throw new FoodError('place.loc 的座標不合法');
  const evidence = list(r.evidence ?? [], 'place.evidence', 10, (x, i) => parseEvidence(x, `place.evidence[${i}]`));
  // Proof must come from a map (or a link the user pasted) and name this very place; the AI's memory, or text typed into a
  // request, is not proof. A claim that the place is closed rules it out.
  if (evidence.some((e) => e.claim === 'closed-at-slot' || e.claim === 'permanently-closed')) throw new FoodError('這家店的證據說它那時沒開或已歇業，不能加進行程');
  const mapKinds: Evidence['kind'][] = ['map-osm', 'map-google', 'user-link'];
  const exists = evidence.find((e) => e.claim === 'exists' && mapKinds.includes(e.kind) && e.source === key);
  if (!exists) throw new FoodError('只有在地圖上確認存在的店才能加進行程（這家沒有來自地圖、指向這家店的「存在」證據）');
  const open = evidence.find((e) => e.claim === 'open-at-slot' && mapKinds.includes(e.kind) && e.source === key);
  // A recommendation needs a page to read; its one-line label may not carry a rating or a score.
  const recommended = evidence.filter((e) => e.claim === 'recommended' && /^https:\/\//.test(e.source) && ['web', 'michelin', 'guide-wikivoyage'].includes(e.kind) && !/[★☆]|\d\s*[.,]\s*\d|評分|分數|stars?/i.test(e.detail ?? ''));
  const sourced = (e: Evidence, value: unknown) => ({ value, source: e.source, fetchedAt: e.fetchedAt, confidence: e.confidence });
  const dishes = list(r.dishes ?? [], 'place.dishes', 6, (x) => {
    if (typeof x !== 'string' || !ID_RE.test(x)) throw new FoodError('place.dishes 要是菜的 id');
    return x;
  });
  const slot = opts.slot === undefined ? undefined : (MEAL_SLOTS.includes(opts.slot as MealSlot) ? (opts.slot as MealSlot) : (() => { throw new FoodError('slot 不合法'); })());
  return {
    title: str(r.name, 'place.name', 120)!,
    loc: { lat: loc.lat, lng: loc.lng, fetchedAt: opts.now },
    placeId: key,
    ...(slot ? { slot } : {}),
    dishes,
    checks: {
      exists: sourced(exists, true),
      ...(open ? { openAtSlot: sourced(open, true) } : {}),
      ...(recommended.length ? { recommendedBy: recommended.map((e) => ({ value: (e.detail ?? '文章推薦').slice(0, 80), source: e.source, fetchedAt: e.fetchedAt, confidence: e.confidence })) } : {}),
    },
  };
}
