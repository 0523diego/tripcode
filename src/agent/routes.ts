// Dev-server routes behind the viewer's agent panel, mounted at /__agent (see vite-plugin-tripcode.ts).
//   GET  /status                       is the SDK installed, is `claude` on PATH, which models
//   GET  /events                       server-sent events: every store change, as AgentStreamEvent
//   POST /install                      installs the Claude Agent SDK (exact, ≥7-day-old version)
//   GET|POST /sessions                 list / create
//   GET|DELETE /sessions/:id           read / remove
//   POST /sessions/:id/messages|stop|respond
// Only this machine may use it: the agent can edit files and run commands as the user.
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { isUploadRef, MAX_IMAGE_BYTES, MAX_IMAGES_PER_MESSAGE, saveUpload, servedImage } from './attachments.ts';
import { createClaudeProvider } from './claude.ts';
import { commandVersion, findOnPath, resolveWorkspacePackage } from './detect.ts';
import { installSdk } from './install.ts';
import type { AgentProvider } from './provider.ts';
import { createAgentRunner } from './runner.ts';
import { createSessionStore } from './store.ts';
import type { SessionStore } from './store.ts';
import { isAgentEffort } from './types.ts';
import type { AgentStatus, AgentStreamEvent, AgentTurnContext, RespondPayload } from './types.ts';

const BODY_LIMIT = 1024 * 1024;
// A base64 image inside JSON is a third bigger than the file.
const UPLOAD_BODY_LIMIT = Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4096;
const TRIP_ID_RE = /^[a-z0-9-]+$/;
const FILE_RE = /^[a-z0-9-]+\.ts$/;
const MODEL_RE = /^[\w.:[\]-]{1,80}$/;

export interface GuardResult {
  status: number;
  error: string;
}

/** Same checks as the write API's guardRequest; the plugin injects it so this module stays free of Vite. */
export type RequestGuard = (headers: IncomingHttpHeaders, opts: { requireJson: boolean }) => GuardResult | null;

export function isLoopbackRequest(req: Pick<IncomingMessage, 'socket'>): boolean {
  const addr = req.socket.remoteAddress ?? '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

export function parseContext(raw: unknown): AgentTurnContext | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const ctx: AgentTurnContext = {};
  if (typeof r.tripId === 'string' && TRIP_ID_RE.test(r.tripId)) ctx.tripId = r.tripId;
  if (typeof r.file === 'string' && FILE_RE.test(r.file)) ctx.file = r.file;
  if (typeof r.tripTitle === 'string') ctx.tripTitle = r.tripTitle.slice(0, 120);
  if (r.idea === true) ctx.idea = true;
  if (typeof r.day === 'number' && Number.isFinite(r.day)) ctx.day = Math.max(1, Math.floor(r.day));
  if (typeof r.itemId === 'string' && /^[\w-]{1,80}$/.test(r.itemId)) ctx.itemId = r.itemId;
  return ctx;
}

export function parseModel(raw: unknown): string | null {
  return typeof raw === 'string' && MODEL_RE.test(raw) ? raw : null;
}

export function parseRespond(raw: unknown): RespondPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.cancel === true) return { cancel: true };
  if (typeof r.allow === 'boolean') return { allow: r.allow };
  if (r.answers && typeof r.answers === 'object') {
    const answers: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.answers as Record<string, unknown>)) {
      if (typeof v === 'string') answers[k] = v;
    }
    return { answers };
  }
  return null;
}

class BodyTooLarge extends Error {}

