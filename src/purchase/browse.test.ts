// Real (headless) Chrome against a fake two-step merchant: product page → "Book now" → checkout. The AI-style
// commands (open, text, links, click, type) read and walk a site; renderPage reads what JavaScript produced.
// Skipped when there is no Chrome.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { checkBrowseUrl, clickText, lazyRenderer, listTabs, openUrl, pageLinks, pageText, pressKey, renderPage, screenshot, typeInto } from './browse.ts';
import { extractPrice } from './price.ts';
import { connectBrowser, findChrome } from './cdp.ts';
import type { BrowserHandle } from './cdp.ts';

const chrome = await findChrome();

let server: http.Server;
let base = '';
let browser: BrowserHandle;
let profile: string;

describe('buy browser against a fake merchant', { skip: chrome ? false : '沒有安裝 Chrome' }, () => {
  before(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      res.setHeader('content-type', 'text/html');
      if (url.pathname === '/js-price') {
        // The price does not exist in the HTML that is downloaded: a script writes it a moment later.
        res.end(`<!doctype html><meta charset="utf-8"><title>JS tour</title><body><div id="p">loading</div>
          <script>setTimeout(() => {
            const s = document.createElement('script'); s.type = 'application/ld+json';
            s.textContent = JSON.stringify({ '@type': 'Offer', price: 42.5, priceCurrency: 'EUR' });
            document.head.appendChild(s);
            document.getElementById('p').textContent = 'Today only: EUR 42.50';
          }, 700);</script></body>`);
        return;
      }
      if (url.pathname === '/tickets') {
        res.end(`<!doctype html><meta charset="utf-8"><body><h1>Tickets</h1><p>Timed entry. Free cancellation until 48 hours before.</p></body>`);
        return;
      }
      res.end(`<!doctype html><meta charset="utf-8"><title>Stonehenge tour</title><body><h1>Stonehenge day tour</h1><p>From €95.00</p>
        <label>Guests <input name="guests" placeholder="Number of guests" oninput="window.g=this.value"></label>
        <a href="/other">Other tours</a>
        <button onclick="location.href='/tickets'">Book now</button></body>`);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://merchant.localhost:${(server.address() as AddressInfo).port}`;
    profile = await mkdtemp(path.join(tmpdir(), 'tc-browse-'));
    browser = await connectBrowser({ profileDir: profile, headless: true });
  });

  after(async () => {
    try {
      await browser?.conn.send('Browser.close');
    } catch {
      // already gone
    }
    browser?.conn.close();
    server?.closeAllConnections();
    server?.close();
    if (profile) await new Promise((r) => setTimeout(r, 500)).then(() => rm(profile, { recursive: true, force: true }));
  });

  test('only http(s) pages can be opened', () => {
    assert.throws(() => checkBrowseUrl('file:///etc/passwd'), /http/);
    assert.throws(() => checkBrowseUrl('javascript:alert(1)'), /http/);
    assert.throws(() => checkBrowseUrl('nope'), /網址/);
  });

  test('open, read, find links, type into a field, click through to checkout', async () => {
    const tab = await openUrl(browser.conn, `${base}/`);
    assert.match(tab.url, /merchant\.localhost/);
    const page = await pageText(browser.conn);
    assert.match(page.text, /Stonehenge day tour/);
    assert.match(page.text, /€95\.00/);
    const links = await pageLinks(browser.conn);
    assert.ok(links.some((l) => l.text === 'Book now'));
    assert.ok(links.some((l) => l.text === 'Other tours' && l.href?.endsWith('/other')));
    assert.deepEqual(await typeInto(browser.conn, '2', { into: 'guests' }), { typed: 1 });
    await assert.rejects(typeInto(browser.conn, 'x', { into: 'nonexistent field' }), /找不到欄位/);
    await assert.rejects(clickText(browser.conn, 'No such button'), /找不到/);
    const clicked = await clickText(browser.conn, 'book now');
    assert.equal(clicked.clicked, 'book now');
    const after = await pageText(browser.conn);
    assert.match(after.text, /Timed entry/);
    assert.ok((await listTabs(browser.conn)).length >= 1);
    assert.ok((await screenshot(browser.conn)).length > 500);
    await pressKey(browser.conn, 'Tab');
    await assert.rejects(pressKey(browser.conn, 'F13'), /不支援/);
  });

  test('renderPage reads what JavaScript produced, closes its tab, and keeps the https / private-address rules', async () => {
    const before = (await listTabs(browser.conn)).length;
    const html = await renderPage(browser.conn, `${base}/js-price`, { allowLocal: true });
    assert.equal(extractPrice(await (await fetch(`${base}/js-price`)).text(), {}), undefined, 'a plain download has no price');
    assert.equal(extractPrice(html, {})?.amount, 42.5);
    assert.match(html, /Today only: EUR 42\.50/, 'the visible text is included for --regex');
    assert.equal((await listTabs(browser.conn)).length, before, 'the background tab is closed again');
    await assert.rejects(renderPage(browser.conn, `${base}/js-price`), /只接受 https|本機或內網/);
    await assert.rejects(renderPage(browser.conn, 'file:///etc/passwd', { allowLocal: true }), /https/);
  });

  test('lazyRenderer connects only when asked and closes only a Chrome it started', async () => {
    let connects = 0;
    const closed: string[] = [];
    const fake = (launched: boolean) => async () => {
      connects++;
      return { launched, conn: { send: async (m: string, p?: Record<string, unknown>, sid?: string) => (m === 'Browser.close' ? closed.push(m) : browser.conn.send(m, p, sid)), close() {} } as never };
    };
    const idle = lazyRenderer({ connect: fake(true) });
    await idle.close();
    assert.equal(connects, 0, 'no watch needs Chrome, nothing is started');
    const started = lazyRenderer({ connect: fake(true), allowLocal: true });
    await started.render(`${base}/js-price`);
    await started.close();
    assert.deepEqual(closed, ['Browser.close']);
    const theirs = lazyRenderer({ connect: fake(false), allowLocal: true });
    await theirs.render(`${base}/js-price`);
    await theirs.close();
    assert.deepEqual(closed, ['Browser.close'], "the user's own window is left open");
  });
});
