// Step 0 (找方向): the pure model behind trips/<id>/idea.json. See docs/FIND-DESTINATION.md.
//
// No Node imports: the CLI, the dev-server endpoints and the page all read and write the file through
// these functions, so they agree on what is valid and on which question comes next.
//
// Conventions
// - Every operation returns a NEW Idea (inputs are never mutated) and ends in `parseIdea`, so whatever it
//   returns is a valid file. Errors are `IdeaError` with a user-facing Traditional Chinese message.
// - Unknown keys are REJECTED (top level and nested): a typo should fail loudly, not be silently dropped.
// - Normalisation (so parse is idempotent): strings are trimmed, `months` and `tags` are de-duplicated,
//   months are sorted ascending.
// - `undefined` = not asked yet; `null` = asked and answered 「不知道／跳過」.

export const SCENERY_TAGS = ['mountains', 'sea', 'city', 'food', 'culture', 'history', 'nature', 'snow', 'nightlife', 'shopping'] as const;
export type SceneryTag = (typeof SCENERY_TAGS)[number];

export const SCENERY_LABEL: Record<SceneryTag, string> = {
  mountains: '山',
  sea: '海',
  city: '城市',
  food: '美食',
  culture: '文化',
  history: '古蹟',
  nature: '自然',
  snow: '雪',
  nightlife: '夜生活',
  shopping: '購物',
};

export const WHO_VALUES = ['solo', 'partner', 'friends', 'family', 'parents'] as const;
export type Who = (typeof WHO_VALUES)[number];
export const WHO_LABEL: Record<Who, string> = { solo: '一個人', partner: '另一半', friends: '朋友', family: '家人', parents: '爸媽' };

export const FOCUS_VALUES = ['budget', 'scenery', 'both'] as const;
export type Focus = (typeof FOCUS_VALUES)[number];
export const FOCUS_LABEL: Record<Focus, string> = { budget: '預算', scenery: '風景', both: '預算和風景' };

export const PLACE_KINDS = ['country', 'region', 'city'] as const;
export type PlaceKind = (typeof PLACE_KINDS)[number];

export type PlaceStatus = 'shown' | 'rejected' | 'chosen';

export type IdeaKnown = { decided: true; place: string } | { decided: false };
export interface IdeaBudget { amount: number; currency: string; per: 'person' | 'total' }
export interface IdeaScenery { tags: SceneryTag[]; text?: string }
export interface IdeaWhen { months: number[]; text?: string }
export interface IdeaParty { who: Who; adults: number; childrenAges: number[] }

export interface IdeaCost { text: string; source?: string; fetchedAt?: string }

export interface IdeaPlace {
  id: string;
  slug: string;
  name: string;
  kind: PlaceKind;
  country?: string;
  lat: number;
  lng: number;
  tz: string;
  why: string;
  bestMonths?: number[];
  cost?: IdeaCost;
  round: number;
  status: PlaceStatus;
}

/** What the AI sends: an IdeaPlace without `round` and `status` (the model assigns both). */
export type IdeaPlaceInput = Omit<IdeaPlace, 'round' | 'status'>;

export interface Idea {
  version: 1;
  createdAt: string;
  updatedAt: string;
  known?: IdeaKnown;
  origin?: string | null;
  focus?: Focus;
  budget?: IdeaBudget | null;
  scenery?: IdeaScenery | null;
  when?: IdeaWhen | null;
  days?: number | null;
  // `party` may be null (skipped): an addition to the spec's type, since every question must be skippable.
  party?: IdeaParty | null;
  wantNow?: boolean;
  places: IdeaPlace[];
  chosen?: string;
  dates?: { start: string; end: string };
  tripId?: string;
}

export type IdeaStep = 'known' | 'origin' | 'focus' | 'budget' | 'scenery' | 'when' | 'days' | 'party' | 'suggest' | 'choose' | 'locate' | 'dates' | 'finish' | 'done';

export class IdeaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdeaError';
  }
}

export const MAX_PLACES_PER_ROUND = 5;
export const MAX_TRIP_DAYS = 366;

const KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f\u2028\u2029]/;

const fail = (msg: string): never => {
  throw new IdeaError(msg);
};

// ---------------------------------------------------------------------------------------------
// Validation helpers (all return a fresh, normalised value)

function obj(v: unknown, label: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(`${label} 必須是物件`);
  return v as Record<string, unknown>;
}

function exact(o: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(`${label} 有不認得的欄位：${k}`);
}

function line(v: unknown, label: string, max: number): string {
  if (typeof v !== 'string') return fail(`${label} 必須是文字`);
  const s = v.trim();
  if (s === '') fail(`${label} 不可為空`);
  if (s.length > max) fail(`${label} 過長（最多 ${max} 字）`);
  if (CONTROL_RE.test(s)) fail(`${label} 不可包含換行或控制字元`);
  return s;
}

function int(v: unknown, label: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) fail(`${label} 必須是 ${min}–${max} 的整數`);
  return v as number;
}

function months(v: unknown, label: string): number[] {
  if (!Array.isArray(v)) return fail(`${label} 必須是月份陣列（1–12）`);
  const out = [...new Set(v.map((m, i) => int(m, `${label}[${i}]`, 1, 12)))].sort((a, b) => a - b);
  return out;
}

function oneOf<T extends string>(v: unknown, values: readonly T[], label: string): T {
  if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) fail(`${label} 必須是 ${values.join(' / ')} 其中之一`);
  return v as T;
}

/** A real calendar date (YYYY-MM-DD), returned as a UTC Date. */
function realDate(v: unknown, label: string): Date {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return fail(`${label} 格式必須是 YYYY-MM-DD`);
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) fail(`${label} 不是真實存在的日期：${v}`);
  return d;
}

function isoStamp(v: unknown, label: string): string {
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) fail(`${label} 必須是 ISO 時間`);
  return v as string;
}

function validTz(v: unknown, label: string): string {
  const tz = line(v, label, 64);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    fail(`${label} 不是有效的 IANA 時區：${tz}（例如 Europe/Zurich）`);
  }
  return tz;
}

function parseKnown(v: unknown): IdeaKnown {
  const o = obj(v, 'known');
  exact(o, ['decided', 'place'], 'known');
  if (o.decided === true) return { decided: true, place: line(o.place, 'known.place', 80) };
  if (o.decided === false) {
    if (o.place !== undefined) fail('known.decided 為 false 時不可有 place');
    return { decided: false };
  }
  return fail('known.decided 必須是 true 或 false');
}

function parseBudget(v: unknown): IdeaBudget {
  const o = obj(v, 'budget');
  exact(o, ['amount', 'currency', 'per'], 'budget');
  if (typeof o.amount !== 'number' || !Number.isFinite(o.amount) || o.amount <= 0 || o.amount > 1e9) fail('budget.amount 必須是大於 0 的數字');
  if (typeof o.currency !== 'string' || !/^[A-Z]{3}$/.test(o.currency)) fail('budget.currency 必須是 3 個大寫字母的幣別代碼（例如 TWD）');
  return { amount: o.amount as number, currency: o.currency as string, per: oneOf(o.per, ['person', 'total'] as const, 'budget.per') };
}

function parseScenery(v: unknown): IdeaScenery {
  const o = obj(v, 'scenery');
  exact(o, ['tags', 'text'], 'scenery');
  if (!Array.isArray(o.tags)) fail('scenery.tags 必須是陣列');
  const tags = [...new Set((o.tags as unknown[]).map((t, i) => oneOf(t, SCENERY_TAGS, `scenery.tags[${i}]`)))];
  const text = o.text === undefined ? undefined : line(o.text, 'scenery.text', 200);
  if (tags.length === 0 && !text) fail('scenery 至少要有一個標籤或一段文字（想跳過請填 null）');
  return text ? { tags, text } : { tags };
}

