// Parsing half of the agent panel's small Markdown renderer (Markdown.tsx renders it). Supports
// paragraphs, lists, headings, fenced code, tables, **bold**, `code`, http(s) links and images, and nothing else.
// Kept free of JSX so node:test can run it.

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; href: string }
  /** `local`: a file under trips/ (or the upload folder) the panel serves itself. Otherwise an https URL, which is never auto-loaded. */
  | { kind: 'image'; alt: string; src: string; local: boolean };

export type Align = 'left' | 'center' | 'right' | null;

export type Block =
  | { kind: 'p'; text: string }
  | { kind: 'h'; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] }
  | { kind: 'code'; text: string }
  | { kind: 'table'; head: string[]; align: Align[]; rows: string[][] };

const INLINE_RE = /\*\*([^*\n]+)\*\*|`([^`\n]+)`|!\[([^\]\n]*)\]\(([^\s)]+)\)|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;

const LOCAL_IMAGE_PREFIXES = ['trips/', 'node_modules/.tripcode/attachments/'];

/** Which images a reply may show: a plain relative path under trips/ (no `..`, no dot-folders) or an https URL. */
export function classifyImage(src: string): 'local' | 'remote' | null {
  if (/^https:\/\/[^\s]+$/.test(src)) return 'remote';
  if (!LOCAL_IMAGE_PREFIXES.some((p) => src.startsWith(p))) return null;
  if (/[\\\0?#%]/.test(src)) return null;
  const rest = src.split('/').slice(1);
  if (rest.some((part) => part === '' || part === '..' || (part.startsWith('.') && part !== '.tripcode'))) return null;
  return 'local';
}

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ kind: 'text', text: text.slice(last, at) });
    if (m[1] !== undefined) out.push({ kind: 'bold', text: m[1] });
    else if (m[2] !== undefined) out.push({ kind: 'code', text: m[2] });
    else if (m[4] !== undefined) {
      const where = classifyImage(m[4]);
      // An image path the panel will not show stays visible as the text the agent wrote.
      if (where) out.push({ kind: 'image', alt: m[3] ?? '', src: m[4], local: where === 'local' });
      else out.push({ kind: 'text', text: m[0] });
    } else out.push({ kind: 'link', text: m[5] ?? '', href: m[6] ?? '' });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

const SEPARATOR_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function splitRow(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return inner.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

function alignOf(cell: string): Align {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  return left && right ? 'center' : right ? 'right' : left ? 'left' : null;
}

export function parseBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: 'p', text: para.join(' ') });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trimStart().startsWith('```')) {
      flush();
      const code: string[] = [];
      // An unterminated fence (the reply is still streaming) runs to the end.
      for (i++; i < lines.length && !(lines[i] ?? '').trimStart().startsWith('```'); i++) code.push(lines[i] ?? '');
      blocks.push({ kind: 'code', text: code.join('\n') });
      continue;
    }
    // A table is a pipe row followed by a separator row (|---|---|); the rows after it run until a line without a pipe.
    if (line.includes('|') && (lines[i + 1] ?? '').includes('|') && SEPARATOR_RE.test(lines[i + 1] ?? '')) {
      const head = splitRow(line);
      const separator = splitRow(lines[i + 1] ?? '');
      if (separator.length === head.length) {
        flush();
        const rows: string[][] = [];
        for (i += 2; i < lines.length && (lines[i] ?? '').trim() !== '' && (lines[i] ?? '').includes('|'); i++) {
          const cells = splitRow(lines[i] ?? '');
          rows.push(head.map((_, n) => cells[n] ?? ''));
        }
        i--;
        blocks.push({ kind: 'table', head, align: separator.map(alignOf), rows });
        continue;
      }
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: 'h', text: heading[1] ?? '' });
      continue;
    }
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flush();
      const kind = bullet ? 'ul' : 'ol';
      const last = blocks.at(-1);
      const item = (bullet ?? numbered)?.[1] ?? '';
      if (last?.kind === kind) last.items.push(item);
      else blocks.push({ kind, items: [item] });
      continue;
    }
    if (line.trim() === '') flush();
    else para.push(line.trim());
  }
  flush();
  return blocks;
}
