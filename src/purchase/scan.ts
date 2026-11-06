// Runs the watches that are due: one polite GET per page, then decides which readings are worth an alert.
// No logins, no cookies, no captcha handling, no retries inside one run: a page that will not be read is
// reported as unreadable, not worked around.
import { extractAvailability, extractPrice } from './price.ts';
import { loadAlerts, loadSamples, loadWatches, saveAlerts, saveSamples } from './store.ts';
import type { Alert, AlertKind, Sample, Watch } from './types.ts';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ScanDeps {
  fetch: FetchLike;
  now: () => Date;
  /** Returns the page as the browser sees it after JavaScript ran. Needed only for watches with `render`. */
  render?: (url: string) => Promise<string>;
}

export interface ScanResult {
  watchId: string;
  sample: Sample;
}

const UNREADABLE_AFTER = 3;
const FETCH_TIMEOUT_MS = 15_000;
const USER_AGENT = 'TripCode (open-source travel planner; personal low-frequency price check)';

const MONEY = new Intl.NumberFormat('en', { maximumFractionDigits: 2 });
const fmt = (amount: number, currency?: string) => `${currency ? currency + ' ' : ''}${MONEY.format(amount)}`;

export function isDue(w: Watch, lastAt: string | undefined, now: Date, force = false): boolean {
  if (!w.active) return false;
  if (w.until && now.getTime() > Date.parse(`${w.until}T23:59:59Z`)) return false;
  if (force || !lastAt) return true;
  return now.getTime() - Date.parse(lastAt) >= w.everyMinutes * 60_000;
}

function lastSample(samples: Sample[], watchId: string): Sample | undefined {
  for (let i = samples.length - 1; i >= 0; i--) if (samples[i]!.watchId === watchId) return samples[i];
  return undefined;
}

function lastGood(samples: Sample[], watchId: string, pick: (s: Sample) => boolean): Sample | undefined {
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i]!;
    if (s.watchId === watchId && s.ok && pick(s)) return s;
  }
  return undefined;
}

function trailingFailures(samples: Sample[], watchId: string): number {
  let n = 0;
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i]!;
    if (s.watchId !== watchId) continue;
    if (s.ok) break;
    n++;
  }
  return n;
}