function parseWhen(v: unknown): IdeaWhen {
  const o = obj(v, 'when');
  exact(o, ['months', 'text'], 'when');
  const ms = months(o.months, 'when.months');
  const text = o.text === undefined ? undefined : line(o.text, 'when.text', 100);
  if (ms.length === 0 && !text) fail('when 至少要有一個月份或一段文字（想跳過請填 null）');
  return text ? { months: ms, text } : { months: ms };
}

function parseParty(v: unknown): IdeaParty {
  const o = obj(v, 'party');
  exact(o, ['who', 'adults', 'childrenAges'], 'party');
  const who = oneOf(o.who, WHO_VALUES, 'party.who');
  const adults = int(o.adults, 'party.adults', 1, 20);
  const raw = o.childrenAges === undefined ? [] : o.childrenAges;
  if (!Array.isArray(raw) || raw.length > 10) fail('party.childrenAges 必須是最多 10 個年齡的陣列');
  const childrenAges = (raw as unknown[]).map((a, i) => int(a, `party.childrenAges[${i}]`, 0, 17));
  if (who === 'solo' && (adults !== 1 || childrenAges.length > 0)) fail('一個人旅行時 adults 必須是 1，且沒有小孩');
  return { who, adults, childrenAges };
}

function parseCost(v: unknown, label: string): IdeaCost {
  const o = obj(v, label);
  exact(o, ['text', 'source', 'fetchedAt'], label);
  const cost: IdeaCost = { text: line(o.text, `${label}.text`, 120) };
  if (o.source !== undefined) cost.source = line(o.source, `${label}.source`, 300);
  if (o.fetchedAt !== undefined) {
    const s = isoStamp(o.fetchedAt, `${label}.fetchedAt`);
    cost.fetchedAt = s;
  }
  // The repo's rule: a source without a read time is not a Sourced value.
  if (cost.source && !cost.fetchedAt) fail(`${label} 有 source 時也要有 fetchedAt`);
  if (cost.fetchedAt && !cost.source) fail(`${label} 有 fetchedAt 時也要有 source`);
  return cost;
}

const PLACE_INPUT_KEYS = ['id', 'slug', 'name', 'kind', 'country', 'lat', 'lng', 'tz', 'why', 'bestMonths', 'cost'] as const;

function parsePlaceFields(o: Record<string, unknown>, label: string): IdeaPlaceInput {
  const id = line(o.id, `${label}.id`, 60);
  if (!KEBAB_RE.test(id)) fail(`${label}.id 必須是 kebab-case（小寫英數字與 -）：${id}`);
  const slug = line(o.slug, `${label}.slug`, 40);
  if (!KEBAB_RE.test(slug)) fail(`${label}.slug 必須是 ASCII kebab-case（小寫英數字與 -）：${slug}`);
  const lat = o.lat;
  const lng = o.lng;
  if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) fail(`${label}.lat 必須介於 -90 到 90`);
  if (typeof lng !== 'number' || !Number.isFinite(lng) || lng < -180 || lng > 180) fail(`${label}.lng 必須介於 -180 到 180`);
  const place: IdeaPlaceInput = {
    id,
    slug,
    name: line(o.name, `${label}.name`, 60),
    kind: oneOf(o.kind, PLACE_KINDS, `${label}.kind`),
    lat: lat as number,
    lng: lng as number,
    tz: validTz(o.tz, `${label}.tz`),
    why: line(o.why, `${label}.why`, 200),
  };
  if (o.country !== undefined) place.country = line(o.country, `${label}.country`, 60);
  if (o.bestMonths !== undefined) {
    const ms = months(o.bestMonths, `${label}.bestMonths`);
    if (ms.length === 0) fail(`${label}.bestMonths 不可為空陣列（不知道就省略）`);
    place.bestMonths = ms;
  }
  if (o.cost !== undefined) place.cost = parseCost(o.cost, `${label}.cost`);
  return place;
}

/** Validates one place as the AI sends it (no round / status). */
export function parsePlaceInput(raw: unknown, label = 'place'): IdeaPlaceInput {
  const o = obj(raw, label);
  exact(o, PLACE_INPUT_KEYS, label);
  return parsePlaceFields(o, label);
}

