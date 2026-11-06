// Files for one trip's purchase layer: trips/<id>/purchase/{watches,samples,alerts}.json.
// They are plain JSON written atomically, git-ignored (they name merchants and prices the user cares about),
// and none of them ever contains card data.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PurchaseError } from './types.ts';
import type { Alert, Sample, Watch } from './types.ts';

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_SAMPLES = 2000;
const MAX_ALERTS = 300;

export function purchaseDir(root: string, tripId: string): string {
  return path.join(root, 'trips', tripId, 'purchase');
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw new PurchaseError(`無法讀取 ${path.basename(file)}：${e instanceof Error ? e.message : String(e)}`);
  }
}

async function writeJson(file: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  await rename(tmp, file);
}

export const loadWatches = (dir: string) => readJson<Watch[]>(path.join(dir, 'watches.json'), []);
export const saveWatches = (dir: string, v: Watch[]) => writeJson(path.join(dir, 'watches.json'), v);
export const loadSamples = (dir: string) => readJson<Sample[]>(path.join(dir, 'samples.json'), []);
export const saveSamples = (dir: string, v: Sample[]) => writeJson(path.join(dir, 'samples.json'), v.slice(-MAX_SAMPLES));
export const loadAlerts = (dir: string) => readJson<Alert[]>(path.join(dir, 'alerts.json'), []);
export const saveAlerts = (dir: string, v: Alert[]) => writeJson(path.join(dir, 'alerts.json'), v.slice(-MAX_ALERTS));

// ---------- validation ----------

function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h.includes(':')) return true; // IPv6 literals
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** https only, no credentials, no local or private addresses (a watch must not be a way to poke the user's network). */
export function checkHttpsUrl(raw: string, opts: { allowLocal?: boolean } = {}): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new PurchaseError(`不是有效的網址：${raw}`);
  }
  const localOk = opts.allowLocal === true;
  if (u.protocol !== 'https:' && !(localOk && u.protocol === 'http:')) throw new PurchaseError(`只接受 https 網址：${raw}`);
  if (u.username || u.password) throw new PurchaseError('網址不可包含帳號或密碼');
  if (!localOk && isPrivateHost(u.hostname)) throw new PurchaseError(`不接受本機或內網位址：${u.hostname}`);
  return u;
}

export function checkId(id: unknown, what = 'id'): string {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new PurchaseError(`${what} 必須是小寫英數字與 -（最多 64 字）：${String(id)}`);
  return id;
}

function checkRegex(source: string): void {
  if (source.length > 300) throw new PurchaseError('regex 太長（上限 300 字）');
  try {
    new RegExp(source, 'i');
  } catch {
    throw new PurchaseError(`regex 無法編譯：${source}`);
  }
}

function posNumber(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new PurchaseError(`${name} 必須是大於 0 的數字`);
  return v;
}

export function validateWatch(input: Partial<Watch> & { id?: string; url?: string }, now: Date, opts: { allowLocal?: boolean } = {}): Watch {
  const id = checkId(input.id);
  const title = (input.title ?? '').trim();
  if (!title || title.length > 120) throw new PurchaseError('title 不可為空且最多 120 字');
  const url = checkHttpsUrl(input.url ?? '', opts).toString();
  const kind = input.kind ?? 'price';
  if (kind !== 'price' && kind !== 'availability') throw new PurchaseError('kind 必須是 price 或 availability');
  const everyMinutes = input.everyMinutes ?? 360;
  if (!Number.isInteger(everyMinutes) || everyMinutes < 60 || everyMinutes > 10080) {
    throw new PurchaseError('everyMinutes 必須是 60 到 10080 之間的整數（一小時一次是上限；固定價格的景點票不需要排程）');
  }
  const w: Watch = { id, title, url, kind, everyMinutes, active: input.active ?? true, createdAt: input.createdAt ?? now.toISOString() };
  if (input.itemId !== undefined) w.itemId = checkId(input.itemId, 'itemId');
  if (input.currency !== undefined) {
    if (!/^[A-Z]{3}$/.test(input.currency)) throw new PurchaseError('currency 必須是 ISO 4217 三碼大寫，例如 EUR');
    w.currency = input.currency;
  }
  if (input.targetPrice !== undefined) w.targetPrice = posNumber(input.targetPrice, 'targetPrice');
  if (input.dropPercent !== undefined) {
    const d = posNumber(input.dropPercent, 'dropPercent');
    if (d > 90) throw new PurchaseError('dropPercent 上限 90');
    w.dropPercent = d;
  }
  if (input.regex !== undefined) {
    checkRegex(input.regex);
    w.regex = input.regex;
  }
  if (input.opensAt !== undefined) {
    if (Number.isNaN(Date.parse(input.opensAt))) throw new PurchaseError('opensAt 必須是 ISO 日期時間，例如 2027-01-15T10:00:00+01:00');
    w.opensAt = input.opensAt;
  }
  if (input.render === true) w.render = true;
  if (input.until !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.until)) throw new PurchaseError('until 必須是 YYYY-MM-DD');
    w.until = input.until;
  }
  if (kind === 'price' && w.targetPrice === undefined && w.dropPercent === undefined) {
    throw new PurchaseError('價格監控需要 targetPrice（目標價）或 dropPercent（降幅）至少一個，否則永遠不會提醒你');
  }
  return w;
}
