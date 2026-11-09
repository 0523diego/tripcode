import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { handleTripcodeRequest } from './vite-plugin-tripcode.ts';
import type { SourceEdits } from './vite-plugin-tripcode.ts';

const edits = {} as SourceEdits;

async function withTrip<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'tripcode-ticket-ep-'));
  try {
    await mkdir(path.join(root, 'trips', 'rome', 'tickets'), { recursive: true });
    await writeFile(path.join(root, 'trips', 'rome', 'tickets', 'a.pdf'), 'x');
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('ticket-image renders a ticket PDF through the injected renderer and only for files in tickets/', async () => {
  await withTrip(async (root) => {
    const seen: string[] = [];
    const renderTicket = async (abs: string, ext: 'pdf' | 'heic') => {
      seen.push(`${path.relative(root, abs)}|${ext}`);
      return { pages: [{ mime: 'image/png' as const, dataBase64: 'AAAA' }], more: false, firstPageOnly: false };
    };
    const ok = await handleTripcodeRequest('ticket-image', { tripId: 'rome', attachmentFile: 'tickets/a.pdf' }, { root, edits, renderTicket });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json.ok && (ok.json as { pages: unknown[] }).pages.length, 1);
    assert.deepEqual(seen, ['trips/rome/tickets/a.pdf|pdf']);

    for (const file of ['tickets/../trip.ts', '../secret.pdf', 'trip.pdf', 'tickets/A.PDF', '/etc/passwd', 'tickets/a.pdf/../../x.pdf']) {
      const r = await handleTripcodeRequest('ticket-image', { tripId: 'rome', attachmentFile: file }, { root, edits, renderTicket });
      assert.equal(r.status, 400, file);
    }
    const png = await handleTripcodeRequest('ticket-image', { tripId: 'rome', attachmentFile: 'tickets/a.png' }, { root, edits, renderTicket });
    assert.equal(png.status, 400, 'a picture needs no conversion');
    assert.equal(seen.length, 1, 'nothing outside tickets/ ever reached the renderer');
  });
});

test('ticket-image: a renderer that cannot convert is a 422 with its message, not a 500', async () => {
  await withTrip(async (root) => {
    const r = await handleTripcodeRequest('ticket-image', { tripId: 'rome', attachmentFile: 'tickets/a.pdf' }, { root, edits, renderTicket: async () => { throw new Error('沒有工具'); } });
    assert.equal(r.status, 422);
    assert.deepEqual(r.json, { ok: false, error: '沒有工具' });
  });
});