function parseStoredPlace(raw: unknown, label: string): IdeaPlace {
  const o = obj(raw, label);
  exact(o, [...PLACE_INPUT_KEYS, 'round', 'status'], label);
  const base = parsePlaceFields(o, label);
  return { ...base, round: int(o.round, `${label}.round`, 1, 1000), status: oneOf(o.status, ['shown', 'rejected', 'chosen'] as const, `${label}.status`) };
}

const TOP_KEYS = ['version', 'createdAt', 'updatedAt', 'known', 'origin', 'focus', 'budget', 'scenery', 'when', 'days', 'party', 'wantNow', 'places', 'chosen', 'dates', 'tripId'] as const;

/**
 * Strictly validates a whole idea.json and returns a normalised copy (never the input object).
 * Also checks that the pieces agree: `chosen` points at the one place with status 'chosen', ids are unique,
 * and `tripId` only exists once a place and dates exist.
 */
export function parseIdea(raw: unknown): Idea {
  const o = obj(raw, 'idea.json');
  exact(o, TOP_KEYS, 'idea.json');
  if (o.version !== 1) fail('idea.json 的 version 必須是 1');
  const idea: Idea = { version: 1, createdAt: isoStamp(o.createdAt, 'createdAt'), updatedAt: isoStamp(o.updatedAt, 'updatedAt'), places: [] };
  if (o.known !== undefined) idea.known = parseKnown(o.known);
  if (o.origin !== undefined) idea.origin = o.origin === null ? null : line(o.origin, 'origin', 80);
  if (o.focus !== undefined) idea.focus = oneOf(o.focus, FOCUS_VALUES, 'focus');
  if (o.budget !== undefined) idea.budget = o.budget === null ? null : parseBudget(o.budget);
  if (o.scenery !== undefined) idea.scenery = o.scenery === null ? null : parseScenery(o.scenery);
  if (o.when !== undefined) idea.when = o.when === null ? null : parseWhen(o.when);
  if (o.days !== undefined) idea.days = o.days === null ? null : int(o.days, 'days', 1, 90);
  if (o.party !== undefined) idea.party = o.party === null ? null : parseParty(o.party);
  if (o.wantNow !== undefined) {
    if (typeof o.wantNow !== 'boolean') fail('wantNow 必須是 true 或 false');
    idea.wantNow = o.wantNow as boolean;
  }
  if (!Array.isArray(o.places)) fail('places 必須是陣列');
  const ids = new Set<string>();
  idea.places = (o.places as unknown[]).map((p, i) => {
    const place = parseStoredPlace(p, `places[${i}]`);
    if (ids.has(place.id)) fail(`places 裡有重複的 id：${place.id}`);
    ids.add(place.id);
    return place;
  });
  const chosenPlaces = idea.places.filter((p) => p.status === 'chosen');
  if (chosenPlaces.length > 1) fail('只能有一個 status 為 chosen 的地點');
  if (o.chosen !== undefined) {
    const id = line(o.chosen, 'chosen', 60);
    if (chosenPlaces[0]?.id !== id) fail(`chosen 指向的地點（${id}）必須存在且 status 為 chosen`);
    idea.chosen = id;
  } else if (chosenPlaces.length === 1) {
    fail('有地點的 status 是 chosen，但沒有 chosen 欄位');
  }
  if (o.dates !== undefined) {
    const d = obj(o.dates, 'dates');
    exact(d, ['start', 'end'], 'dates');
    const start = realDate(d.start, 'dates.start');
    const end = realDate(d.end, 'dates.end');
    if (start.getTime() > end.getTime()) fail('出發日不可晚於回來日');
    if ((end.getTime() - start.getTime()) / 86_400_000 + 1 > MAX_TRIP_DAYS) fail(`行程最多 ${MAX_TRIP_DAYS} 天`);
    idea.dates = { start: d.start as string, end: d.end as string };
  }
  if (o.tripId !== undefined) {
    const t = line(o.tripId, 'tripId', 80);
    if (!KEBAB_RE.test(t)) fail(`tripId 必須是 kebab-case：${t}`);
    if (!idea.chosen || !idea.dates) fail('tripId 只能在選好地點和日期之後出現');
    idea.tripId = t;
  }
  return idea;
}

