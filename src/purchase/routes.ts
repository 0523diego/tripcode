// Dev-server routes behind the 採購辦公室 page, mounted at /__buy (see vite-plugin-tripcode.ts).
//   GET  /state?trip=<id>   one read-only snapshot (see office.ts)
//   POST /scan              { tripId, force? }   look at the due watches now
//   POST /ack               { tripId }           mark alerts as seen
// Watches and alerts only. Nothing here pays or touches a card (TripCode has no payment layer). Only this machine may call it.
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { ackAlerts, readOffice, scanWithActivity } from './office.ts';
import { PurchaseError } from './types.ts';
import os from 'node:os';
import path from 'node:path';

export interface GuardResult {
  status: number;
  error: string;
}
export type RequestGuard = (headers: IncomingHttpHeaders, opts: { requireJson: boolean }) => GuardResult | null;

const BODY_LIMIT = 8 * 1024;

function send(res: ServerResponse, status: number, json: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(json));
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        reject(new PurchaseError('請求內容過大'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
      } catch {
        reject(new PurchaseError('無效的 JSON'));
      }
    });
    req.on('error', reject);
  });
}

const text = (b: Record<string, unknown>, k: string) => (typeof b[k] === 'string' ? (b[k] as string) : '');

export interface BuyRoutes {
  handle(req: IncomingMessage, res: ServerResponse, next: () => void): void;
}

export function createBuyRoutes(o: { root: string; guard: RequestGuard; home?: string; fetch?: typeof fetch; now?: () => Date; env?: Record<string, string | undefined> }): BuyRoutes {
  const home = o.home ?? o.env?.TRIPCODE_HOME?.trim() ?? path.join(os.homedir(), '.tripcode');
  const now = o.now ?? (() => new Date());
  const doFetch = o.fetch ?? fetch;

  async function route(req: IncomingMessage, res: ServerResponse, next: () => void): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = url.pathname.replace(/\/+$/, '') || '/';
    const get = req.method === 'GET';
    if (get && p === '/state') {
      const trip = url.searchParams.get('trip') ?? undefined;
      return send(res, 200, await readOffice({ root: o.root, home, now: now(), tripId: trip && /^[a-z0-9-]+$/.test(trip) ? trip : undefined, env: o.env }));
    }
    if (req.method !== 'POST') return next();
    const body = await readBody(req);
    switch (p) {
      case '/scan': {
        const r = await scanWithActivity({ root: o.root, home, tripId: text(body, 'tripId'), fetch: doFetch, now, force: body.force === true, env: o.env });
        return send(res, 200, { ok: true, looked: r.results.length, alerts: r.alerts.length });
      }
      case '/ack':
        return send(res, 200, { ok: true, acked: await ackAlerts(o.root, text(body, 'tripId')) });
      default:
        return next();
    }
  }

  return {
    handle(req, res, next) {
      const denied = o.guard(req.headers, { requireJson: req.method === 'POST' });
      if (denied) return send(res, denied.status, { ok: false, error: denied.error });
      route(req, res, next).catch((e: unknown) => {
        const known = e instanceof PurchaseError || (e instanceof Error && e.name === 'PurchaseError');
        send(res, known ? 400 : 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
      });
    },
  };
}