async function look(w: Watch, deps: ScanDeps): Promise<Sample> {
  const at = deps.now().toISOString();
  try {
    let html: string;
    if (w.render) {
      if (!deps.render) return { watchId: w.id, at, ok: false, error: '這個監控要用 Chrome 讀，但目前沒有可用的瀏覽器（請安裝 Google Chrome）' };
      html = await deps.render(w.url);
    } else {
      const res = await deps.fetch(w.url, {
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml', 'accept-language': 'zh-TW,en;q=0.8' },
        redirect: 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return { watchId: w.id, at, ok: false, error: `HTTP ${res.status}` };
      html = await res.text();
    }
    if (w.kind === 'availability') {
      const available = extractAvailability(html, { regex: w.regex });
      return available === undefined ? { watchId: w.id, at, ok: false, error: '頁面沒有宣告是否可購買（試試 --regex）' } : { watchId: w.id, at, ok: true, available };
    }
    const reading = extractPrice(html, { regex: w.regex });
    if (!reading) {
      return {
        watchId: w.id,
        at,
        ok: false,
        error: w.render
          ? '讀不到價格（頁面可能卡在同意頁或需要登入：用 buy browser open 打開這頁，自己點一次同意；也可以加 --regex）'
          : '讀不到價格（頁面可能由 JavaScript 產生：改用 --render 讓 Chrome 讀；或加 --regex，或改用人工查價）',
      };
    }
    if (w.currency && reading.currency && reading.currency !== w.currency) {
      return { watchId: w.id, at, ok: false, error: `幣別不符：頁面是 ${reading.currency}，監控設定是 ${w.currency}` };
    }
    return { watchId: w.id, at, ok: true, amount: reading.amount, currency: reading.currency ?? w.currency, via: reading.via };
  } catch (e) {
    return { watchId: w.id, at, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function newAlert(w: Watch, kind: AlertKind, at: string, message: string, extra: Partial<Alert> = {}): Alert {
  return { id: `${w.id}-${kind}-${at}`, watchId: w.id, at, kind, message, seen: false, ...extra };
}

/** Alerts a fresh reading deserves, given the earlier readings and the alerts already raised. */
export function judge(w: Watch, sample: Sample, samples: Sample[], alerts: Alert[]): Alert[] {
  const out: Alert[] = [];
  const at = sample.at;
  if (!sample.ok) {
    const failures = trailingFailures([...samples, sample], w.id);
    const open = alerts.some((a) => a.watchId === w.id && a.kind === 'unreadable' && !a.seen);
    if (failures >= UNREADABLE_AFTER && !open) {
      out.push(newAlert(w, 'unreadable', at, `「${w.title}」連續 ${failures} 次讀不到：${sample.error ?? '未知原因'}。請改用人工查價，或調整監控設定。`));
    }
    return out;
  }
  if (w.kind === 'availability') {
    const before = lastGood(samples, w.id, (s) => s.available !== undefined);
    if (sample.available === true && before?.available !== true) {
      out.push(newAlert(w, 'available', at, `「${w.title}」現在可以購買了：${w.url}`));
    }
    return out;
  }
  const amount = sample.amount!;
  const prev = lastGood(samples, w.id, (s) => s.amount !== undefined);
  const price = fmt(amount, sample.currency);
  if (w.targetPrice !== undefined && amount <= w.targetPrice) {
    const already = alerts.some((a) => a.watchId === w.id && a.kind === 'target' && a.amount === amount);
    if (!already) out.push(newAlert(w, 'target', at, `「${w.title}」降到 ${price}，達到你的目標價 ${fmt(w.targetPrice, sample.currency)}。`, { amount, currency: sample.currency }));
  }
  if (w.dropPercent !== undefined && prev?.amount !== undefined && amount <= prev.amount * (1 - w.dropPercent / 100)) {
    const pct = Math.round((1 - amount / prev.amount) * 100);
    out.push(newAlert(w, 'drop', at, `「${w.title}」從 ${fmt(prev.amount, sample.currency)} 降到 ${price}（−${pct}%）。`, { amount, currency: sample.currency }));
  }
  return out;
}

/** Sale-date reminders: they need no page, only the clock. */
export function saleDateAlerts(w: Watch, now: Date, alerts: Alert[]): Alert[] {
  if (!w.active || !w.opensAt) return [];
  const opens = Date.parse(w.opensAt);
  if (Number.isNaN(opens)) return [];
  const at = now.toISOString();
  const has = (kind: AlertKind) => alerts.some((a) => a.watchId === w.id && a.kind === kind);
  const out: Alert[] = [];
  if (now.getTime() >= opens) {
    if (!has('opens')) out.push(newAlert(w, 'opens', at, `「${w.title}」開賣了（${w.opensAt}）：${w.url}`));
  } else if (opens - now.getTime() <= 24 * 3_600_000 && !has('opens-soon')) {
    out.push(newAlert(w, 'opens-soon', at, `「${w.title}」24 小時內開賣（${w.opensAt}）。`));
  }
  return out;
}

/** Looks at every due watch of one trip, stores the readings and returns the new alerts. */
export async function scanTrip(dir: string, deps: ScanDeps, opts: { force?: boolean } = {}): Promise<{ results: ScanResult[]; alerts: Alert[] }> {
  const [watches, samples, alerts] = await Promise.all([loadWatches(dir), loadSamples(dir), loadAlerts(dir)]);
  const now = deps.now();
  const results: ScanResult[] = [];
  const fresh: Alert[] = [];

  for (const w of watches) {
    fresh.push(...saleDateAlerts(w, now, [...alerts, ...fresh]));
    if (!isDue(w, lastSample(samples, w.id)?.at, now, opts.force)) continue;
    const sample = await look(w, deps);
    fresh.push(...judge(w, sample, samples, [...alerts, ...fresh]));
    samples.push(sample);
    results.push({ watchId: w.id, sample });
  }

  if (results.length > 0) await saveSamples(dir, samples);
  if (fresh.length > 0) await saveAlerts(dir, [...alerts, ...fresh]);
  return { results, alerts: fresh };
}