// ---------------------------------------------------------------------------------------------
// Reading the state

export function newIdea(now: Date): Idea {
  const t = now.toISOString();
  return { version: 1, createdAt: t, updatedAt: t, places: [] };
}

export function chosenPlace(idea: Idea): IdeaPlace | undefined {
  return idea.places.find((p) => p.status === 'chosen');
}

export function latestRound(idea: Idea): number {
  return idea.places.reduce((m, p) => Math.max(m, p.round), 0);
}

/** The places of one round (default: the latest), in the order they were suggested. */
export function roundPlaces(idea: Idea, round: number = latestRound(idea)): IdeaPlace[] {
  return idea.places.filter((p) => p.round === round);
}

/**
 * Which card comes next. Computed from the file, never stored.
 * known=yes skips focus/budget/scenery and the suggest/choose cards (the AI only locates the typed place);
 * `wantNow` treats every remaining question before suggest/locate as skipped.
 */
export function nextStep(idea: Idea): IdeaStep {
  if (idea.tripId) return 'done';
  if (!idea.known) return 'known';
  if (idea.origin === undefined) return 'origin';
  const decided = idea.known.decided;
  if (!idea.wantNow) {
    if (!decided) {
      if (idea.focus === undefined) return 'focus';
      if ((idea.focus === 'budget' || idea.focus === 'both') && idea.budget === undefined) return 'budget';
      if ((idea.focus === 'scenery' || idea.focus === 'both') && idea.scenery === undefined) return 'scenery';
    }
    if (idea.when === undefined) return 'when';
    if (idea.days === undefined) return 'days';
    if (idea.party === undefined) return 'party';
  }
  if (chosenPlace(idea)) return idea.dates ? 'finish' : 'dates';
  if (idea.places.some((p) => p.status === 'shown')) return 'choose';
  return decided ? 'locate' : 'suggest';
}

export const STEP_TITLE: Record<IdeaStep, string> = {
  known: '決定好要去哪了嗎？',
  origin: '從哪裡出發？',
  focus: '這趟比較在意什麼？',
  budget: '預算大概多少？',
  scenery: '想看什麼、想做什麼？',
  when: '大概什麼時候？',
  days: '去幾天？',
  party: '跟誰去？',
  suggest: '給我 3 個點子',
  choose: '選一個，或請 AI 再給別的',
  locate: '在地球上找到這個地方',
  dates: '出發和回來的日期',
  finish: '建立行程',
  done: '行程已建立',
};

// ---------------------------------------------------------------------------------------------
// Operations

export type IdeaAnswer =
  | { field: 'known'; value: IdeaKnown | null }
  | { field: 'origin'; value: string | null }
  | { field: 'focus'; value: Focus | null }
  | { field: 'budget'; value: IdeaBudget | null }
  | { field: 'scenery'; value: IdeaScenery | null }
  | { field: 'when'; value: IdeaWhen | null }
  | { field: 'days'; value: number | null }
  | { field: 'party'; value: IdeaParty | null }
  | { field: 'wantNow'; value: boolean };

export const ANSWER_FIELDS = ['known', 'origin', 'focus', 'budget', 'scenery', 'when', 'days', 'party', 'wantNow'] as const;
export type AnswerField = (typeof ANSWER_FIELDS)[number];

function editable(idea: Idea): void {
  if (idea.tripId) fail(`行程已經建立（${idea.tripId}），這個想法不能再修改`);
}

function commit(idea: Idea, patch: Partial<Idea>, now: Date): Idea {
  return parseIdea({ ...idea, ...patch, updatedAt: now.toISOString() });
}

/**
 * Records one answer (overwriting an earlier one, so the page can go back).
 * Skipping is `value: null`; for the fields whose stored type has no null, skipping means the neutral value:
 * known → { decided: false }, focus → 'both' (ask everything).
 */
