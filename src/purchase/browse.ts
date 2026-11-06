// A small remote control for TripCode's own Chrome, so an AI can walk a merchant site to the payment page
// (open, read, click, type) without ever touching the card: the card is filled later by `buy pay`, which
// runs non-LLM code. Everything goes through the same local debugging connection as checkout.ts.
import path from 'node:path';
import { connectBrowser } from './cdp.ts';
import type { BrowserHandle, CdpConnection } from './cdp.ts';
import { checkHttpsUrl } from './store.ts';
import { PurchaseError } from './types.ts';

export interface Tab {
  index: number;
  targetId: string;
  url: string;
  title: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function checkBrowseUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new PurchaseError(`網址格式不對：${raw}`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new PurchaseError('瀏覽器只開 http(s) 網址');
  return u.toString();
}

export async function listTabs(conn: CdpConnection): Promise<Tab[]> {
  const { targetInfos } = await conn.send<{ targetInfos: { targetId: string; type: string; url: string; title: string }[] }>('Target.getTargets');
  return targetInfos
    .filter((t) => t.type === 'page')
    .map((t, index) => ({ index, targetId: t.targetId, url: t.url, title: t.title }));
}

async function pickTab(conn: CdpConnection, index?: number): Promise<Tab> {
  const tabs = await listTabs(conn);
  const tab = index === undefined ? tabs.filter((t) => t.url !== 'about:blank').at(-1) ?? tabs.at(-1) : tabs[index];
  if (!tab) throw new PurchaseError(index === undefined ? '瀏覽器沒有開著的分頁。先執行：tripcode buy browser open <網址>' : `沒有第 ${index} 個分頁（用 buy browser tabs 看清單）`);
  return tab;
}

async function session(conn: CdpConnection, tab: Tab): Promise<string> {
  const r = await conn.send<{ sessionId: string }>('Target.attachToTarget', { targetId: tab.targetId, flatten: true });
  return r.sessionId;
}

async function evaluate<T>(conn: CdpConnection, sid: string, expression: string): Promise<T> {
  const r = await conn.send<{ result?: { value?: T }; exceptionDetails?: { text?: string } }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sid);
  if (r.exceptionDetails) throw new PurchaseError(`頁面腳本出錯：${r.exceptionDetails.text ?? ''}`);
  return r.result?.value as T;
}

async function withTab<T>(conn: CdpConnection, tabIndex: number | undefined, fn: (sid: string, tab: Tab) => Promise<T>): Promise<T> {
  const tab = await pickTab(conn, tabIndex);
  const sid = await session(conn, tab);
  try {
    return await fn(sid, tab);
  } finally {
    await conn.send('Target.detachFromTarget', { sessionId: sid }).catch(() => {});
  }
}

export async function openUrl(conn: CdpConnection, raw: string, reuse = true): Promise<Tab> {
  const url = checkBrowseUrl(raw);
  const tabs = await listTabs(conn);
  const blank = tabs.find((t) => t.url === 'about:blank');
  if (reuse && blank) {
    const sid = await session(conn, blank);
    await conn.send('Page.navigate', { url }, sid);
    await conn.send('Target.detachFromTarget', { sessionId: sid }).catch(() => {});
  } else {
    await conn.send('Target.createTarget', { url });
  }
  await sleep(1500);
  return await pickTab(conn);
}

export async function pageText(conn: CdpConnection, opts: { tab?: number; max?: number } = {}): Promise<{ url: string; title: string; text: string }> {
  return withTab(conn, opts.tab, async (sid, tab) => {
    const text = await evaluate<string>(conn, sid, 'document.body ? document.body.innerText : ""');
    return { url: tab.url, title: tab.title, text: text.replace(/\n{3,}/g, '\n\n').slice(0, opts.max ?? 8000) };
  });
}

/** Clickable things on the page, so the AI can say what to click instead of guessing. */
export async function pageLinks(conn: CdpConnection, opts: { tab?: number; max?: number } = {}): Promise<{ text: string; href?: string }[]> {
  return withTab(conn, opts.tab, async (sid) => {
    const json = await evaluate<string>(
      conn,
      sid,
      `(() => {
        const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
        const out = [];
        for (const el of document.querySelectorAll('a[href], button, [role=button], input[type=submit]')) {
          if (!visible(el)) continue;
          const text = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
          if (!text) continue;
          out.push({ text, href: el.href || undefined });
          if (out.length >= ${opts.max ?? 80}) break;
        }
        return JSON.stringify(out);
      })()`,
    );
    return JSON.parse(json) as { text: string; href?: string }[];
  });
}

async function mouseClick(conn: CdpConnection, sid: string, x: number, y: number): Promise<void> {
  await conn.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sid);
  await conn.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sid);
  await conn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sid);
}

/** Clicks the first visible link or button whose text matches (exact match wins over contains). */
export async function clickText(conn: CdpConnection, text: string, opts: { tab?: number } = {}): Promise<{ clicked: string }> {
  return withTab(conn, opts.tab, async (sid) => {
    const json = await evaluate<string | null>(
      conn,
      sid,
      `(() => {
        const want = ${JSON.stringify(text.trim().toLowerCase())};
        const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
        const label = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').toLowerCase();
        const all = [...document.querySelectorAll('a[href], button, [role=button], [role=tab], [role=option], label, input[type=submit], input[type=checkbox], input[type=radio]')].filter((el) => visible(el) && !el.disabled);
        const el = all.find((e) => label(e) === want) || all.find((e) => label(e).includes(want));
        if (!el) return null;
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2, label: label(el).slice(0, 60) });
      })()`,
    );
    if (!json) throw new PurchaseError(`頁面上找不到「${text}」。用 buy browser links 看看有哪些可以點`);
    const { x, y, label } = JSON.parse(json) as { x: number; y: number; label: string };
    await mouseClick(conn, sid, x, y);
    await sleep(1200);
    return { clicked: label };
  });
}