function readJson(req: IncomingMessage, limit = BODY_LIMIT): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooBig = false;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      if (tooBig) return;
      size += c.length;
      if (size > limit) {
        tooBig = true;
        chunks.length = 0;
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) return reject(new BodyTooLarge('請求內容過大'));
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        resolve(parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

export interface AgentRoutes {
  handle(req: IncomingMessage, res: ServerResponse, next: () => void): Promise<void>;
  close(): void;
}

export function createAgentRoutes(opts: {
  root: string;
  guard: RequestGuard;
  enabled?: boolean;
  provider?: AgentProvider;
  store?: SessionStore;
}): AgentRoutes {
  const { root, guard } = opts;
  const enabledByConfig = opts.enabled ?? process.env.TRIPCODE_AGENT !== '0';
  const provider = opts.provider ?? createClaudeProvider();
  const store = opts.store ?? createSessionStore({ file: path.join(root, 'node_modules', '.tripcode', 'agent-sessions.json') });
  const streams = new Set<ServerResponse>();
  const broadcast = (event: AgentStreamEvent) => {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const stream of streams) stream.write(frame);
  };
  store.subscribe(broadcast);
  // Proxies and browsers drop idle event streams; a comment line every 25 s keeps it open.
  const heartbeat = setInterval(() => {
    for (const stream of streams) stream.write(': ping\n\n');
  }, 25_000);
  heartbeat.unref();

  const runner = createAgentRunner({
    userCwd: root,
    writableRoots: [path.join(root, 'trips'), path.join(root, 'destinations')],
    store,
    provider,
  });
  let install: Promise<string> | null = null;

  async function status(): Promise<AgentStatus> {
    const sdk = resolveWorkspacePackage(root, provider.sdkPackage);
    const cliPath = findOnPath(provider.cliCommand);
    return {
      enabled: true,
      sdkInstalled: sdk !== null,
      sdkVersion: sdk?.version ?? null,
      sdkPackage: provider.sdkPackage,
      cliFound: cliPath !== null,
      cliVersion: cliPath ? await commandVersion(cliPath) : null,
      models: provider.models(),
    };
  }

  async function handle(req: IncomingMessage, res: ServerResponse, next: () => void): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://local');
    const method = req.method ?? 'GET';
    const segments = url.pathname.split('/').filter(Boolean);
    const enabled = enabledByConfig && isLoopbackRequest(req);
    try {
      if (method === 'GET' && url.pathname === '/status') {
        res.setHeader('cache-control', 'no-store');
        if (!enabled) {
          return json(res, 200, { enabled: false, sdkInstalled: false, sdkVersion: null, sdkPackage: provider.sdkPackage, cliFound: false, cliVersion: null, models: [] } satisfies AgentStatus);
        }
        return json(res, 200, await status());
      }
      if (!enabled) return json(res, 404, { error: 'agent 面板已停用' });

      // Every other route is also subject to the browser-origin checks. Every POST must be JSON
      // (that is what forces the CORS preflight a hostile page cannot pass), so the client sends `{}`
      // even for stop; GET and DELETE carry no body.
      const denied = guard(req.headers, { requireJson: method === 'POST' });
      if (denied) return json(res, denied.status, { error: denied.error });

      if (method === 'GET' && url.pathname === '/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(': connected\n\n');
        streams.add(res);
        const drop = () => streams.delete(res);
        res.on('close', drop);
        res.on('error', drop);
        return;
      }
      if (method === 'POST' && url.pathname === '/install') {
        install ??= installSdk(provider.sdkPackage, root).finally(() => {
          install = null;
        });
        const version = await install;
        return json(res, 200, { ok: true, version });
      }
      if (method === 'POST' && url.pathname === '/uploads') {
        const body = await readJson(req, UPLOAD_BODY_LIMIT);
        const tripId = typeof body.tripId === 'string' && TRIP_ID_RE.test(body.tripId) ? body.tripId : null;
        if (typeof body.data !== 'string' || !body.data) return json(res, 400, { error: '缺少圖片內容' });
        try {
          return json(res, 200, { ref: saveUpload(root, tripId, Buffer.from(body.data, 'base64')) });
        } catch (err) {
          return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
      }
      if (method === 'GET' && url.pathname === '/files') {
        const image = servedImage(root, url.searchParams.get('path'));
        if (!image) return json(res, 404, { error: '找不到圖片' });
        // An SVG the agent drew can carry script: it is only ever shown through <img>, and opened on its own it is sandboxed.
        res.writeHead(200, {
          'content-type': image.mime,
          'cache-control': 'private, max-age=60',
          'x-content-type-options': 'nosniff',
          'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
        });
        res.end(fs.readFileSync(image.file));
        return;
      }
      if (method === 'GET' && url.pathname === '/sessions') {
        res.setHeader('cache-control', 'no-store');
        return json(res, 200, { sessions: store.list() });
      }
      if (method === 'POST' && url.pathname === '/sessions') {
        const body = await readJson(req);
        const tripId = typeof body.tripId === 'string' && TRIP_ID_RE.test(body.tripId) ? body.tripId : null;
        return json(res, 200, store.create(tripId));
      }
      if (segments[0] === 'sessions' && segments[1]) {
        const id = segments[1];
        const action = segments[2];
        const session = store.get(id);
        if (!session) return json(res, 404, { error: '找不到對話' });
        if (method === 'GET' && !action) {
          res.setHeader('cache-control', 'no-store');
          return json(res, 200, session);
        }
        if (method === 'DELETE' && !action) {
          runner.stop(id);
          store.remove(id);
          return json(res, 200, { ok: true });
        }
        if (method === 'POST' && action === 'messages') {
          const body = await readJson(req);
          let images: string[] | undefined;
          if (body.images !== undefined) {
            if (!Array.isArray(body.images) || body.images.length > MAX_IMAGES_PER_MESSAGE || !body.images.every((p) => isUploadRef(root, p))) {
              return json(res, 400, { error: '附加的圖片無效或已不存在' });
            }
            images = body.images as string[];
          }
          if (typeof body.text !== 'string' || (!body.text.trim() && !(images && images.length > 0))) return json(res, 400, { error: '缺少訊息內容' });
          if (runner.isRunning(id)) return json(res, 409, { error: '這個對話正在執行' });
          if (body.edit !== undefined && !session.items.some((i) => i.id === body.edit && i.kind === 'user')) {
            return json(res, 400, { error: '找不到那則訊息' });
          }
          await runner.send(id, {
            text: body.text,
            context: parseContext(body.context),
            autoApprove: body.autoApprove === true,
            model: parseModel(body.model),
            effort: isAgentEffort(body.effort) ? body.effort : null,
            edit: typeof body.edit === 'string' ? body.edit : undefined,
            images,
          });
          return json(res, 202, { ok: true });
        }
        if (method === 'POST' && action === 'stop') return json(res, 200, { ok: runner.stop(id) });
        if (method === 'POST' && action === 'respond') {
          const body = await readJson(req);
          const payload = parseRespond(body);
          if (typeof body.itemId !== 'string' || !payload) return json(res, 400, { error: '無效的回應' });
          const ok = runner.respond(id, body.itemId, payload);
          return json(res, ok ? 200 : 409, ok ? { ok } : { error: '沒有待回應的項目' });
        }
      }
      next();
    } catch (err) {
      if (err instanceof BodyTooLarge) return json(res, 413, { error: err.message });
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  return {
    handle,
    close() {
      clearInterval(heartbeat);
      for (const stream of streams) stream.end();
      runner.stopAll();
      void store.flush();
    },
  };
}