export function applyAnswer(idea: Idea, answer: IdeaAnswer, now: Date): Idea {
  editable(idea);
  const a = answer as { field: unknown; value: unknown };
  switch (a.field) {
    case 'known':
      return commit(idea, { known: a.value === null ? { decided: false } : parseKnown(a.value) }, now);
    case 'origin':
      return commit(idea, { origin: a.value === null ? null : line(a.value, 'origin', 80) }, now);
    case 'focus':
      return commit(idea, { focus: a.value === null ? 'both' : oneOf(a.value, FOCUS_VALUES, 'focus') }, now);
    case 'budget':
      return commit(idea, { budget: a.value === null ? null : parseBudget(a.value) }, now);
    case 'scenery':
      return commit(idea, { scenery: a.value === null ? null : parseScenery(a.value) }, now);
    case 'when':
      return commit(idea, { when: a.value === null ? null : parseWhen(a.value) }, now);
    case 'days':
      return commit(idea, { days: a.value === null ? null : int(a.value, 'days', 1, 90) }, now);
    case 'party':
      return commit(idea, { party: a.value === null ? null : parseParty(a.value) }, now);
    case 'wantNow':
      if (typeof a.value !== 'boolean') return fail('wantNow 必須是 true 或 false');
      if (!idea.known || idea.origin === undefined) fail('先回答「決定好要去哪了嗎」和「從哪裡出發」，才能直接推薦');
      return commit(idea, { wantNow: a.value }, now);
    default:
      return fail(`不認得的欄位：${String(a.field)}（可用：${ANSWER_FIELDS.join('、')}）`);
  }
}

/**
 * The AI adds one round of 1–5 places. Allowed when the next step is 'suggest' (known=no) or 'locate' (known=yes).
 * On the known=yes path a single place is chosen automatically: the user already decided.
 */
export function addPlaces(idea: Idea, places: unknown, now: Date): Idea {
  editable(idea);
  const step = nextStep(idea);
  if (step !== 'suggest' && step !== 'locate') {
    fail(
      step === 'choose'
        ? '還有點子等使用者選：請先選一個，或用 reject-round（再給我別的）換掉這一輪'
        : `現在還不能新增地點（目前在「${STEP_TITLE[step]}」這一步）`,
    );
  }
  if (!Array.isArray(places) || places.length < 1 || places.length > MAX_PLACES_PER_ROUND) fail(`一輪要給 1–${MAX_PLACES_PER_ROUND} 個地點`);
  const taken = new Set(idea.places.map((p) => p.id));
  const round = latestRound(idea) + 1;
  const added = (places as unknown[]).map((raw, i) => {
    const p = parsePlaceInput(raw, `places[${i}]`);
    if (taken.has(p.id)) fail(`places[${i}].id 重複：${p.id}`);
    taken.add(p.id);
    return p;
  });
  const auto = idea.known?.decided === true && added.length === 1;
  const stored: IdeaPlace[] = added.map((p) => ({ ...p, round, status: auto ? 'chosen' : 'shown' }));
  return commit(idea, { places: [...idea.places, ...stored], ...(auto ? { chosen: stored[0]!.id } : {}) }, now);
}

function findPlace(idea: Idea, placeId: unknown): IdeaPlace {
  const p = typeof placeId === 'string' ? idea.places.find((x) => x.id === placeId) : undefined;
  if (!p) fail(`找不到地點：${String(placeId)}`);
  return p as IdeaPlace;
}

/** Chooses a place; the previously chosen one goes back to 'shown'. */
export function choosePlace(idea: Idea, placeId: string, now: Date): Idea {
  editable(idea);
  const target = findPlace(idea, placeId);
  const places = idea.places.map((p) => (p.id === target.id ? { ...p, status: 'chosen' as const } : p.status === 'chosen' ? { ...p, status: 'shown' as const } : { ...p }));
  return commit(idea, { places, chosen: target.id }, now);
}