/** Types into the input whose label, placeholder, name or id contains `into` (or the focused one when omitted). */
export async function typeInto(conn: CdpConnection, text: string, opts: { into?: string; tab?: number } = {}): Promise<{ typed: number }> {
  return withTab(conn, opts.tab, async (sid) => {
    if (opts.into) {
      const ok = await evaluate<boolean>(
        conn,
        sid,
        `(() => {
          const want = ${JSON.stringify(opts.into.trim().toLowerCase())};
          const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
          const hay = (el) => [el.placeholder, el.getAttribute('aria-label'), el.name, el.id, el.labels && el.labels[0] ? el.labels[0].innerText : ''].join(' ').toLowerCase();
          const el = [...document.querySelectorAll('input, textarea, select')].find((e) => visible(e) && !/^(hidden|checkbox|radio|submit|button)$/i.test(e.type || '') && hay(e).includes(want));
          if (!el) return false;
          el.scrollIntoView({ block: 'center' });
          el.focus();
          if (el.select) el.select();
          return true;
        })()`,
      );
      if (!ok) throw new PurchaseError(`頁面上找不到欄位「${opts.into}」`);
    }
    await conn.send('Input.insertText', { text }, sid);
    return { typed: text.length };
  });
}

const KEYS: Record<string, { key: string; code: string; vk: number }> = {
  enter: { key: 'Enter', code: 'Enter', vk: 13 },
  tab: { key: 'Tab', code: 'Tab', vk: 9 },
  escape: { key: 'Escape', code: 'Escape', vk: 27 },
  down: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  up: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
};

export async function pressKey(conn: CdpConnection, name: string, opts: { tab?: number } = {}): Promise<void> {
  const k = KEYS[name.toLowerCase()];
  if (!k) throw new PurchaseError(`不支援的按鍵：${name}（可用：${Object.keys(KEYS).join('、')}）`);
  await withTab(conn, opts.tab, async (sid) => {
    const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk };
    await conn.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base, ...(k.key === 'Enter' ? { text: '\r' } : {}) }, sid);
    await conn.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, sid);
  });
  await sleep(800);
}

export async function screenshot(conn: CdpConnection, opts: { tab?: number } = {}): Promise<Buffer> {
  return withTab(conn, opts.tab, async (sid) => {
    const r = await conn.send<{ data: string }>('Page.captureScreenshot', { format: 'png' }, sid);
    return Buffer.from(r.data, 'base64');
  });
}

// ---------- reading a page the way a browser does (for watches with `render`) ----------

/**
 * Opens the page in a background tab of TripCode's own Chrome, waits until it stops changing, and returns the HTML
 * after JavaScript ran plus the visible text (so a `--regex` can match what a person sees). The tab is closed again.
 * Same limits as a plain scan: https only, no private addresses (checked again after redirects), no logins,
 * no captcha tricks. A consent wall is left for the user to click once: Chrome remembers it in this profile.
 */
export async function renderPage(conn: CdpConnection, rawUrl: string, opts: { allowLocal?: boolean; timeoutMs?: number } = {}): Promise<string> {
  const url = checkHttpsUrl(rawUrl, { allowLocal: opts.allowLocal }).toString();
  const deadline = Date.now() + (opts.timeoutMs ?? 25_000);
  const { targetId } = await conn.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank', background: true });
  try {
    const { sessionId } = await conn.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    await conn.send('Page.navigate', { url }, sessionId);
    let last = -1;
    let stable = 0;
    let html = '';
    let text = '';
    while (Date.now() < deadline) {
      await sleep(1000);
      const state = await evaluate<string>(conn, sessionId, 'JSON.stringify({ ready: document.readyState, href: location.href, len: document.documentElement ? document.documentElement.outerHTML.length : 0 })');
      const s = JSON.parse(state) as { ready: string; href: string; len: number };
      if (s.href === 'about:blank' || s.ready !== 'complete') continue;
      stable = s.len === last ? stable + 1 : 0;
      last = s.len;
      if (stable >= 2) {
        checkHttpsUrl(s.href, { allowLocal: opts.allowLocal });
        html = await evaluate<string>(conn, sessionId, 'document.documentElement.outerHTML');
        text = await evaluate<string>(conn, sessionId, 'document.body ? document.body.innerText : ""');
        return `${html}\n<!-- visible text -->\n${text}`;
      }
    }
    throw new PurchaseError('頁面太久沒有載入完成');
  } finally {
    await conn.send('Target.closeTarget', { targetId }).catch(() => {});
  }
}

export interface Renderer {
  render: (url: string) => Promise<string>;
  close: () => Promise<void>;
}

/** Connects to Chrome on first use (headless if it has to start one) and leaves nothing running afterwards. */
export function lazyRenderer(o: { profileDir?: string; home?: string; connect?: () => Promise<BrowserHandle>; allowLocal?: boolean; env?: Record<string, string | undefined> }): Renderer {
  let handle: BrowserHandle | undefined;
  const profileDir = o.profileDir ?? path.join(o.home ?? '', 'chrome-profile');
  return {
    async render(url) {
      handle ??= await (o.connect ?? (() => connectBrowser({ profileDir, headless: true, env: o.env })))();
      return renderPage(handle.conn, url, { allowLocal: o.allowLocal });
    },
    async close() {
      if (!handle) return;
      // Only close a Chrome we started ourselves: a window the user has open is theirs.
      if (handle.launched) await handle.conn.send('Browser.close').catch(() => {});
      handle.conn.close();
      handle = undefined;
    },
  };
}
