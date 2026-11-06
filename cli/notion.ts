// Minimal Notion API client (plain fetch, injected for tests) and the idempotent trip sync.
// Verified against developers.notion.com on 2026-10-16:
//   Notion-Version 2026-03-11 (https://developers.notion.com/reference/versioning)
//   POST /v1/pages, PATCH /v1/blocks/{id}/children (<=100 children, <=2 nesting levels per request),
//   GET /v1/blocks/{id}/children, DELETE /v1/blocks/{id}
//   POST /v1/file_uploads -> POST /v1/file_uploads/{id}/send (multipart, <=20 MB) -> attach within 1 hour;
//   after the first attachment the file upload is permanent and its id stays reusable
//   (https://developers.notion.com/docs/uploading-small-files)
//   Limits: 2000 chars per rich text, 1000 blocks / 500 KB per request, 429 + Retry-After
//   (https://developers.notion.com/reference/request-limits)
// The token is only ever put in the Authorization header; it is never logged or put in errors.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FetchLike } from './google.ts';
import { countBlocks } from './notion-render.ts';
import type { NotionBlock } from './notion-render.ts';

export const NOTION_VERSION = '2026-03-11';
export const NOTION_API = 'https://api.notion.com/v1';
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_BATCH_BLOCKS = 100;
/** Notion allows 1000 block elements per request; stay well under including nested children. */
const MAX_BATCH_ELEMENTS = 800;

export class NotionApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'NotionApiError';
    this.status = status;
    if (code !== undefined) this.code = code;
  }
}

export interface NotionClientOptions {
  token: string;
  fetch: FetchLike;
  /** Injected for tests so retries and throttling do not really wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Minimum gap between requests (default 350 ms ≈ 3 req/s). */
  minIntervalMs?: number;
  maxRetries?: number;
}

type Json = Record<string, any>;

export class NotionClient {
  #token: string;
  #fetch: FetchLike;
  #sleep: (ms: number) => Promise<void>;
  #gap: number;
  #maxRetries: number;
  #last = 0;
  requests = 0;

  constructor(o: NotionClientOptions) {
    this.#token = o.token;
    this.#fetch = o.fetch;
    this.#sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#gap = o.minIntervalMs ?? 350;
    this.#maxRetries = o.maxRetries ?? 5;
  }

  async #request(method: string, apiPath: string, body?: Json | FormData): Promise<Json> {
    const idempotent = method === 'GET' || method === 'DELETE';
    for (let attempt = 0; ; attempt++) {
      const wait = this.#last + this.#gap - Date.now();
      if (wait > 0) await this.#sleep(wait);
      this.#last = Date.now();
      this.requests++;
      const headers: Record<string, string> = { Authorization: `Bearer ${this.#token}`, 'Notion-Version': NOTION_VERSION };
      const init: RequestInit = { method, headers };
      if (body instanceof FormData) init.body = body; // fetch sets the multipart boundary itself
      else if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      const res = await this.#fetch(`${NOTION_API}${apiPath}`, init);
      if (res.ok) return (await res.json().catch(() => ({}))) as Json;

      const err = (await res.json().catch(() => ({}))) as Json;
      const retryable = res.status === 429 || res.status === 529 || (idempotent && res.status >= 500 && res.status < 600);
      if (retryable && attempt < this.#maxRetries && err?.additional_data?.rate_limit_reason !== 'public_api_request_blocked') {
        const ra = Number(res.headers.get('Retry-After') ?? err?.additional_data?.retry_after);
        const delay = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(30000, 1000 * 2 ** attempt);
        await this.#sleep(delay);
        continue;
      }
      throw new NotionApiError(describeError(res.status, err), res.status, err?.code);
    }
  }

  createPage(parentPageId: string, title: string): Promise<Json> {
    return this.#request('POST', '/pages', {
      parent: { type: 'page_id', page_id: parentPageId },
      properties: { title: { title: [{ type: 'text', text: { content: title.slice(0, 2000) } }] } },
    });
  }
  getPage(id: string): Promise<Json> {
    return this.#request('GET', `/pages/${id}`);
  }
  updatePageTitle(id: string, title: string): Promise<Json> {
    return this.#request('PATCH', `/pages/${id}`, {
      properties: { title: { title: [{ type: 'text', text: { content: title.slice(0, 2000) } }] } },
    });
  }
  async listChildIds(id: string): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const r = await this.#request('GET', `/blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''}`);
      for (const b of r.results ?? []) ids.push(b.id);
      cursor = r.has_more ? r.next_cursor : undefined;
    } while (cursor);
    return ids;
  }
  deleteBlock(id: string): Promise<Json> {
    return this.#request('DELETE', `/blocks/${id}`);
  }
  appendChildren(id: string, children: unknown[]): Promise<Json> {
    return this.#request('PATCH', `/blocks/${id}/children`, { children });
  }
  createFileUpload(filename: string, contentType: string): Promise<Json> {
    return this.#request('POST', '/file_uploads', { filename, content_type: contentType });
  }
  sendFileUpload(id: string, filename: string, contentType: string, data: Uint8Array): Promise<Json> {
    const form = new FormData();
    form.append('file', new Blob([data as BlobPart], { type: contentType }), filename);
    return this.#request('POST', `/file_uploads/${id}/send`, form);
  }
}