/** 「不要」: rejecting the chosen place also clears the choice. */
export function rejectPlace(idea: Idea, placeId: string, now: Date): Idea {
  editable(idea);
  const target = findPlace(idea, placeId);
  const places = idea.places.map((p) => (p.id === target.id ? { ...p, status: 'rejected' as const } : { ...p }));
  const next: Idea = { ...idea, places };
  if (idea.chosen === target.id) delete next.chosen;
  return commit(next, {}, now);
}

/** 「再給我別的」: rejects every place of the latest round that is still 'shown'. */
export function rejectRound(idea: Idea, now: Date): Idea {
  editable(idea);
  const round = latestRound(idea);
  const shown = roundPlaces(idea, round).filter((p) => p.status === 'shown');
  if (shown.length === 0) fail('這一輪沒有可以換掉的點子');
  const places = idea.places.map((p) => (p.round === round && p.status === 'shown' ? { ...p, status: 'rejected' as const } : { ...p }));
  return commit(idea, { places }, now);
}

export function setDates(idea: Idea, start: string, end: string, now: Date): Idea {
  editable(idea);
  if (!idea.chosen) fail('先選好要去的地方，再設定日期');
  return commit(idea, { dates: { start, end } }, now);
}

/** Records that the trip was created. Only valid at the 'finish' step. */
export function markCreated(idea: Idea, tripId: string, now: Date): Idea {
  editable(idea);
  if (nextStep(idea) !== 'finish') fail('要先選好地點並設定日期，才能建立行程');
  return commit(idea, { tripId }, now);
}

// ---------------------------------------------------------------------------------------------
// Presentation helpers

/** 4,5 → 「4–5」; 1,2,12 → 「1–2、12」. */
function monthRuns(ms: number[]): string {
  const runs: string[] = [];
  for (let i = 0; i < ms.length; ) {
    let j = i;
    while (j + 1 < ms.length && ms[j + 1] === ms[j]! + 1) j++;
    runs.push(j > i ? `${ms[i]}–${ms[j]}` : `${ms[i]}`);
    i = j + 1;
  }
  return runs.join('、');
}

export function partyText(p: IdeaParty): string {
  const people = `${p.adults} 位成人` + (p.childrenAges.length ? `、${p.childrenAges.length} 位小孩（${p.childrenAges.join('、')} 歲）` : '');
  return p.who === 'solo' ? '一個人' : `跟${WHO_LABEL[p.who]}，${people}`;
}

export function budgetText(b: IdeaBudget): string {
  return `${b.per === 'person' ? '每人' : '總共'} ${b.currency} ${b.amount}`;
}

export function sceneryText(s: IdeaScenery): string {
  const tags = s.tags.map((t) => SCENERY_LABEL[t]).join('、');
  return tags && s.text ? `${tags}（${s.text}）` : tags || s.text || '';
}

export function whenText(w: IdeaWhen): string {
  const m = w.months.length ? `${monthRuns(w.months)} 月` : '';
  return m && w.text ? `${m}（${w.text}）` : m || w.text || '';
}

export interface SummaryItem {
  /** The card this answer belongs to, so a chip can take the user back to it. */
  step: IdeaStep;
  text: string;
}

const SKIPPED = '跳過';

