// Dev-server API used by the viewer to write files (see docs/SPEC.md "Dev-server API").
// The request logic lives in `handleTripcodeRequest` with injected dependencies so it can be
// unit-tested without Vite. Only paths inside trips/<tripId>/ (plus node_modules/.tripcode/current.json)
// are ever written.
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadEnv } from 'vite';
import type { Plugin } from 'vite';
import { pathToFileURL } from 'node:url';
import type { Attachment, Candidate, Trip } from './src/core/types.ts';
import type { EditHistory } from './src/core/history.ts';
import type { FetchLike } from './cli/google.ts';
import type { Throttle } from './cli/osm.ts';
import type { ViewerSearchResult } from './cli/search.ts';

export interface SourceEdits {
  insertComment(src: string, targetId: string, text: string, anchor?: string): string;
  setItemField(src: string, itemId: string, field: string, value: string | number): string;
  setCandidateStatus(src: string, candidateId: string, status: string, day?: number): string;
  insertCandidate(src: string, candidate: Candidate): string;
  addAttachment(src: string, itemId: string, attachment: Attachment): string;
  removeAttachment(src: string, itemId: string, file: string): string;
  findObjectById(src: string, id: string): { start: number; end: number } | null;
  listDayDates(src: string): string[];
  moveItem(src: string, itemId: string, toDate: string, beforeItemId?: string | null): string;
  insertItem(src: string, toDate: string, item: string | Record<string, unknown>, beforeItemId?: string | null): string;
  scheduleCandidate(src: string, candidateId: string, toDate: string, beforeItemId?: string | null): string;
  removeItem(src: string, itemId: string): string;
  setLocked(src: string, itemId: string, locked: boolean): string;
  setBooking(src: string, itemId: string, patch: Record<string, string | boolean | null>): string;
  setItemLoc(src: string, itemId: string, loc: { lat: number; lng: number }, fetchedAt: string): string;
  setDayAccepted(src: string, date: string, codes: string[]): string;
}

export type SearchFn = (
  deps: { root: string; env: Record<string, string | undefined>; fetch: FetchLike; now?: () => Date; throttle?: Throttle },
  query: string,
  extra: { near?: { lat: number; lng: number }; lang?: string },
) => Promise<ViewerSearchResult>;

export interface HandlerDeps {
  /** Repo root (absolute). */
  root: string;
  edits: SourceEdits;
  now?: () => Date;
  /** Network for `search` (defaults to global fetch). Tests inject a fake. */
  fetch?: FetchLike;
  /** Env for `search`: GOOGLE_MAPS_API_KEY selects Google, otherwise OpenStreetMap. */
  env?: Record<string, string | undefined>;
  /** Shared Nominatim throttle (defaults to the CLI's process-wide one). */
  throttle?: Throttle;
  /** Override the search implementation (defaults to cli/search.ts). */
  search?: SearchFn;
  /** Imports a trip module by absolute path (defaults to a fresh native `import()`); `optimize` uses it. */
  loadTrip?: (file: string) => Promise<Trip>;
  /** Remembers edits for `undo` / `redo` / `history`. Without it those endpoints are not available. */
  history?: EditHistory;
}

export interface HandlerResult {
  status: number;
  json: { ok: true; [k: string]: unknown } | { ok: false; error: string; /** Set by undo / redo so the viewer can refresh its buttons. */ history?: unknown };
}

export const ENDPOINTS = ['comment', 'item-field', 'candidate', 'inbox', 'current', 'search', 'add-candidate', 'attach', 'detach', 'new-trip', 'move-item', 'schedule-candidate', 'remove-item', 'set-locked', 'booking', 'meal', 'accept', 'optimize', 'undo', 'redo', 'history', 'cover', 'cover-remove', 'idea-new', 'idea', 'idea-list', 'idea-finish'] as const;
export type Endpoint = (typeof ENDPOINTS)[number];

const TRIP_ID_RE = /^[a-z0-9-]+$/;
const FILE_RE = /^[a-z0-9-]+\.ts$/;
const ANCHORS = ['item', 'gap', 'leg', 'day'];
const STATUSES = ['unconfirmed', 'accepted', 'discuss', 'rejected'];
const MAX_TEXT = 100_000;
const MAX_BODY = 1_000_000;
const MAX_TITLE = 120;
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
/** A cover is shrunk in the browser (about 1200 px wide), so it must fit in an ordinary request body. */
const MAX_COVER_BYTES = 700 * 1024;
/** base64 of 15 MB is 20 MB, plus the JSON envelope. Only `attach` may exceed MAX_BODY. */
const MAX_ATTACH_BODY = Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) + 100_000;
const ATTACHMENT_EXTS = ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'heic', 'pkpass'];
const ATTACHMENT_KINDS = ['transport', 'entry', 'booking', 'other'];
const OPTIMIZE_MODES = ['transit', 'walk', 'drive'] as const;
const LANG_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const TICKET_FILE_RE = /^tickets\/[a-z0-9][a-z0-9._-]*$/;

/** Request body size limit for an endpoint (bytes). */
export function bodyLimitFor(endpoint: string): number {
  return endpoint === 'attach' ? MAX_ATTACH_BODY : MAX_BODY;
}

/**
 * Turns an uploaded file name into a safe `[a-z0-9-_.]` name with a whitelisted extension.
 * Directory parts are dropped; throws (400) for anything else.
 */
export function sanitizeFilename(filename: string): { base: string; ext: string } {
  const leaf = filename.split(/[\\/]/).pop() ?? '';
  const dot = leaf.lastIndexOf('.');
  const ext = dot >= 0 ? leaf.slice(dot + 1).toLowerCase() : '';
  if (!ATTACHMENT_EXTS.includes(ext)) bad(`不支援的檔案類型（可用：${ATTACHMENT_EXTS.join('、')}）`);
  const base = leaf
    .slice(0, dot)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 60);
  return { base: base || 'ticket', ext };
}

/**
 * Kebab-case id from a title. Titles with no latin letters/digits (e.g. 「築地場外市場」) get
 * "place-<hash>" so different places stay distinguishable instead of becoming place, place-2, …
 */
export function slugify(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  if (slug) return slug;
  let h = 2166136261;
  for (const ch of title) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619) >>> 0;
  return `place-${h.toString(36).slice(0, 6)}`;
}

