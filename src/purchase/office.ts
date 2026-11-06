// What the office page shows about watches: the watched pages with their price history, the alerts they raised, and a
// short log of what was just read. Read-only snapshot plus two buttons (look now, mark alerts seen). TripCode does not
// pay for anything; this is only about noticing a price or a sale date.
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { logActivity, readActivity } from './activity.ts';
import type { Activity } from './activity.ts';
import { lazyRenderer } from './browse.ts';
import { findChrome } from './cdp.ts';
import { scanTrip } from './scan.ts';
import type { FetchLike } from './scan.ts';
import { checkId, loadAlerts, loadSamples, loadWatches, purchaseDir, saveAlerts } from './store.ts';
import type { Alert, Sample, Watch } from './types.ts';

export interface WatchView extends Watch {
  /** The latest look, ok or not. */
  last?: Sample;
  /** Amounts of the last readings that worked, oldest first (a sparkline). */
  history: number[];
  lowest?: number;
}

export interface OfficeTrip {
  id: string;
  watches: WatchView[];
  /** Newest first. */
  alerts: Alert[];
}

export interface OfficeState {
  now: string;
  setup: { chrome: boolean };
  trips: OfficeTrip[];
  activity: Activity[];
}

async function tripIds(root: string): Promise<string[]> {
  try {
    return (await readdir(path.join(root, 'trips'), { withFileTypes: true })).filter((e) => e.isDirectory() && /^[a-z0-9-]+$/.test(e.name)).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

async function readTrip(root: string, id: string): Promise<OfficeTrip> {
  const dir = purchaseDir(root, id);
  const [watches, samples, alerts] = await Promise.all([loadWatches(dir), loadSamples(dir), loadAlerts(dir)]);
  return {
    id,
    watches: watches.map((w) => {
      const mine = samples.filter((s) => s.watchId === w.id);
      const amounts = mine.filter((s) => s.ok && typeof s.amount === 'number').map((s) => s.amount as number);
      return { ...w, last: mine.at(-1), history: amounts.slice(-14), lowest: amounts.length ? Math.min(...amounts) : undefined };
    }),
    alerts: [...alerts].reverse().slice(0, 30),
  };
}

export async function readOffice(o: { root: string; home: string; now: Date; tripId?: string; env?: Record<string, string | undefined> }): Promise<OfficeState> {
  const [chrome, activity] = await Promise.all([findChrome(o.env), readActivity(o.home, 60)]);
  const trips: OfficeTrip[] = [];
  for (const id of await tripIds(o.root)) {
    const t = await readTrip(o.root, id);
    if (t.watches.length > 0 || t.alerts.length > 0 || id === o.tripId) trips.push(t);
  }
  return { now: o.now.toISOString(), setup: { chrome: !!chrome }, trips, activity };
}

/** Looks at the due watches of one trip and tells the activity log what was read. */
export async function scanWithActivity(o: { root: string; home: string; tripId: string; fetch: FetchLike; now: () => Date; force?: boolean; render?: (url: string) => Promise<string>; env?: Record<string, string | undefined> }) {
  const dir = purchaseDir(o.root, checkId(o.tripId, 'tripId'));
  const watches = await loadWatches(dir);
  const titles = new Map(watches.map((w) => [w.id, w.title]));
  const log = (text: string, level: 'info' | 'ok' | 'warn' | 'err' = 'info') => logActivity(o.home, { at: o.now().toISOString(), actor: 'scout', tripId: o.tripId, text, level });
  const needsChrome = !o.render && watches.some((w) => w.active && w.render);
  const chrome = needsChrome ? lazyRenderer({ home: o.home, env: o.env }) : undefined;
  let r: Awaited<ReturnType<typeof scanTrip>>;
  try {
    r = await scanTrip(dir, { fetch: o.fetch, now: o.now, render: o.render ?? chrome?.render }, { force: o.force });
  } finally {
    await chrome?.close();
  }
  if (r.results.length > 0) await log(`看了 ${r.results.length} 個商品`);
  for (const { watchId, sample } of r.results) {
    const name = titles.get(watchId) ?? watchId;
    if (!sample.ok) await log(`${name}：讀不到（${sample.error ?? '未知原因'}）`, 'warn');
    else if (typeof sample.amount === 'number') await log(`${name}：${sample.currency ?? ''} ${sample.amount}`.replace('  ', ' '), 'ok');
    else if (sample.available !== undefined) await log(`${name}：${sample.available ? '可以買了' : '還不能買'}`, sample.available ? 'ok' : 'info');
  }
  for (const a of r.alerts) await log(a.message, 'ok');
  return r;
}

export async function ackAlerts(root: string, tripId: string): Promise<number> {
  const dir = purchaseDir(root, checkId(tripId, 'tripId'));
  const alerts = await loadAlerts(dir);
  await saveAlerts(dir, alerts.map((a) => ({ ...a, seen: true })));
  return alerts.filter((a) => !a.seen).length;
}