/** One entry per answered question, in question order. */
export function ideaSummaryItems(idea: Idea): SummaryItem[] {
  const out: SummaryItem[] = [];
  if (idea.known) out.push({ step: 'known', text: idea.known.decided ? `目的地：${idea.known.place}` : '目的地：還沒決定' });
  if (idea.origin !== undefined) out.push({ step: 'origin', text: `出發地：${idea.origin ?? SKIPPED}` });
  if (idea.focus !== undefined) out.push({ step: 'focus', text: `在意：${FOCUS_LABEL[idea.focus]}` });
  if (idea.budget !== undefined) out.push({ step: 'budget', text: `預算：${idea.budget ? budgetText(idea.budget) : SKIPPED}` });
  if (idea.scenery !== undefined) out.push({ step: 'scenery', text: `想看：${idea.scenery ? sceneryText(idea.scenery) : SKIPPED}` });
  if (idea.when !== undefined) out.push({ step: 'when', text: `時間：${idea.when ? whenText(idea.when) : SKIPPED}` });
  if (idea.days !== undefined) out.push({ step: 'days', text: idea.days === null ? `天數：${SKIPPED}` : `${idea.days} 天` });
  if (idea.party !== undefined) out.push({ step: 'party', text: idea.party ? partyText(idea.party) : `同行：${SKIPPED}` });
  if (idea.wantNow) out.push({ step: 'focus', text: '直接推薦' });
  const chosen = chosenPlace(idea);
  if (chosen) out.push({ step: 'choose', text: `選了：${chosen.name}` });
  if (idea.dates) out.push({ step: 'dates', text: `日期：${idea.dates.start} ~ ${idea.dates.end}` });
  return out;
}

/** Short zh lines for each answered question, e.g. 「出發地：台北」「預算：每人 TWD 60000」「5 天」「跟朋友，3 位成人」. */
export function ideaSummary(idea: Idea): string[] {
  return ideaSummaryItems(idea).map((i) => i.text);
}

/**
 * What step 0 already knows, as ready-made lines for brief.md (so 盤點 has fewer 「（待填）」).
 * Skipped questions are left out; the brief keeps its placeholder for them.
 */
export function ideaBriefPrefill(idea: Idea): { destination?: string; origin?: string; party?: string; budget?: string; preferences: string[] } {
  const out: { destination?: string; origin?: string; party?: string; budget?: string; preferences: string[] } = { preferences: [] };
  const place = chosenPlace(idea);
  if (place) out.destination = place.name;
  if (idea.origin) out.origin = idea.origin;
  if (idea.party) out.party = partyText(idea.party);
  if (idea.budget) out.budget = budgetText(idea.budget);
  if (idea.scenery) out.preferences.push(`想看：${sceneryText(idea.scenery)}`);
  if (idea.focus === 'budget' || idea.focus === 'scenery') out.preferences.push(`這趟比較在意：${FOCUS_LABEL[idea.focus]}`);
  return out;
}

/** `<slug>-<YYYY-MM>` of the start date; `-2`, `-3`… when `taken` has it. */
export function suggestTripId(idea: Idea, taken: ReadonlySet<string>): string {
  const place = chosenPlace(idea);
  if (!place || !idea.dates) return fail('要先選好地點並設定日期，才能決定行程代號');
  const base = `${place.slug}-${idea.dates.start.slice(0, 7)}`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

const addDays = (d: Date, n: number): Date => new Date(d.getTime() + n * 86_400_000);
const ymd = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Proposes start/end from `when.months` and `days`: the first listed month that still lies at least 14 days
 * ahead (booking lead time), starting on that month's first Saturday that is also ≥ 14 days away. Undefined when
 * months or days are missing. It only pre-fills the date inputs; the user decides.
 */
export function suggestDates(idea: Idea, today: Date): { start: string; end: string } | undefined {
  const ms = idea.when?.months;
  const days = idea.days;
  if (!ms || ms.length === 0 || !days) return undefined;
  const t = new Date(`${ymd(today)}T00:00:00Z`);
  const earliest = addDays(t, 14);
  const candidates: Date[] = [];
  for (const year of [t.getUTCFullYear(), t.getUTCFullYear() + 1]) {
    for (const m of ms) {
      let d = new Date(Date.UTC(year, m - 1, 1));
      while (d.getUTCDay() !== 6) d = addDays(d, 1);
      // This month's first Saturday is too soon: take a later Saturday of the same month if there is one.
      while (d < earliest && d.getUTCMonth() === m - 1) d = addDays(d, 7);
      if (d.getUTCMonth() === m - 1 && d >= earliest) candidates.push(d);
    }
  }
  const start = candidates.sort((a, b) => a.getTime() - b.getTime())[0];
  if (!start) return undefined;
  return { start: ymd(start), end: ymd(addDays(start, days - 1)) };
}
