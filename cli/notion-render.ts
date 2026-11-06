// Pure Trip -> Notion blocks. No I/O. Block shapes follow the Notion API (Notion-Version 2026-03-11).
// Attachments are emitted as file/pdf/image blocks carrying a private `_attach` marker; cli/notion.ts
// uploads the file and swaps the marker for a `file_upload` reference before sending.
import type { Attachment, CandidateStatus, Issue, Item, Trip } from '../src/core/types.ts';

export const RICH_TEXT_LIMIT = 2000;
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

export interface RichText {
  type: 'text';
  text: { content: string; link?: { url: string } | null };
  annotations?: { bold?: boolean; color?: string; italic?: boolean };
}

export interface NotionBlock {
  object: 'block';
  type: string;
  [key: string]: unknown;
  /** Present only before upload; stripped by the sync step. */
  _attach?: Attachment;
}

export interface RenderInput {
  trip: Trip;
  issues: Issue[];
  /** Google Maps links for a day (core.dayMapsLinks). */
  mapsLinks: (day: Trip['days'][number]) => string[];
  /** Formatted "last synced" time shown in the summary. */
  syncedAt: string;
}

/** Splits text into rich_text pieces of at most 2000 characters (never inside a surrogate pair). */
export function richText(content: string, opts: { link?: string; bold?: boolean; color?: string } = {}): RichText[] {
  const chars = Array.from(content);
  const out: RichText[] = [];
  const pieces: string[] = [];
  for (let i = 0; i < chars.length; i += RICH_TEXT_LIMIT) pieces.push(chars.slice(i, i + RICH_TEXT_LIMIT).join(''));
  if (pieces.length === 0) pieces.push('');
  for (const p of pieces) {
    const rt: RichText = { type: 'text', text: { content: p } };
    // Notion rejects URLs over 2000 chars: fall back to plain text.
    if (opts.link && opts.link.length <= RICH_TEXT_LIMIT) rt.text.link = { url: opts.link };
    if (opts.bold || opts.color) {
      rt.annotations = {};
      if (opts.bold) rt.annotations.bold = true;
      if (opts.color) rt.annotations.color = opts.color;
    }
    out.push(rt);
  }
  return out;
}

function block(type: string, rich: RichText[], extra: Record<string, unknown> = {}): NotionBlock {
  return { object: 'block', type, [type]: { rich_text: rich, ...extra } };
}

const paragraph = (rich: RichText[]) => block('paragraph', rich);

export function formatDay(date: string, n: number, title?: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const wd = WEEK[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]!;
  return `Day ${n} · ${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}（${wd}）${title ? ` ${title}` : ''}`;
}

export function attachmentBlockType(file: string): 'pdf' | 'image' | 'file' {
  const ext = file.toLowerCase().split('.').pop() ?? '';
  if (ext === 'pdf') return 'pdf';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) return 'image';
  return 'file';
}

function attachmentBlock(a: Attachment): NotionBlock {
  const type = attachmentBlockType(a.file);
  return {
    object: 'block',
    type,
    // The id is filled in after upload.
    [type]: { type: 'file_upload', file_upload: { id: '' }, caption: richText(a.label) },
    _attach: a,
  };
}

function itemBlock(item: Item): NotionBlock {
  const time = item.start ? `${item.start}${item.end ? `–${item.end}` : ''} ` : '';
  const gray = item.kind === 'transit' ? 'gray' : undefined;
  const o = (extra: object = {}) => ({ ...(gray ? { color: gray } : {}), ...extra });
  const rich = [...richText(time, o({ bold: true })), ...richText(item.title, o())];
  const children: NotionBlock[] = [];
  if (item.note?.trim()) children.push(paragraph(richText(item.note.trim(), o())));
  for (const a of item.attachments ?? []) children.push(attachmentBlock(a));
  const b = block('bulleted_list_item', rich);
  if (children.length) (b['bulleted_list_item'] as Record<string, unknown>)['children'] = children;
  return b;
}

const STATUS_LABEL: Record<CandidateStatus, string> = {
  unconfirmed: '未確認',
  accepted: '已接受',
  discuss: '待討論',
  rejected: '已排除',
};

export function renderTrip(input: RenderInput): NotionBlock[] {
  const { trip, issues, mapsLinks, syncedAt } = input;
  const errors = issues.filter((i) => i.level === 'error').length;
  const warns = issues.length - errors;
  const party = `${trip.party.adults} 位成人${trip.party.childrenAges.length ? `、${trip.party.childrenAges.length} 位小孩（${trip.party.childrenAges.join('、')} 歲）` : ''}`;
  const status = issues.length === 0 ? '健檢通過' : `健檢：${errors} 個錯誤、${warns} 個警告`;
  const summary = [`${trip.start} ~ ${trip.end}（${trip.days.length} 天）`, party, status, `最後同步：${syncedAt}`].join('\n');

  const blocks: NotionBlock[] = [
    block('callout', richText(summary), { icon: { type: 'emoji', emoji: '🧳' } }),
  ];

  trip.days.forEach((day, i) => {
    blocks.push(block('heading_2', richText(formatDay(day.date, i + 1, day.title))));
    const links = mapsLinks(day);
    if (links.length) {
      const rich: RichText[] = [];
      links.forEach((url, j) => {
        if (j) rich.push(...richText('　'));
        rich.push(...richText(links.length > 1 ? `Google 地圖路線 ${j + 1}` : 'Google 地圖路線', { link: url }));
      });
      blocks.push(paragraph(rich));
    }
    for (const item of day.items) blocks.push(itemBlock(item));
  });

  if (trip.candidates.length) {
    blocks.push(block('heading_2', richText('候選景點')));
    for (const c of trip.candidates) {
      const day = c.status === 'accepted' && c.day ? `，第 ${c.day} 天` : '';
      const b = block('bulleted_list_item', [...richText(c.title, { bold: true }), ...richText(`（${STATUS_LABEL[c.status]}${day}）`)]);
      if (c.why?.trim()) (b['bulleted_list_item'] as Record<string, unknown>)['children'] = [paragraph(richText(c.why.trim()))];
      blocks.push(b);
    }
  }
  return blocks;
}

/** Number of blocks including nested children (Notion caps one request at 1000 block elements). */
export function countBlocks(blocks: NotionBlock[]): number {
  let n = 0;
  for (const b of blocks) {
    n += 1;
    const inner = b[b.type] as { children?: NotionBlock[] } | undefined;
    if (inner?.children) n += countBlocks(inner.children);
  }
  return n;
}

/** Strips internal markers, for --dry-run output. */
export function stripMarkers<T>(blocks: T): T {
  return JSON.parse(JSON.stringify(blocks, (k, v) => (k === '_attach' ? undefined : v)));
}