function title120(body: Record<string, unknown>, key: string): string {
  const v = singleLine(str(body, key, { max: 1000 }), key).trim();
  if (v === '') bad(`缺少或無效的欄位：${key}`);
  if (v.length > MAX_TITLE) bad(`${key} 過長（最多 ${MAX_TITLE} 字）`);
  return v;
}

function latLngOf(v: unknown, label: string): { lat: number; lng: number } {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) bad(`${label} 必須是 {lat, lng}`);
  const { lat, lng } = v as Record<string, unknown>;
  if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) bad(`${label}.lat 必須介於 -90 到 90`);
  if (typeof lng !== 'number' || !Number.isFinite(lng) || lng < -180 || lng > 180) bad(`${label}.lng 必須介於 -180 到 180`);
  return { lat, lng };
}

/** Imports the trip file fresh on every call (the mtime in the query defeats Node's module cache). */
async function importTrip(file: string): Promise<Trip> {
  const { mtimeMs } = await stat(file);
  const mod = await import(/* @vite-ignore */ `${pathToFileURL(file).href}?t=${mtimeMs}`);
  if (!mod.default) bad('行程檔沒有 default export');
  return mod.default as Trip;
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

class BadRequest extends Error {}

function bad(message: string): never {
  throw new BadRequest(message);
}

function str(body: Record<string, unknown>, key: string, opts: { max?: number } = {}): string {
  const v = body[key];
  if (typeof v !== 'string' || v.length === 0) bad(`缺少或無效的欄位：${key}`);
  if (v.length > (opts.max ?? 2000)) bad(`欄位過長：${key}`);
  return v;
}

function tripIdOf(body: Record<string, unknown>): string {
  const id = body.tripId;
  if (typeof id !== 'string' || !TRIP_ID_RE.test(id)) bad('無效的 tripId');
  return id;
}

function fileOf(body: Record<string, unknown>): string {
  const f = body.file;
  if (f === undefined || f === null) return 'trip.ts';
  if (typeof f !== 'string' || !FILE_RE.test(f)) bad('無效的 file');
  return f;
}

/** Control characters (newlines included) would break out of a string literal or comment line. */
function singleLine(s: string, label: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]|[^\S ]/.test(s)) bad(`${label} 不可包含換行或控制字元`);
  return s;
}

const REF_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A required reference to an existing item / candidate id. */
function refId(body: Record<string, unknown>, key: string): string {
  const v = singleLine(str(body, key, { max: 200 }), key);
  if (!REF_ID_RE.test(v)) bad(`無效的 ${key}`);
  return v;
}

/** `beforeItemId`: absent / null means "at the end of the day". */
function optionalRefId(body: Record<string, unknown>, key: string): string | undefined {
  return body[key] === undefined || body[key] === null ? undefined : refId(body, key);
}

/** Checks `toDate` is a date of the trip and the ids exist, so the pure edit can only fail on layout problems. */
function checkPlacement(edits: SourceEdits, src: string, toDate: string, ids: { itemId?: string; candidateId?: string; beforeItemId?: string }): void {
  if (!DATE_RE.test(toDate)) bad('toDate 必須是 YYYY-MM-DD');
  if (!edits.listDayDates(src).includes(toDate)) bad(`行程中沒有 ${toDate} 這一天`);
  if (ids.itemId && !edits.findObjectById(src, ids.itemId)) bad(`找不到 id 為「${ids.itemId}」的項目`);
  if (ids.candidateId && !edits.findObjectById(src, ids.candidateId)) bad(`找不到 id 為「${ids.candidateId}」的候選地點`);
  if (ids.beforeItemId !== undefined) {
    if (ids.beforeItemId === (ids.itemId ?? ids.candidateId)) bad('beforeItemId 不能是被移動的項目本身');
    if (!edits.findObjectById(src, ids.beforeItemId)) bad(`找不到 id 為「${ids.beforeItemId}」的項目`);
  }
}

/** Time fields must be HH:MM so the viewer can never write something `check` cannot parse. */
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_VALUE = 2000;

export interface GuardResult {
  status: number;
  error: string;
}

function hostnameOf(host: string): string {
  const h = host.toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1); // [::1]:5173
  return h.replace(/:\d*$/, '');
}

/** Same rule as Vite's `server.allowedHosts` default: localhost, *.localhost and IP literals. */
function hostAllowed(hostname: string, extra: readonly string[] = []): boolean {
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || /^\[[0-9a-f:.]+\]$/.test(hostname)) return true;
  return extra.some((h) => (h.startsWith('.') ? hostname === h.slice(1) || hostname.endsWith(h) : hostname === h));
}

/**
 * Browser-facing protection for the write API. A web page on another origin can POST to
 * http://localhost:<port> with a "simple" request (text/plain body, no preflight), and DNS
 * rebinding can make a hostile name resolve to 127.0.0.1. So: require a loopback/allowed Host,
 * a same-origin Origin (browsers always send Origin on cross-origin POST), no cross-site
 * Sec-Fetch-Site, and Content-Type: application/json (which forces a CORS preflight we never answer).
 * Non-browser clients (curl, tests) send no Origin and are unaffected.
 */
export function guardRequest(
  headers: IncomingHttpHeaders,
  opts: {
    allowedHosts?: readonly string[] | true;
    /** Pass false for GET/DELETE routes (the agent panel's), which have no body to type. */
    requireJson?: boolean;
  } = {},
): GuardResult | null {
  const host = headers.host?.toLowerCase();
  if (!host) return { status: 403, error: '缺少 Host 標頭' };
  if (opts.allowedHosts !== true && !hostAllowed(hostnameOf(host), opts.allowedHosts)) {
    return { status: 403, error: `不允許的 Host：${host}` };
  }
  const origin = headers.origin;
  if (origin !== undefined) {
    let originHost: string | undefined;
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      /* "null" and other opaque origins fall through to rejection */
    }
    if (originHost !== host) return { status: 403, error: '不允許跨來源請求' };
  }
  const site = headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return { status: 403, error: '不允許跨來源請求' };
  if (opts.requireJson !== false && !/^application\/json\s*(;|$)/i.test(headers['content-type'] ?? '')) {
    return { status: 415, error: 'Content-Type 必須是 application/json' };
  }
  return null;
}

/** Resolves `...parts` under `base` and refuses anything that escapes it. */
export function safeJoin(base: string, ...parts: string[]): string {
  const resolved = path.resolve(base, ...parts);
  const rel = path.relative(base, resolved);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) bad('路徑不在允許範圍內');
  return resolved;
}