function describeError(status: number, body: Json): string {
  const msg = typeof body?.message === 'string' ? body.message : '（沒有訊息）';
  let hint = '';
  if (status === 401) hint = ' 請確認 NOTION_TOKEN 是否正確（internal integration 的 secret）。';
  else if (status === 403) hint = ' 這個 integration 沒有足夠權限（需要「讀取、更新、插入內容」）。';
  else if (status === 404) hint = ' 找不到該頁面，或該頁面尚未分享給你的 integration（頁面右上角 ⋯ → Connections → 加入你的 integration）。';
  return `Notion 回應 ${status}${body?.code ? ` (${body.code})` : ''}：${msg}${hint}`;
}

const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  heic: 'image/heic',
  pkpass: 'application/vnd.apple.pkpass',
};
export function mimeFor(file: string): string {
  return MIME[file.toLowerCase().split('.').pop() ?? ''] ?? 'application/octet-stream';
}

/** Accepts a page id (with/without dashes) or a notion.so URL; returns the dashed UUID or undefined. */
export function normalizePageId(input: string): string | undefined {
  const m = input.trim().replace(/-/g, '').match(/([0-9a-f]{32})(?:[?#].*)?$/i);
  if (!m) return undefined;
  const h = m[1]!.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export interface NotionState {
  pageId?: string;
  /** Pages for non-default plan files (e.g. variant-b.ts). */
  variants?: Record<string, string>;
  /** Attachment path (relative to the trip folder) -> content hash and its permanent file upload id. */
  files: Record<string, { sha256: string; fileUploadId: string }>;
}

/** Deep-copies blocks, replacing every `_attach` marker via `resolve` (returning a replacement block). */
export function mapAttachments(blocks: NotionBlock[], resolve: (b: NotionBlock) => NotionBlock): NotionBlock[] {
  return blocks.map((b) => {
    if (b._attach) return resolve(b);
    const inner = b[b.type] as { children?: NotionBlock[] } | undefined;
    if (inner?.children) {
      return { ...b, [b.type]: { ...inner, children: mapAttachments(inner.children, resolve) } } as NotionBlock;
    }
    return b;
  });
}

function withUploadId(b: NotionBlock, id: string): NotionBlock {
  const { _attach, ...rest } = b;
  void _attach;
  const inner = rest[b.type] as Json;
  return { ...rest, [b.type]: { ...inner, file_upload: { id } } } as NotionBlock;
}

/** Splits top-level blocks into batches of ≤100 blocks and ≤800 block elements (incl. nested). */
export function batchBlocks(blocks: NotionBlock[]): NotionBlock[][] {
  const batches: NotionBlock[][] = [];
  let cur: NotionBlock[] = [];
  let elems = 0;
  for (const b of blocks) {
    const n = countBlocks([b]);
    if (cur.length && (cur.length >= MAX_BATCH_BLOCKS || elems + n > MAX_BATCH_ELEMENTS)) {
      batches.push(cur);
      cur = [];
      elems = 0;
    }
    cur.push(b);
    elems += n;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

export interface SyncOptions {
  client: NotionClient;
  title: string;
  /** Required when no page exists yet. */
  parentPageId?: string;
  /** Page id already stored for this plan file. */
  existingPageId?: string;
  blocks: NotionBlock[];
  /** Absolute trip folder, for resolving attachment paths. */
  tripDir: string;
  state: NotionState;
  /** Called after every state change so progress survives a crash. */
  save: (state: NotionState) => Promise<void>;
  warn: (msg: string) => void;
  /** Called when the page id is known (existing or newly created), before content is written. */
  onPage?: (pageId: string) => void;
}

export interface SyncResult {
  pageId: string;
  url?: string;
  created: boolean;
  blocks: number;
  uploaded: number;
  reused: number;
}

export async function syncTrip(o: SyncOptions): Promise<SyncResult> {
  const { client, state } = o;
  let pageId = o.existingPageId;
  let url: string | undefined;
  let created = false;

  if (pageId) {
    try {
      const page = await client.getPage(pageId);
      if (page.archived || page.in_trash) pageId = undefined;
      else url = page.url;
    } catch (e) {
      if (e instanceof NotionApiError && e.status === 404) pageId = undefined;
      else throw e;
    }
  }
  if (pageId) {
    await client.updatePageTitle(pageId, o.title);
    for (const id of await client.listChildIds(pageId)) await client.deleteBlock(id);
  } else {
    if (!o.parentPageId) throw new NotionApiError('沒有可用的父頁面 id', 0);
    const page = await client.createPage(o.parentPageId, o.title);
    pageId = page.id as string;
    url = page.url;
    created = true;
  }
  o.onPage?.(pageId);
  await o.save(state);

  let uploaded = 0;
  let reused = 0;
  const cache = state.files;

  interface Run {
    fresh: Record<string, { sha256: string; fileUploadId: string }>;
    usedCached: boolean;
  }
  const resolveBatch = async (bs: NotionBlock[], run: Run): Promise<NotionBlock[]> => {
    // Resolve sequentially: uploads must happen right before attaching (they expire after 1 hour).
    const pending: { block: NotionBlock; id: string }[] = [];
    const files = new Map<string, string>();
    const collect = (list: NotionBlock[]) => {
      for (const b of list) {
        if (b._attach) pending.push({ block: b, id: '' });
        const inner = b[b.type] as { children?: NotionBlock[] } | undefined;
        if (inner?.children) collect(inner.children);
      }
    };
    collect(bs);
    const problems = new Map<NotionBlock, string>();
    for (const p of pending) {
      const rel = p.block._attach!.file;
      if (files.has(rel)) continue;
      const abs = path.resolve(o.tripDir, rel);
      if (abs !== o.tripDir && !abs.startsWith(o.tripDir + path.sep)) {
        problems.set(p.block, `附件路徑不在行程資料夾內：${rel}`);
        continue;
      }
      let data: Buffer;
      try {
        data = await readFile(abs);
      } catch {
        problems.set(p.block, `找不到附件檔案：${rel}`);
        continue;
      }
      if (data.length > MAX_UPLOAD_BYTES) {
        problems.set(p.block, `附件超過 20 MB，未上傳：${rel}`);
        continue;
      }
      const sha = createHash('sha256').update(data).digest('hex');
      const hit = cache[rel];
      if (hit && hit.sha256 === sha) {
        files.set(rel, hit.fileUploadId);
        run.usedCached = true;
        reused++;
        continue;
      }
      const ct = mimeFor(rel);
      const filename = path.basename(rel);
      const up = await client.createFileUpload(filename, ct);
      await client.sendFileUpload(up.id as string, filename, ct, data);
      uploaded++;
      files.set(rel, up.id as string);
      run.fresh[rel] = { sha256: sha, fileUploadId: up.id as string };
    }
    return mapAttachments(bs, (b) => {
      const a = b._attach!;
      const id = files.get(a.file);
      if (id) return withUploadId(b, id);
      const msg = problems.get(b) ?? `無法上傳附件：${a.file}`;
      o.warn(msg);
      return {
        object: 'block',
        type: 'paragraph',
        paragraph: { rich_text: [{ type: 'text', text: { content: `（${a.label}：${msg}）` }, annotations: { color: 'red' } }] },
      };
    });
  };

  for (const batch of batchBlocks(o.blocks)) {
    for (const attempt of [0, 1]) {
      const run: Run = { fresh: {}, usedCached: false };
      const resolved = await resolveBatch(batch, run);
      try {
        await client.appendChildren(pageId, resolved);
        Object.assign(cache, run.fresh);
        await o.save(state);
        break;
      } catch (e) {
        // A cached upload id may have been invalidated: drop the cache entries and upload again once.
        if (attempt === 0 && run.usedCached && e instanceof NotionApiError && e.status === 400) {
          for (const k of Object.keys(cache)) delete cache[k];
          reused = 0;
          continue;
        }
        throw e;
      }
    }
  }

  return { pageId, ...(url !== undefined ? { url } : {}), created, blocks: countBlocks(o.blocks), uploaded, reused };
}
