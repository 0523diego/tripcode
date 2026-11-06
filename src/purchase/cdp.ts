// A minimal Chrome DevTools Protocol client (no dependency: Node's built-in WebSocket) and the code that
// finds, launches or reuses a Chrome with remote debugging. TripCode drives its own Chrome profile
// (~/.tripcode/chrome-profile), never the user's everyday one, and the debugging port is localhost only.
import { spawn } from 'node:child_process';
import { access, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { PurchaseError } from './types.ts';

type Json = Record<string, any>;
export interface CdpEvent {
  method: string;
  params: Json;
  sessionId?: string;
}

export class CdpConnection {
  #ws: WebSocket;
  #id = 0;
  #pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  #listeners = new Set<(e: CdpEvent) => void>();

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.addEventListener('message', (ev) => {
      let msg: Json;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (typeof msg.id === 'number') {
        const p = this.#pending.get(msg.id);
        if (!p) return;
        this.#pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${msg.error.message ?? 'CDP error'}`));
        else p.resolve(msg.result ?? {});
      } else if (typeof msg.method === 'string') {
        for (const l of this.#listeners) l({ method: msg.method, params: msg.params ?? {}, sessionId: msg.sessionId });
      }
    });
    ws.addEventListener('close', () => {
      for (const p of this.#pending.values()) p.reject(new Error('瀏覽器連線中斷'));
      this.#pending.clear();
    });
  }

  static connect(url: string, timeoutMs = 5000): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('連不上瀏覽器的除錯連線'));
      }, timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(new CdpConnection(ws));
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('連不上瀏覽器的除錯連線'));
      });
    });
  }

  send<T = Json>(method: string, params: Json = {}, sessionId?: string): Promise<T> {
    const id = ++this.#id;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }

  onEvent(cb: (e: CdpEvent) => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  close(): void {
    this.#ws.close();
  }
}

// ---------- finding and starting Chrome ----------

export function chromeCandidates(platform: NodeJS.Platform, env: Record<string, string | undefined>): string[] {
  if (env.TRIPCODE_CHROME) return [env.TRIPCODE_CHROME];
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ];
  }
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter((r): r is string => !!r);
    return roots.flatMap((r) => [path.join(r, 'Google/Chrome/Application/chrome.exe'), path.join(r, 'Microsoft/Edge/Application/msedge.exe')]);
  }
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];
}

export async function findChrome(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  for (const p of chromeCandidates(platform, env)) {
    try {
      await access(p);
      return p;
    } catch {
      // try the next one
    }
  }
  return undefined;
}

async function activePort(profileDir: string): Promise<string | undefined> {
  try {
    const [port, wsPath] = (await readFile(path.join(profileDir, 'DevToolsActivePort'), 'utf8')).split('\n');
    return port && wsPath ? `ws://127.0.0.1:${port.trim()}${wsPath.trim()}` : undefined;
  } catch {
    return undefined;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface BrowserHandle {
  conn: CdpConnection;
  launched: boolean;
}

/** Reuses TripCode's own Chrome if it is already running with debugging on; otherwise starts it (visible). */
export async function connectBrowser(opts: { profileDir: string; chromePath?: string; headless?: boolean; env?: Record<string, string | undefined> }): Promise<BrowserHandle> {
  const existing = await activePort(opts.profileDir);
  if (existing) {
    try {
      return { conn: await CdpConnection.connect(existing, 2000), launched: false };
    } catch {
      await rm(path.join(opts.profileDir, 'DevToolsActivePort'), { force: true });
    }
  }
  const chrome = opts.chromePath ?? (await findChrome(opts.env));
  if (!chrome) throw new PurchaseError('找不到 Chrome。請安裝 Google Chrome，或用環境變數 TRIPCODE_CHROME 指定瀏覽器執行檔');
  const args = ['--remote-debugging-port=0', `--user-data-dir=${opts.profileDir}`, '--no-first-run', '--no-default-browser-check', 'about:blank'];
  if (opts.headless) args.unshift('--headless=new');
  spawn(chrome, args, { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    const url = await activePort(opts.profileDir);
    if (!url) continue;
    try {
      return { conn: await CdpConnection.connect(url, 2000), launched: true };
    } catch {
      // Chrome is still starting
    }
  }
  throw new PurchaseError('Chrome 沒有在 15 秒內準備好');
}
