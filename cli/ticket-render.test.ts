import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { MAX_TICKET_PAGES, clearTicketRenderCache, renderTicketPages } from './ticket-render.ts';
import type { Run } from './ticket-render.ts';

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

async function withFile<T>(name: string, fn: (abs: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'tripcode-ticket-test-'));
  try {
    const abs = path.join(dir, name);
    await writeFile(abs, 'not really a pdf');
    return await fn(abs);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A stand-in for pdftoppm: writes `pages` PNGs named like the real tool does (zero padded). */
const fakePdftoppm = (pages: number, calls: string[][] = []): Run => async (cmd, args) => {
  calls.push([cmd, ...args]);
  const prefix = args.at(-1)!;
  for (let i = 1; i <= pages; i++) await writeFile(`${prefix}-${String(i).padStart(2, '0')}.png`, PNG);
};

test('a PDF becomes PNG pages, in order, with the first pages only and a flag when there are more', async () => {
  clearTicketRenderCache();
  await withFile('a.pdf', async (abs) => {
    const calls: string[][] = [];
    const r = await renderTicketPages(abs, 'pdf', { run: fakePdftoppm(7, calls), find: async (n) => (n === 'pdftoppm' ? '/x/pdftoppm' : undefined) });
    assert.equal(r.pages.length, MAX_TICKET_PAGES);
    assert.equal(r.more, true);
    assert.equal(r.firstPageOnly, false);
    assert.equal(Buffer.from(r.pages[0]!.dataBase64, 'base64').equals(PNG), true);
    assert.deepEqual(calls[0]!.slice(0, 7), ['/x/pdftoppm', '-png', '-r', '150', '-f', '1', '-l']);
    assert.equal(calls[0]![7], String(MAX_TICKET_PAGES + 1));
  });
});

test('a short PDF has no "more"; the same unchanged file is converted once', async () => {
  clearTicketRenderCache();
  await withFile('b.pdf', async (abs) => {
    const calls: string[][] = [];
    const deps = { run: fakePdftoppm(2, calls), find: async () => '/x/pdftoppm' };
    const r1 = await renderTicketPages(abs, 'pdf', deps);
    const r2 = await renderTicketPages(abs, 'pdf', deps);
    assert.equal(r1.pages.length, 2);
    assert.equal(r1.more, false);
    assert.equal(r2, r1);
    assert.equal(calls.length, 1);
  });
});

test('without pdftoppm a Mac falls back to sips and says only the first page was made', async () => {
  clearTicketRenderCache();
  await withFile('c.pdf', async (abs) => {
    const ran: string[][] = [];
    const run: Run = async (cmd, args) => {
      ran.push([cmd, ...args]);
      await writeFile(args.at(-1)!, PNG);
    };
    const r = await renderTicketPages(abs, 'pdf', { run, find: async (n) => (n === 'sips' ? '/usr/bin/sips' : undefined) });
    assert.equal(r.pages.length, 1);
    assert.equal(r.firstPageOnly, true);
    assert.deepEqual(ran[0]!.slice(0, 4), ['/usr/bin/sips', '-s', 'format', 'png']);
  });
});

test('a HEIC photo is converted by sips and is not marked first-page-only', async () => {
  clearTicketRenderCache();
  await withFile('d.heic', async (abs) => {
    const run: Run = async (_cmd, args) => void (await writeFile(args.at(-1)!, PNG));
    const r = await renderTicketPages(abs, 'heic', { run, find: async (n) => (n === 'sips' ? '/usr/bin/sips' : undefined) });
    assert.equal(r.firstPageOnly, false);
  });
});

test('no tool, a failing tool or a missing file is a plain message, never a crash', async () => {
  clearTicketRenderCache();
  await withFile('e.pdf', async (abs) => {
    await assert.rejects(renderTicketPages(abs, 'pdf', { run: async () => undefined, find: async () => undefined }), /沒有把 PDF 轉成圖片的工具/);
    await assert.rejects(renderTicketPages(abs, 'pdf', { run: async () => { throw new Error('boom'); }, find: async () => '/x/pdftoppm' }), /boom/);
    await assert.rejects(renderTicketPages(abs, 'pdf', { run: async () => undefined, find: async () => '/x/pdftoppm' }), /沒有得到任何頁面/);
    await assert.rejects(renderTicketPages(`${abs}.missing`, 'pdf', {}), /找不到這個票券檔/);
  });
});