async function atomicWrite(file: string, content: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, file);
}

export async function nextInboxName(inboxDir: string): Promise<string> {
  let max = 0;
  try {
    for (const name of await readdir(inboxDir)) {
      const m = /^(\d+)\.md$/.exec(name);
      if (m) max = Math.max(max, Number(m[1]));
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  return `${String(max + 1).padStart(2, '0')}.md`;
}

/** Endpoints that rewrite the trip file and can be undone. Uploads, inbox pastes and new trips write elsewhere. */
const UNDOABLE_LABELS: Record<string, string> = {
  comment: '留言',
  'item-field': '修改項目',
  candidate: '候選狀態',
  'add-candidate': '新增景點',
  'move-item': '調整順序',
  'schedule-candidate': '排入行程',
  'remove-item': '刪除項目',
  'set-locked': '鎖定或解鎖',
  booking: '訂票狀態',
  meal: '加入餐廳',
  accept: '這天就這樣',
};
const FIELD_LABELS: Record<string, string> = { title: '標題', start: '開始時間', end: '結束時間', flightNo: '航班號', bookingRef: '訂位代號', note: '備註' };

/** The item an edit touched, so undo can take the viewer back to it. */
function touchedItemId(b: Record<string, unknown>, json: Record<string, unknown>): string | undefined {
  for (const v of [b.itemId, b.candidateId, json.id, b.targetId]) {
    if (typeof v === 'string' && REF_ID_RE.test(v)) return v;
  }
  return undefined;
}

/**
 * Undo / redo / history on top of the edit endpoints. Every undoable endpoint is wrapped the same way:
 * read the trip file, run the edit, and when the file changed, remember before + after. That keeps the
 * per-endpoint code above free of history, and an edit that turns out to be a no-op records nothing.
 */
export async function handleTripcodeRequest(endpoint: string, body: unknown, deps: HandlerDeps): Promise<HandlerResult> {
  const history = deps.history;
  const isObject = typeof body === 'object' && body !== null && !Array.isArray(body);
  const wanted = endpoint === 'undo' || endpoint === 'redo' || endpoint === 'history' || endpoint in UNDOABLE_LABELS;
  if (!history || !isObject || !wanted) return handleCore(endpoint, body, deps);
  const b = body as Record<string, unknown>;

  let target: string;
  try {
    target = safeJoin(safeJoin(path.resolve(deps.root, 'trips'), tripIdOf(b)), fileOf(b));
  } catch (e) {
    return handleCore(endpoint, body, deps); // the core reports the bad tripId / file
  }

  if (endpoint === 'history') return { status: 200, json: { ok: true, history: history.info(target) } };

  if (endpoint === 'undo' || endpoint === 'redo') {
    let current: string;
    try {
      current = await readFile(target, 'utf8');
    } catch {
      return { status: 400, json: { ok: false, error: '找不到檔案' } };
    }
    const plan = history.plan(target, endpoint, current);
    if (!plan.ok) return { status: 409, json: { ok: false, error: plan.error, history: history.info(target) } };
    try {
      await atomicWrite(target, plan.content);
    } catch (e) {
      return { status: 500, json: { ok: false, error: e instanceof Error ? e.message : String(e) } };
    }
    plan.commit();
    return { status: 200, json: { ok: true, label: plan.entry.label, ...(plan.entry.itemId ? { itemId: plan.entry.itemId } : {}), history: history.info(target) } };
  }

  const before = await readFile(target, 'utf8').catch(() => null);
  const result = await handleCore(endpoint, body, deps);
  if (result.status !== 200 || before === null) return result;
  const after = await readFile(target, 'utf8').catch(() => null);
  if (after === null || after === before) return result;
  const fieldLabel = endpoint === 'item-field' && typeof b.field === 'string' ? FIELD_LABELS[b.field] : undefined;
  const itemId = touchedItemId(b, result.json);
  history.record(target, { label: fieldLabel ? `修改${fieldLabel}` : UNDOABLE_LABELS[endpoint]!, before, after, ...(itemId ? { itemId } : {}) });
  return { status: 200, json: { ...(result.json as { ok: true }), history: history.info(target) } };
}

async function handleCore(endpoint: string, body: unknown, deps: HandlerDeps): Promise<HandlerResult> {
  try {
    if (!(ENDPOINTS as readonly string[]).includes(endpoint)) bad(`未知的端點：${endpoint}`);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) bad('請求內容必須是 JSON 物件');
    const b = body as Record<string, unknown>;

    if (endpoint === 'search') {
      const q = singleLine(str(b, 'q', { max: 300 }), 'q').trim();
      if (q === '') bad('缺少或無效的欄位：q');
      const near = b.near === undefined || b.near === null ? undefined : latLngOf(b.near, 'near');
      let lang: string | undefined;
      if (b.lang !== undefined && b.lang !== null) {
        if (typeof b.lang !== 'string' || !LANG_RE.test(b.lang)) bad('無效的 lang');
        lang = b.lang;
      }
      const search: SearchFn = deps.search ?? (await import('./cli/search.ts')).searchForViewer;
      try {
        const r = await search(
          { root: deps.root, env: deps.env ?? process.env, fetch: deps.fetch ?? ((u, i) => fetch(u, i)), now: deps.now, throttle: deps.throttle },
          q,
          { near, lang },
        );
        return { status: 200, json: { ok: true, ...r } };
      } catch (e) {
        return { status: 502, json: { ok: false, error: `搜尋失敗：${e instanceof Error ? e.message : String(e)}` } };
      }
    }

    if (endpoint === 'idea-list') {
      // Unfinished ideas for the home page (the page does not load idea.json through a glob, see ideaIdOfPath).
      const { listIdeas } = await import('./cli/commands/idea.ts');
      return { status: 200, json: { ok: true, ideas: await listIdeas(deps.root) } };
    }

    const tripId = tripIdOf(b);
    const tripDir = safeJoin(path.resolve(deps.root, 'trips'), tripId);
    const today = (deps.now?.() ?? new Date()).toISOString();

    switch (endpoint as Endpoint) {
      case 'comment': {
        const file = fileOf(b);
        const targetId = singleLine(str(b, 'targetId', { max: 200 }), 'targetId');
        const anchor = typeof b.anchor === 'string' ? b.anchor : 'item';
        if (!ANCHORS.includes(anchor)) bad('無效的 anchor');
        const text = str(b, 'text', { max: 2000 }).replace(/\s+/g, ' ').trim();
        if (!text) bad('留言不可為空');
        const target = safeJoin(tripDir, file);
        const next = deps.edits.insertComment(await readFile(target, 'utf8'), targetId, text, anchor);
        await atomicWrite(target, next);
        return { status: 200, json: { ok: true } };
      }
      case 'item-field': {
        const file = fileOf(b);
        const itemId = singleLine(str(b, 'itemId', { max: 200 }), 'itemId');
        const field = str(b, 'field', { max: 50 });
        const value = b.value;
        if (typeof value === 'string') {
          singleLine(value, 'value');
          if (value.length > MAX_VALUE) bad('value 過長');
          if ((field === 'start' || field === 'end') && !HHMM_RE.test(value)) bad(`${field} 必須是 HH:MM`);
        } else if (typeof value !== 'number' || !Number.isFinite(value)) bad('value 必須是字串或數字');
        const target = safeJoin(tripDir, file);
        const next = deps.edits.setItemField(await readFile(target, 'utf8'), itemId, field, value);
        await atomicWrite(target, next);
        return { status: 200, json: { ok: true } };
      }
      case 'candidate': {
        const file = fileOf(b);
        const candidateId = singleLine(str(b, 'candidateId', { max: 200 }), 'candidateId');
        const status = b.status;
        if (typeof status !== 'string' || !STATUSES.includes(status)) bad('無效的 status');
        let day: number | undefined;
        if (b.day !== undefined && b.day !== null) {
          if (typeof b.day !== 'number' || !Number.isInteger(b.day) || b.day < 1) bad('day 必須是正整數');
          day = b.day;
        }
        const target = safeJoin(tripDir, file);
        const next = deps.edits.setCandidateStatus(await readFile(target, 'utf8'), candidateId, status, day);
        await atomicWrite(target, next);
        return { status: 200, json: { ok: true } };
      }
      case 'add-candidate': {
        const file = fileOf(b);
        const title = title120(b, 'title');
        const loc = latLngOf(b.loc, 'loc');
        let placeId: string | undefined;
        if (b.placeId !== undefined && b.placeId !== null) placeId = singleLine(str(b, 'placeId', { max: 200 }), 'placeId');
        const target = safeJoin(tripDir, file);
        const src = await readFile(target, 'utf8');
        let day: number | undefined;
        if (b.day !== undefined && b.day !== null) {
          const count = deps.edits.listDayDates(src).length;
          if (typeof b.day !== 'number' || !Number.isInteger(b.day) || b.day < 1 || b.day > count) bad(`day 必須是 1 到 ${count} 的整數`);
          day = b.day;
        }
        const base = slugify(title);
        let id = base;
        for (let n = 2; deps.edits.findObjectById(src, id); n++) id = `${base}-${n}`;
        const loc6 = { lat: round6(loc.lat), lng: round6(loc.lng), fetchedAt: today };
        if (day) {
          // With a day the place goes straight into the plan: a time-less poi at the end of that day.
          const date = deps.edits.listDayDates(src)[day - 1]!;
          const item = { id, kind: 'poi', title, ...(placeId ? { placeId } : {}), loc: loc6 };
          await atomicWrite(target, deps.edits.insertItem(src, date, item));
          return { status: 200, json: { ok: true, id, item, scheduled: true } };
        }
        const candidate: Candidate = {
          id,
          title,
          ...(placeId ? { placeId } : {}),
          loc: loc6,
          status: 'unconfirmed',
          sources: ['manual'],
        };
        await atomicWrite(target, deps.edits.insertCandidate(src, candidate));
        return { status: 200, json: { ok: true, id, candidate, scheduled: false } };
      }
      case 'move-item': {
        const file = fileOf(b);
        const itemId = refId(b, 'itemId');
        const toDate = str(b, 'toDate', { max: 20 });
        const beforeItemId = optionalRefId(b, 'beforeItemId');
        const target = safeJoin(tripDir, file);
        const src = await readFile(target, 'utf8');
        checkPlacement(deps.edits, src, toDate, { itemId, beforeItemId });
        await atomicWrite(target, deps.edits.moveItem(src, itemId, toDate, beforeItemId));
        return { status: 200, json: { ok: true, itemId, toDate } };
      }
      case 'schedule-candidate': {
        const file = fileOf(b);
        const candidateId = refId(b, 'candidateId');
        const toDate = str(b, 'toDate', { max: 20 });
        const beforeItemId = optionalRefId(b, 'beforeItemId');
        const target = safeJoin(tripDir, file);
        const src = await readFile(target, 'utf8');
        checkPlacement(deps.edits, src, toDate, { candidateId, beforeItemId });
        await atomicWrite(target, deps.edits.scheduleCandidate(src, candidateId, toDate, beforeItemId));
        return { status: 200, json: { ok: true, id: candidateId, toDate } };
      }
      case 'remove-item': {
        const file = fileOf(b);
        const itemId = refId(b, 'itemId');
        const target = safeJoin(tripDir, file);
        const src = await readFile(target, 'utf8');
        if (!deps.edits.findObjectById(src, itemId)) bad(`找不到 id 為「${itemId}」的項目`);
        await atomicWrite(target, deps.edits.removeItem(src, itemId));
        return { status: 200, json: { ok: true, itemId } };
      }
      case 'set-locked': {
        const file = fileOf(b);
        const itemId = refId(b, 'itemId');
        if (typeof b.locked !== 'boolean') bad('locked 必須是 true 或 false');
        const target = safeJoin(tripDir, file);
        const src = await readFile(target, 'utf8');
        if (!deps.edits.findObjectById(src, itemId)) bad(`找不到 id 為「${itemId}」的項目`);
        const next = deps.edits.setLocked(src, itemId, b.locked);
        if (next !== src) await atomicWrite(target, next);
        return { status: 200, json: { ok: true, itemId, locked: b.locked } };
      }
      case 'booking': {
        // 「我買好了」 / 「不需要」 / back to 待買. One write: undo takes it all back.
        const file = fileOf(b);
        const itemId = refId(b, 'itemId');
        const action = b.action;
        if (action !== 'booked' && action !== 'not-needed' && action !== 'todo') bad('action 必須是 booked、not-needed 或 todo');
        const need = b.need === undefined || b.need === null ? 'unknown' : b.need;
        if (!['required', 'recommended', 'none', 'unknown'].includes(String(need))) bad('無效的 need');
        const via = b.via === undefined || b.via === null || b.via === '' ? undefined : singleLine(str(b, 'via', { max: 60 }), 'via');
        const target = safeJoin(tripDir, file);
        let src = await readFile(target, 'utf8');
        if (!deps.edits.findObjectById(src, itemId)) bad(`找不到 id 為「${itemId}」的項目`);
        if (action === 'booked') {
          src = deps.edits.setBooking(src, itemId, { need: String(need) === 'none' ? 'unknown' : String(need), status: 'booked', bookedAt: today, boughtVia: via ?? null });
          src = deps.edits.setLocked(src, itemId, true);
          for (const field of ['start', 'end'] as const) {
            const v = b[field];
            if (v === undefined || v === null || v === '') continue;
            if (typeof v !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) bad(`${field} 必須是 HH:MM`);
            src = deps.edits.setItemField(src, itemId, field, v);
          }
        } else if (action === 'not-needed') {
          src = deps.edits.setBooking(src, itemId, { need: 'none', status: 'not-needed' });
        } else {
          try {
            src = deps.edits.setBooking(src, itemId, { status: 'todo', bookedAt: null, boughtVia: null });
          } catch {
            // No booking field yet (the row was guessed from `locked` or the kind): write one, because an explicit status wins.
            src = deps.edits.setBooking(src, itemId, { need: String(need) === 'none' ? 'unknown' : String(need), status: 'todo' });
          }
        }
        await atomicWrite(target, src);
        return { status: 200, json: { ok: true, itemId, action } };
      }
      case 'accept': {
        // 「這天就這樣」: the user looked at a day-structure note and accepts it for that day.
        const file = fileOf(b);
        const date = str(b, 'date', { max: 20 });
        if (!DATE_RE.test(date)) bad('date 必須是 YYYY-MM-DD');
        if (!Array.isArray(b.codes) || b.codes.length > 10 || !b.codes.every((c) => typeof c === 'string' && ['walking-heavy', 'day-time-tight', 'no-easy-day'].includes(c))) bad('codes 必須是 walking-heavy、day-time-tight、no-easy-day 的清單');
        const target = safeJoin(tripDir, file);
        const src = await readFile(target, 'utf8');
        if (!deps.edits.listDayDates(src).includes(date)) bad(`行程中沒有 ${date} 這一天`);
        const next = deps.edits.setDayAccepted(src, date, b.codes as string[]);
        if (next !== src) await atomicWrite(target, next);
        return { status: 200, json: { ok: true, date } };
      }
      case 'meal': {
        // Put a restaurant into a meal gap: fill the placeholder meal, or add a new meal item.
        const file = fileOf(b);
        const date = str(b, 'date', { max: 20 });
        if (!DATE_RE.test(date)) bad('date 必須是 YYYY-MM-DD');
        const existing = optionalRefId(b, 'existingItemId');
        const beforeItemId = optionalRefId(b, 'beforeItemId');
        const { parseMapsLink } = await import('./src/core/meals.ts');
        let place: { name?: string; loc?: { lat: number; lng: number } } = {};
        if (typeof b.mapsUrl === 'string' && b.mapsUrl.trim() !== '') {
          try {
            place = parseMapsLink(singleLine(b.mapsUrl.trim(), 'mapsUrl'));
          } catch (e) {
            bad(e instanceof Error ? e.message : String(e));
          }
        }
        const typed = typeof b.title === 'string' ? singleLine(b.title, 'title').trim() : '';
        const title = typed || place.name || '';
        if (title === '' || title.length > MAX_TITLE) bad('請輸入店名，或貼上含店名的 Google 地圖連結');
        const target = safeJoin(tripDir, file);
        let src = await readFile(target, 'utf8');
        if (existing) {
          if (!deps.edits.findObjectById(src, existing)) bad(`找不到 id 為「${existing}」的項目`);
          src = deps.edits.setItemField(src, existing, 'title', title);
          if (place.loc) src = deps.edits.setItemLoc(src, existing, place.loc, today);
          await atomicWrite(target, src);
          return { status: 200, json: { ok: true, id: existing, title } };
        }
        checkPlacement(deps.edits, src, date, { beforeItemId });
        const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
        let id = `meal-${slug || 'x'}-${date.slice(5).replace('-', '')}`;
        for (let n = 2; deps.edits.findObjectById(src, id); n++) id = `meal-${slug || 'x'}-${date.slice(5).replace('-', '')}-${n}`;
        const item: Record<string, unknown> = { id, kind: 'meal', title };
        if (place.loc) item.loc = { lat: place.loc.lat, lng: place.loc.lng, fetchedAt: today };
        await atomicWrite(target, deps.edits.insertItem(src, date, item, beforeItemId));
        return { status: 200, json: { ok: true, id, title } };
      }
      case 'optimize': {
        // Read-only: proposes an order, never writes the trip file.
        const file = fileOf(b);
        if (typeof b.day !== 'number' || !Number.isInteger(b.day) || b.day < 1) bad('day 必須是正整數（從 1 開始）');
        let mode: (typeof OPTIMIZE_MODES)[number] = 'transit';
        if (b.mode !== undefined && b.mode !== null) {
          if (typeof b.mode !== 'string' || !(OPTIMIZE_MODES as readonly string[]).includes(b.mode)) bad('mode 必須是 transit、walk 或 drive');
          mode = b.mode as typeof mode;
        }
        const target = safeJoin(tripDir, file);
        const trip = await (deps.loadTrip ?? importTrip)(target).catch((e: unknown) => {
          if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') bad('找不到行程檔');
          bad(`無法載入行程檔：${e instanceof Error ? e.message : String(e)}`);
        });
        const day = trip.days[b.day - 1];
        if (!day) bad(`這個行程只有 ${trip.days.length} 天，沒有第 ${b.day} 天`);
        const { routableStops, optimizeDay } = await import('./src/core/optimize.ts');
        const { buildMatrix, ESTIMATE_SOURCE } = await import('./cli/commands/optimize.ts');
        const stops = routableStops(day);
        if (stops.length < 2) {
          return {
            status: 200,
            json: { ok: true, currentMinutes: 0, bestMinutes: 0, savedMinutes: 0, order: stops.map((s) => s.id), source: ESTIMATE_SOURCE, confidence: 'reference', changed: false, notes: ['這天少於 2 個可排路線的地點，不需要最佳化'] },
          };
        }
        const env = deps.env ?? process.env;
        const mopts = { apiKey: env.GOOGLE_MAPS_API_KEY?.trim() || undefined, fetch: deps.fetch ?? ((u: string, i?: RequestInit) => fetch(u, i)), now: deps.now ?? (() => new Date()) };
        let built;
        try {
          built = await buildMatrix(mopts, stops, mode);
        } catch (e) {
          if (!mopts.apiKey) bad(e instanceof Error ? e.message : String(e));
          // Google failed (quota, network, too many stops): fall back to the estimate rather than showing nothing.
          try {
            built = await buildMatrix({ ...mopts, offline: true }, stops, mode);
          } catch {
            return { status: 502, json: { ok: false, error: `路線查詢失敗：${e instanceof Error ? e.message : String(e)}` } };
          }
          built.notes.unshift(`Google 路線查詢失敗（${e instanceof Error ? e.message : String(e)}），改用直線估算（參考值）`);
        }
        const result = optimizeDay(day, built.matrix);
        const current = stops.map((s) => s.id);
        return {
          status: 200,
          json: {
            ok: true,
            currentMinutes: result.before,
            bestMinutes: result.after,
            savedMinutes: result.before - result.after,
            order: result.order,
            source: built.source,
            confidence: built.confidence,
            changed: result.order.some((id, i) => id !== current[i]),
            moves: result.moves,
            notes: built.notes,
          },
        };
      }
      case 'attach': {
        const file = fileOf(b);
        const itemId = singleLine(str(b, 'itemId', { max: 200 }), 'itemId');
        const label = title120(b, 'label');
        let kind: Attachment['kind'];
        if (b.kind !== undefined && b.kind !== null) {
          if (typeof b.kind !== 'string' || !ATTACHMENT_KINDS.includes(b.kind)) bad('無效的 kind');
          kind = b.kind as Attachment['kind'];
        }
        const { base, ext } = sanitizeFilename(singleLine(str(b, 'filename', { max: 300 }), 'filename'));
        const data = b.dataBase64;
        if (typeof data !== 'string' || data === '') bad('缺少或無效的欄位：dataBase64');
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4 !== 0) bad('dataBase64 不是有效的 base64');
        if ((data.length / 4) * 3 > MAX_ATTACHMENT_BYTES + 3) bad('檔案過大（上限 15 MB）');
        const bytes = Buffer.from(data, 'base64');
        if (bytes.length === 0) bad('檔案是空的');
        if (bytes.length > MAX_ATTACHMENT_BYTES) bad('檔案過大（上限 15 MB）');
        if (!(await stat(tripDir).then((st) => st.isDirectory(), () => false))) bad('找不到這個旅程');
        const target = safeJoin(tripDir, file);
        const src = await readFile(target, 'utf8');
        // The file is written first (to learn its unique name); if the source edit then fails it is removed again.
        const ticketsDir = safeJoin(tripDir, 'tickets');
        await mkdir(ticketsDir, { recursive: true });
        let name = '';
        let written = false;
        for (let n = 1; n <= 200 && !written; n++) {
          name = n === 1 ? `${base}.${ext}` : `${base}-${n}.${ext}`;
          try {
            await writeFile(safeJoin(ticketsDir, name), bytes, { flag: 'wx' });
            written = true;
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
          }
        }
        if (!written) bad('無法建立附件檔案，請重試');
        const attachment: Attachment = { file: `tickets/${name}`, label, ...(kind ? { kind } : {}) };
        try {
          await atomicWrite(target, deps.edits.addAttachment(src, itemId, attachment));
        } catch (e) {
          await unlink(safeJoin(ticketsDir, name)).catch(() => undefined);
          throw e;
        }
        return { status: 200, json: { ok: true, file: attachment.file, attachment } };
      }
      case 'detach': {
        const file = fileOf(b);
        const itemId = singleLine(str(b, 'itemId', { max: 200 }), 'itemId');
        const attachmentFile = str(b, 'attachmentFile', { max: 200 });
        if (!TICKET_FILE_RE.test(attachmentFile) || attachmentFile.includes('..')) bad('無效的 attachmentFile');
        const target = safeJoin(tripDir, file);
        const next = deps.edits.removeAttachment(await readFile(target, 'utf8'), itemId, attachmentFile);
        await atomicWrite(target, next);
        // Keep the file when another item still references it.
        const stillUsed = next.includes(`'${attachmentFile}'`) || next.includes(`"${attachmentFile}"`);
        let deleted = false;
        if (!stillUsed) {
          try {
            await unlink(safeJoin(tripDir, attachmentFile));
            deleted = true;
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
          }
        }
        return { status: 200, json: { ok: true, deleted } };
      }
      case 'cover': {
        // The viewer shrinks the photo to a JPEG first, so only a (small) JPEG is accepted: trips/<id>/cover.jpg.
        const data = b.dataBase64;
        if (typeof data !== 'string' || data === '') bad('缺少或無效的欄位：dataBase64');
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4 !== 0) bad('dataBase64 不是有效的 base64');
        const bytes = Buffer.from(data, 'base64');
        if (bytes.length > MAX_COVER_BYTES) bad('封面太大（上限 700 KB）：請換一張或先縮小');
        if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) bad('封面必須是 JPEG 圖片');
        if (!(await stat(tripDir).then((st) => st.isDirectory(), () => false))) bad('找不到這個旅程');
        const target = safeJoin(tripDir, 'cover.jpg');
        const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
        await writeFile(tmp, bytes);
        await rename(tmp, target);
        return { status: 200, json: { ok: true, file: 'cover.jpg', bytes: bytes.length } };
      }
      case 'cover-remove': {
        if (!(await stat(tripDir).then((st) => st.isDirectory(), () => false))) bad('找不到這個旅程');
        let removed = true;
        try {
          await unlink(safeJoin(tripDir, 'cover.jpg'));
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
          removed = false;
        }
        return { status: 200, json: { ok: true, removed } };
      }
      case 'idea-new': {
        // Step 0 (找方向): creates trips/<id>/idea.json. One of only two endpoints that create a folder (the other is idea-finish).
        const { createIdea } = await import('./cli/commands/idea.ts');
        const { nextStep } = await import('./src/core/idea.ts');
        const idea = await createIdea(deps.root, tripId, deps.now?.() ?? new Date());
        return { status: 200, json: { ok: true, tripId, idea, next: nextStep(idea) } };
      }
      case 'idea': {
        // Plain file operations on an existing idea.json, never undoable. The AI adds places through the CLI only, so there is no 'places' op.
        const core = await import('./src/core/idea.ts');
        const { updateIdea } = await import('./cli/commands/idea.ts');
        const now = deps.now?.() ?? new Date();
        const op = b.op;
        if (typeof op !== 'string') bad('缺少或無效的欄位：op');
        if (op === 'get') {
          // Read-only: the page refetches after a `tripcode:idea` event instead of loading the file with a glob.
          const { readIdea } = await import('./cli/commands/idea.ts');
          const idea = await readIdea(deps.root, tripId);
          return { status: 200, json: { ok: true, idea, next: core.nextStep(idea) } };
        }
        let fn: (idea: import('./src/core/idea.ts').Idea) => import('./src/core/idea.ts').Idea;
        switch (op) {
          case 'answer': {
            const field = str(b, 'field', { max: 40 });
            if (!(core.ANSWER_FIELDS as readonly string[]).includes(field)) bad('無效的 field');
            if (!('value' in b)) bad('缺少欄位：value');
            fn = (i) => core.applyAnswer(i, { field, value: b.value } as import('./src/core/idea.ts').IdeaAnswer, now);
            break;
          }
          case 'choose': {
            const placeId = str(b, 'placeId', { max: 80 });
            fn = (i) => core.choosePlace(i, placeId, now);
            break;
          }
          case 'reject': {
            const placeId = str(b, 'placeId', { max: 80 });
            fn = (i) => core.rejectPlace(i, placeId, now);
            break;
          }
          case 'reject-round':
            fn = (i) => core.rejectRound(i, now);
            break;
          case 'dates': {
            const start = str(b, 'start', { max: 20 });
            const end = str(b, 'end', { max: 20 });
            fn = (i) => core.setDates(i, start, end, now);
            break;
          }
          default:
            bad('無效的 op（可用：get、answer、choose、reject、reject-round、dates）');
        }
        const idea = await updateIdea(deps.root, tripId, fn!);
        return { status: 200, json: { ok: true, idea, next: core.nextStep(idea) } };
      }
      case 'idea-finish': {
        // Creates the real trip from a finished idea: same files as `tripcode new`, plus idea.json moved in.
        const input: import('./cli/commands/idea.ts').FinishInput = {};
        if (b.title !== undefined && b.title !== null) input.title = title120(b, 'title');
        if (b.tz !== undefined && b.tz !== null) input.tz = singleLine(str(b, 'tz', { max: 64 }), 'tz');
        if (b.adults !== undefined && b.adults !== null) {
          if (typeof b.adults !== 'number' || !Number.isInteger(b.adults)) bad('adults 必須是整數');
          input.adults = String(b.adults);
        }
        if (b.childrenAges !== undefined && b.childrenAges !== null) {
          const ages = b.childrenAges;
          if (!Array.isArray(ages) || ages.length > 20 || !ages.every((a) => typeof a === 'number' && Number.isInteger(a) && a >= 0 && a <= 17)) {
            bad('childrenAges 必須是 0–17 的整數陣列');
          }
          if (ages.length) input.children = ages.join(',');
        }
        const { finishIdea } = await import('./cli/commands/idea.ts');
        const r = await finishIdea(deps.root, tripId, input, deps.now?.() ?? new Date());
        return { status: 200, json: { ok: true, tripId: r.tripId, files: r.files } };
      }
      case 'new-trip': {
        const title = title120(b, 'title');
        for (const k of ['start', 'end', 'tz'] as const) if (typeof b[k] !== 'string') bad(`缺少或無效的欄位：${k}`);
        let adults: string | undefined;
        if (b.adults !== undefined && b.adults !== null) {
          if (typeof b.adults !== 'number' || !Number.isInteger(b.adults)) bad('adults 必須是整數');
          adults = String(b.adults);
        }
        let children: string | undefined;
        if (b.childrenAges !== undefined && b.childrenAges !== null) {
          const ages = b.childrenAges;
          if (!Array.isArray(ages) || ages.length > 20 || !ages.every((a) => typeof a === 'number' && Number.isInteger(a) && a >= 0 && a <= 17)) {
            bad('childrenAges 必須是 0–17 的整數陣列');
          }
          children = ages.length ? ages.join(',') : undefined;
        }
        const { buildNewTripOptions, createTripFiles } = await import('./cli/commands/new-trip.ts');
        const opts = buildNewTripOptions(
          { tripId, title, start: b.start as string, end: b.end as string, tz: b.tz as string, adults, children },
          today.slice(0, 10),
        );
        const files = await createTripFiles(deps.root, opts);
        return { status: 200, json: { ok: true, tripId, files, days: opts.dates.length } };
      }
      case 'inbox': {
        const text = b.text;
        if (typeof text !== 'string' || text.trim() === '') bad('缺少或無效的欄位：text');
        if (text.length > MAX_TEXT) bad('文字過長');
        // Never create trips/<id>/ implicitly: a typo or a hostile id must not litter the repo.
        if (!(await stat(tripDir).then((st) => st.isDirectory(), () => false))) bad('找不到這個旅程');
        const inboxDir = safeJoin(tripDir, 'inbox');
        await mkdir(inboxDir, { recursive: true });
        const createdAt = (deps.now?.() ?? new Date()).toISOString();
        const content = `---\nstatus: pending\ncreatedAt: ${createdAt}\n---\n${text}\n`;
        // 'wx' guards against two simultaneous pastes picking the same number.
        for (let attempt = 0; attempt < 5; attempt++) {
          const name = await nextInboxName(inboxDir);
          try {
            await writeFile(safeJoin(inboxDir, name), content, { encoding: 'utf8', flag: 'wx' });
            return { status: 200, json: { ok: true, file: `inbox/${name}` } };
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
          }
        }
        bad('無法建立收件匣檔案，請重試');
        break;
      }
      case 'current': {
        const file = fileOf(b);
        const current: Record<string, unknown> = { tripId, file };
        if (b.day !== undefined && b.day !== null) {
          if (typeof b.day !== 'string' && typeof b.day !== 'number') bad('無效的 day');
          if (typeof b.day === 'string') singleLine(b.day, 'day');
          current.day = b.day;
        }
        if (b.itemId !== undefined && b.itemId !== null) {
          current.itemId = singleLine(str(b, 'itemId', { max: 200 }), 'itemId');
        }
        current.updatedAt = (deps.now?.() ?? new Date()).toISOString();
        const dir = path.resolve(deps.root, 'node_modules', '.tripcode');
        await mkdir(dir, { recursive: true });
        await atomicWrite(path.join(dir, 'current.json'), JSON.stringify(current, null, 2) + '\n');
        return { status: 200, json: { ok: true } };
      }
    }
    return { status: 400, json: { ok: false, error: '未處理的請求' } };
  } catch (e) {
    if (e instanceof BadRequest) return { status: 400, json: { ok: false, error: e.message } };
    // Edit helpers throw plain Errors for unknown ids / disallowed fields: report as 400.
    const err = e as NodeJS.ErrnoException;
    const message = err.code === 'ENOENT' ? '找不到檔案' : err instanceof Error ? err.message : String(e);
    return { status: 400, json: { ok: false, error: message } };
  }
}

function readBody(req: IncomingMessage, limit = MAX_BODY): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooBig = false;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      if (tooBig) return; // keep draining so the 400 below can still be delivered
      size += c.length;
      if (size > limit) {
        tooBig = true;
        chunks.length = 0;
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => (tooBig ? reject(new BadRequest('請求內容過大')) : resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, json: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(json));
}

/**
 * The idea id when `file` is <root>/trips/<id>/idea.json, else undefined. The viewer's idea page listens for these
 * (server.watcher -> HMR custom event) instead of importing the file, so an answer never reloads the page.
 */
export function ideaIdOfPath(root: string, file: string): string | undefined {
  const rel = path.relative(path.resolve(root, 'trips'), file).split(path.sep);
  return rel.length === 2 && rel[1] === 'idea.json' && TRIP_ID_RE.test(rel[0]!) ? rel[0] : undefined;
}

export default function tripcodePlugin(): Plugin {
  return {
    name: 'tripcode',
    configureServer(server) {
      const root = server.config.root;
      const allowedHosts = server.config.server.allowedHosts;
      // .env is not in process.env under Vite; `search` needs GOOGLE_MAPS_API_KEY from it (like the CLI).
      const env: Record<string, string | undefined> = { ...loadEnv(server.config.mode, root, ''), ...process.env };
      let editsPromise: Promise<SourceEdits> | undefined;
      const loadEdits = () =>
        (editsPromise ??= import('./src/core/source-edit.ts') as unknown as Promise<SourceEdits>);

      // One undo history per dev server: it lives (and dies) with this process, like an editor's.
      let historyPromise: Promise<EditHistory> | undefined;
      const loadHistory = () => (historyPromise ??= import('./src/core/history.ts').then((m) => new m.EditHistory()));

      server.middlewares.use('/__tripcode', async (req, res) => {
        const endpoint = (req.url ?? '').split('?')[0]!.replace(/^\/+|\/+$/g, '');
        if (req.method !== 'POST') return send(res, 405, { ok: false, error: '僅支援 POST' });
        const denied = guardRequest(req.headers, { allowedHosts });
        if (denied) return send(res, denied.status, { ok: false, error: denied.error });
        const limit = bodyLimitFor(endpoint);
        if (Number(req.headers['content-length']) > limit) return send(res, 413, { ok: false, error: '請求內容過大' });
        try {
          let body: unknown;
          try {
            body = JSON.parse(await readBody(req, limit));
          } catch (e) {
            if (e instanceof BadRequest) return send(res, 400, { ok: false, error: e.message });
            return send(res, 400, { ok: false, error: '無效的 JSON' });
          }
          const result = await handleTripcodeRequest(endpoint, body, { root, edits: await loadEdits(), env, history: await loadHistory() });
          send(res, result.status, result.json);
        } catch (e) {
          send(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      });

      // Step 0: tell open idea pages that an idea.json changed (written by the CLI, the AI or the page itself).
      // Batched per id because an atomic write shows up as several watcher events.
      const ideaTimers = new Map<string, ReturnType<typeof setTimeout>>();
      const onIdeaFile = (file: string) => {
        const id = ideaIdOfPath(root, file);
        if (!id) return;
        clearTimeout(ideaTimers.get(id));
        ideaTimers.set(
          id,
          setTimeout(() => {
            ideaTimers.delete(id);
            server.ws.send({ type: 'custom', event: 'tripcode:idea', data: { tripId: id } });
          }, 60),
        );
      };
      for (const ev of ['add', 'change', 'unlink'] as const) server.watcher.on(ev, onIdeaFile);

      // In-viewer agent panel (src/agent/): Claude Code, driven through the Agent SDK, edits trips/ here.
      // Loaded on first use so the plugin (and its tests) never pull in the agent code otherwise.
      let agentPromise: Promise<import('./src/agent/routes.ts').AgentRoutes> | undefined;
      const loadAgent = () =>
        (agentPromise ??= import('./src/agent/routes.ts').then((m) =>
          m.createAgentRoutes({ root, guard: (headers, o) => guardRequest(headers, { allowedHosts, requireJson: o.requireJson }) }),
        ));
      server.middlewares.use('/__agent', (req, res, next) => {
        loadAgent().then(
          (agent) => agent.handle(req, res, next),
          (e: unknown) => send(res, 500, { error: e instanceof Error ? e.message : String(e) }),
        );
      });
      server.httpServer?.on('close', () => {
        void agentPromise?.then((agent) => agent.close());
      });

      // 採購辦公室 (src/purchase/routes.ts): a read-only snapshot plus a few safe buttons. It cannot pay.
      let buyPromise: Promise<import('./src/purchase/routes.ts').BuyRoutes> | undefined;
      const loadBuy = () =>
        (buyPromise ??= import('./src/purchase/routes.ts').then((m) =>
          m.createBuyRoutes({ root, env, guard: (headers, o) => guardRequest(headers, { allowedHosts, requireJson: o.requireJson }) }),
        ));
      server.middlewares.use('/__buy', (req, res, next) => {
        loadBuy().then(
          (buy) => buy.handle(req, res, next),
          (e: unknown) => send(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) }),
        );
      });
    },
  };
}
