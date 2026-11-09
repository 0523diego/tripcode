// Pure string → string edits of a trip.ts source. The viewer may only make these edits; every
// edit is scoped to one object literal and leaves all other bytes untouched.
//
// This is deliberately not a full TypeScript parser. A small scanner classifies every character as
// code / string / comment so that braces inside '...', "...", `...` (with ${} nesting) and
// comments never confuse brace matching. Regex literals are not recognised (trip files do not use them).

import type { Attachment, Candidate, CandidateStatus } from './types.ts';

export type CommentAnchor = 'item' | 'gap' | 'leg' | 'day';
export type EditableField = 'title' | 'start' | 'end' | 'flightNo' | 'bookingRef' | 'note';

const EDITABLE_FIELDS: readonly string[] = ['title', 'start', 'end', 'flightNo', 'bookingRef', 'note'];
const ANCHORS: readonly string[] = ['item', 'gap', 'leg', 'day'];
const STATUSES: readonly string[] = ['unconfirmed', 'accepted', 'discuss', 'rejected'];

// ---- scanner ---------------------------------------------------------------

const CODE = 0;
const STR = 1; // string / template body and closing quote
const OPEN = 2; // opening quote of a string literal (counts as the start of code for key matching)
const COMMENT = 3;

/** Classify every character of `src` as CODE, STR, OPEN or COMMENT. */
function scan(src: string): Uint8Array {
  const n = src.length;
  const k = new Uint8Array(n);
  const templateDepths: number[] = []; // brace depth at each open `${`
  let depth = 0;

  /** Scan template text from `j`; returns the index where code resumes (after `${`) or the end. */
  const template = (from: number): number => {
    let j = from;
    while (j < n) {
      const c = src.charAt(j);
      if (c === '\\') {
        k[j] = STR;
        if (j + 1 < n) k[j + 1] = STR;
        j += 2;
      } else if (c === '`') {
        k[j] = STR;
        return j + 1;
      } else if (c === '$' && src.charAt(j + 1) === '{') {
        k[j] = STR;
        k[j + 1] = STR;
        templateDepths.push(depth);
        return j + 2;
      } else {
        k[j] = STR;
        j++;
      }
    }
    return n;
  };

  let i = 0;
  while (i < n) {
    const c = src.charAt(i);
    const next = src.charAt(i + 1);
    if (c === '/' && next === '/') {
      let j = src.indexOf('\n', i);
      if (j < 0) j = n;
      k.fill(COMMENT, i, j);
      i = j;
    } else if (c === '/' && next === '*') {
      const j = src.indexOf('*/', i + 2);
      const end = j < 0 ? n : j + 2;
      k.fill(COMMENT, i, end);
      i = end;
    } else if (c === "'" || c === '"') {
      k[i] = OPEN;
      let j = i + 1;
      while (j < n && src.charAt(j) !== c && src.charAt(j) !== '\n') {
        if (src.charAt(j) === '\\') j++;
        j++;
      }
      const end = Math.min(j + 1, n);
      if (end > i + 1) k.fill(STR, i + 1, end);
      i = src.charAt(j) === '\n' ? j : end; // an unterminated string stops at the newline
    } else if (c === '`') {
      k[i] = OPEN;
      i = template(i + 1);
    } else if (c === '{') {
      depth++;
      i++;
    } else if (c === '}') {
      if (templateDepths.length > 0 && templateDepths[templateDepths.length - 1] === depth) {
        templateDepths.pop();
        k[i] = STR;
        i = template(i + 1);
      } else {
        depth--;
        i++;
      }
    } else {
      i++;
    }
  }
  return k;
}

const kindAt = (k: Uint8Array, i: number): number => k[i] ?? CODE;
const isWs = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r';

/** Skip whitespace and comments from `i`, never going past `end`. */
function skipTrivia(src: string, k: Uint8Array, i: number, end: number): number {
  let j = i;
  while (j < end && (kindAt(k, j) === COMMENT || (kindAt(k, j) === CODE && isWs(src.charAt(j))))) j++;
  return j;
}

/** Index after the `}` matching the `{` at `open`, or -1. */
function matchBrace(src: string, k: Uint8Array, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (kindAt(k, i) !== CODE) continue;
    const c = src.charAt(i);
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Index of the innermost unmatched `{` before `pos`, or -1. */
function enclosingOpen(src: string, k: Uint8Array, pos: number): number {
  let depth = 0;
  for (let i = pos - 1; i >= 0; i--) {
    if (kindAt(k, i) !== CODE) continue;
    const c = src.charAt(i);
    if (c === '}') depth++;
    else if (c === '{') {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

interface Prop {
  key: string;
  keyStart: number;
  /** First character of the value expression. */
  valueStart: number;
  /** Index just after the value's last significant character (trailing space/comments excluded). */
  valueEnd: number;
  /** Index of the terminating comma, or of the object's closing brace. */
  termIdx: number;
  hasComma: boolean;
}

/** First-level properties of the object literal spanning [start, end). */
function listProps(src: string, k: Uint8Array, start: number, end: number): Prop[] {
  const props: Prop[] = [];
  const close = end - 1;
  let i = start + 1;
  for (;;) {
    i = skipTrivia(src, k, i, close);
    if (i >= close) break;
    let j = i;
    let nest = 0;
    let colon = -1;
    for (; j < close; j++) {
      if (kindAt(k, j) !== CODE) continue;
      const c = src.charAt(j);
      if (c === '(' || c === '[' || c === '{') nest++;
      else if (c === ')' || c === ']' || c === '}') nest--;
      else if (c === ',' && nest === 0) break;
      else if (c === ':' && nest === 0 && colon < 0) colon = j;
    }
    if (colon >= 0) {
      let key = src.slice(i, colon).trim();
      const q = key.charAt(0);
      if ((q === "'" || q === '"') && key.length >= 2 && key.endsWith(q)) key = key.slice(1, -1);
      let valueEnd = j;
      while (valueEnd > colon + 1 && (kindAt(k, valueEnd - 1) === COMMENT || (kindAt(k, valueEnd - 1) === CODE && isWs(src.charAt(valueEnd - 1))))) {
        valueEnd--;
      }
      props.push({
        key,
        keyStart: i,
        valueStart: skipTrivia(src, k, colon + 1, j),
        valueEnd,
        termIdx: j,
        hasComma: j < close && src.charAt(j) === ',',
      });
    }
    if (j >= close) break;
    i = j + 1;
  }
  return props;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface Located {
  k: Uint8Array;
  start: number;
  end: number;
}

/** The object literal that has a first-level property `key: '<value>'`. */
function locate(src: string, key: string, value: string): Located | null {
  const k = scan(src);
  const re = new RegExp(`(?<![\\w$])(['"]?)${escapeRegExp(key)}\\1\\s*:\\s*(['"])${escapeRegExp(value)}\\2`, 'g');
  for (const m of src.matchAll(re)) {
    const idx = m.index ?? 0;
    const kind = kindAt(k, idx);
    if (kind !== CODE && kind !== OPEN) continue; // inside a string or comment
    const start = enclosingOpen(src, k, idx);
    if (start < 0) continue;
    const end = matchBrace(src, k, start);
    if (end < 0) continue;
    return { k, start, end };
  }
  return null;
}

/** Locate the object whose first-level property `id` equals `id`. start = index of `{`, end = index after `}`. */
export function findObjectById(src: string, id: string): { start: number; end: number } | null {
  const hit = locate(src, 'id', id);
  return hit ? { start: hit.start, end: hit.end } : null;
}

// ---- helpers ----------------------------------------------------------------

/** Render a JS string as a single-quoted literal. */
function quote(s: string): string {
  let out = "'";
  for (const ch of s) {
    switch (ch) {
      case '\\': out += '\\\\'; break;
      case "'": out += "\\'"; break;
      case '\n': out += '\\n'; break;
      case '\r': out += '\\r'; break;
      case '\t': out += '\\t'; break;
      case '\u2028': out += '\\u2028'; break;
      case '\u2029': out += '\\u2029'; break;
      default: {
        const code = ch.codePointAt(0) ?? 0;
        out += code < 0x20 ? `\\x${code.toString(16).padStart(2, '0')}` : ch;
      }
    }
  }
  return out + "'";
}

function eolOf(src: string): string {
  return src.includes('\r\n') ? '\r\n' : '\n';
}

function lineStartOf(src: string, pos: number): number {
  return pos <= 0 ? 0 : src.lastIndexOf('\n', pos - 1) + 1;
}

/** Index of the line terminator at or after `pos` (before a `\r\n` pair), or src.length. */
function lineEndFrom(src: string, pos: number): number {
  const nl = src.indexOf('\n', pos);
  if (nl < 0) return src.length;
  return nl > pos && src.charAt(nl - 1) === '\r' ? nl - 1 : nl;
}

function indentOf(src: string, lineStart: number): string {
  return /^[ \t]*/.exec(src.slice(lineStart, lineEndFrom(src, lineStart)))?.[0] ?? '';
}

/** True when [from, to) holds only whitespace and comments. */
function blank(src: string, k: Uint8Array, from: number, to: number): boolean {
  for (let i = from; i < to; i++) {
    if (kindAt(k, i) !== COMMENT && !isWs(src.charAt(i))) return false;
  }
  return true;
}

/** Remove one first-level property (and its comma / own line) from the object that starts at `start`. */
function removeProp(src: string, k: Uint8Array, start: number, existing: Prop): string {
  const after = existing.hasComma ? existing.termIdx + 1 : existing.valueEnd;
  const lineStart = lineStartOf(src, existing.keyStart);
  const lineEnd = lineEndFrom(src, after);
  if (blank(src, k, lineStart, existing.keyStart) && blank(src, k, after, lineEnd)) {
    // The property owns its whole line: drop the line including its terminator.
    let cut = lineEnd;
    if (src.startsWith('\r\n', cut)) cut += 2;
    else if (src.charAt(cut) === '\n') cut += 1;
    return src.slice(0, lineStart) + src.slice(cut);
  }
  if (existing.hasComma) {
    let cut = after;
    while (src.charAt(cut) === ' ' || src.charAt(cut) === '\t') cut++;
    return src.slice(0, existing.keyStart) + src.slice(cut);
  }
  // Last property on a shared line: remove the comma that precedes it.
  let b = existing.keyStart - 1;
  while (b > start && (kindAt(k, b) === COMMENT || isWs(src.charAt(b)))) b--;
  const from = src.charAt(b) === ',' && kindAt(k, b) === CODE ? b : existing.keyStart;
  return src.slice(0, from) + src.slice(existing.valueEnd);
}

/**
 * Set (literal !== null) or remove (literal === null) a first-level property of the object that has
 * `idKey: idValue`. A missing property is inserted after `id:`; removing a missing property is a no-op.
 */
function editProp(src: string, idKey: string, idValue: string, prop: string, literal: string | null): string {
  const hit = locate(src, idKey, idValue);
  if (!hit) throw new Error(`找不到 ${idKey} 為「${idValue}」的物件`);
  const { k, start, end } = hit;
  const props = listProps(src, k, start, end);
  const existing = props.find((p) => p.key === prop);

  if (existing) {
    if (literal !== null) {
      return src.slice(0, existing.valueStart) + literal + src.slice(existing.valueEnd);
    }
    return removeProp(src, k, start, existing);
  }

  if (literal === null) return src;

  const idIdx = props.findIndex((p) => p.key === idKey);
  const idp = props[idIdx];
  if (!idp) throw new Error(`找不到 ${idKey} 為「${idValue}」的物件`);
  const afterId = idp.hasComma ? idp.termIdx + 1 : idp.valueEnd;
  const lineEnd = lineEndFrom(src, afterId);
  const entry = `${prop}: ${literal}`;

  if (!blank(src, k, afterId, lineEnd)) {
    // Single-line (or shared-line) object: insert inline.
    return idp.hasComma
      ? `${src.slice(0, afterId)} ${entry},${src.slice(afterId)}`
      : `${src.slice(0, idp.valueEnd)}, ${entry}${src.slice(idp.valueEnd)}`;
  }

  // Multi-line object: new property on its own line right below `id`.
  const eol = eolOf(src);
  const idLineStart = lineStartOf(src, idp.keyStart);
  let indent: string;
  if (blank(src, k, idLineStart, idp.keyStart)) {
    indent = indentOf(src, idLineStart);
  } else {
    const nextProp = props[idIdx + 1];
    indent =
      nextProp && lineStartOf(src, nextProp.keyStart) !== idLineStart
        ? indentOf(src, lineStartOf(src, nextProp.keyStart))
        : indentOf(src, idLineStart) + '  ';
  }
  if (idp.hasComma) {
    return `${src.slice(0, lineEnd)}${eol}${indent}${entry},${src.slice(lineEnd)}`;
  }
  return `${src.slice(0, idp.valueEnd)},${src.slice(idp.valueEnd, lineEnd)}${eol}${indent}${entry}${src.slice(lineEnd)}`;
}

// ---- public edits -----------------------------------------------------------

/**
 * Insert `// @trip-comment(<anchor>): <text>` on its own line directly above the line that opens the
 * target object, with the same indentation. For anchor 'day' the target is the day's date.
 */
export function insertComment(src: string, targetId: string, text: string, anchor: CommentAnchor = 'item'): string {
  if (!ANCHORS.includes(anchor)) throw new Error(`不支援的留言類型：${String(anchor)}（可用：item、gap、leg、day）`);
  const clean = String(text).replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' ').trim();
  if (clean === '') throw new Error('留言內容不可為空');
  const hit = anchor === 'day' ? locate(src, 'date', targetId) : locate(src, 'id', targetId);
  if (!hit) throw new Error(anchor === 'day' ? `找不到日期為「${targetId}」的那一天` : `找不到 id 為「${targetId}」的物件`);
  const lineStart = lineStartOf(src, hit.start);
  const indent = indentOf(src, lineStart);
  return `${src.slice(0, lineStart)}${indent}// @trip-comment(${anchor}): ${clean}${eolOf(src)}${src.slice(lineStart)}`;
}

/** Replace (or insert after `id:`) a first-level string property of the item with the given id. */
export function setItemField(src: string, itemId: string, field: EditableField, value: string): string {
  if (!EDITABLE_FIELDS.includes(field)) {
    throw new Error(`不允許編輯欄位「${String(field)}」（可編輯：${EDITABLE_FIELDS.join('、')}）`);
  }
  if (typeof value !== 'string') throw new Error(`欄位「${field}」的值必須是字串`);
  return editProp(src, 'id', itemId, field, quote(value));
}

/** Set a candidate's `status`; `day` is set when accepted with a day number and removed otherwise. */
export function setCandidateStatus(src: string, candidateId: string, status: CandidateStatus, day?: number): string {
  if (!STATUSES.includes(status)) throw new Error(`無效的狀態：${String(status)}`);
  if (day !== undefined && (!Number.isInteger(day) || day < 1)) throw new Error(`無效的天數：${String(day)}（需為 1 以上的整數）`);
  let out = editProp(src, 'id', candidateId, 'status', quote(status));
  if (status !== 'accepted') out = editProp(out, 'id', candidateId, 'day', null);
  else if (day !== undefined) out = editProp(out, 'id', candidateId, 'day', String(day));
  return out;
}

// ---- v1.1: candidates and attachments -----------------------------------------

/** Index after the `]` matching the `[` at `open`, or -1. */
function matchBracket(src: string, k: Uint8Array, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (kindAt(k, i) !== CODE) continue;
    const c = src.charAt(i);
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Index just after the last significant (non-space, non-comment) character in (from, to). */
function lastSignificantEnd(src: string, k: Uint8Array, from: number, to: number): number {
  let p = to;
  while (p > from && (kindAt(k, p - 1) === COMMENT || isWs(src.charAt(p - 1)))) p--;
  return p;
}

/**
 * Append `elem` (already rendered text, no trailing comma) to the array literal whose `[` is at `open`.
 * `multiline` puts the element on its own line(s); otherwise a one-line array stays one line.
 */
function appendToArray(src: string, k: Uint8Array, open: number, elem: string, baseIndent: string, multiline: boolean): string {
  const end = matchBracket(src, k, open);
  if (end < 0) throw new Error('陣列沒有結尾的 ]');
  const close = end - 1;
  const eol = eolOf(src);
  const p = lastSignificantEnd(src, k, open + 1, close);
  const empty = p === open + 1;
  const hasComma = !empty && src.charAt(p - 1) === ',' && kindAt(k, p - 1) === CODE;
  const sameLine = !src.slice(open, close).includes('\n');

  if (empty) {
    const inner = src.slice(open + 1, close);
    if (!multiline && sameLine) return `${src.slice(0, open + 1)}${elem}${src.slice(close)}`;
    const block = `${eol}${elem},${eol}${baseIndent}`;
    return inner.trim() === '' ? src.slice(0, open + 1) + block + src.slice(close) : `${src.slice(0, open + 1)}${eol}${elem},${src.slice(open + 1)}`;
  }
  if (!multiline && sameLine) {
    return hasComma ? `${src.slice(0, p)} ${elem},${src.slice(p)}` : `${src.slice(0, p)}, ${elem}${src.slice(p)}`;
  }
  if (!src.slice(p, close).includes('\n')) {
    // `]` shares the last element's line.
    return `${src.slice(0, p)}${hasComma ? '' : ','}${eol}${elem},${eol}${baseIndent}${src.slice(close)}`;
  }
  const lineEnd = lineEndFrom(src, p);
  return hasComma
    ? `${src.slice(0, lineEnd)}${eol}${elem},${src.slice(lineEnd)}`
    : `${src.slice(0, p)},${src.slice(p, lineEnd)}${eol}${elem},${src.slice(lineEnd)}`;
}

/** The root object literal of the trip: the first `{` after `export default` (skipping `defineTrip(`). */
function rootObject(src: string, k: Uint8Array): { start: number; end: number } {
  const re = /(?<![\w$])export\s+default\b/g;
  for (const m of src.matchAll(re)) {
    const idx = m.index ?? 0;
    if (kindAt(k, idx) !== CODE) continue;
    for (let i = idx + m[0].length; i < src.length; i++) {
      if (kindAt(k, i) !== CODE) continue;
      const c = src.charAt(i);
      if (c === '{') {
        const end = matchBrace(src, k, i);
        if (end > 0) return { start: i, end };
        break;
      }
      if (c !== '(' && !isWs(src.charAt(i)) && !/[\w$.]/.test(c)) break;
    }
  }
  throw new Error('找不到行程的根物件（export default defineTrip({...})）');
}

function numLiteral(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`無效的數字：${String(n)}`);
  return String(n);
}

function renderCandidate(c: Candidate, indent: string): string {
  const inner = `${indent}  `;
  const lines = [`${indent}{`, `${inner}id: ${quote(c.id)},`, `${inner}title: ${quote(c.title)},`];
  if (c.placeId) lines.push(`${inner}placeId: ${quote(c.placeId)},`);
  if (c.loc) {
    const fa = c.loc.fetchedAt ? `, fetchedAt: ${quote(c.loc.fetchedAt)}` : '';
    lines.push(`${inner}loc: { lat: ${numLiteral(c.loc.lat)}, lng: ${numLiteral(c.loc.lng)}${fa} },`);
  }
  lines.push(`${inner}status: ${quote(c.status)},`);
  if (c.day !== undefined) lines.push(`${inner}day: ${numLiteral(c.day)},`);
  lines.push(`${inner}sources: [${c.sources.map(quote).join(', ')}],`);
  if (c.why) lines.push(`${inner}why: ${quote(c.why)},`);
  lines.push(`${indent}}`);
  return lines.join('\n');
}

/** `date: 'YYYY-MM-DD'` values (in file order, de-duplicated) found in code. Used to bound `day` numbers. */
export function listDayDates(src: string): string[] {
  const k = scan(src);
  const out: string[] = [];
  for (const m of src.matchAll(/(?<![\w$])(['"]?)date\1\s*:\s*(['"])(\d{4}-\d{2}-\d{2})\2/g)) {
    const kind = kindAt(k, m.index ?? 0);
    if ((kind === CODE || kind === OPEN) && !out.includes(m[3]!)) out.push(m[3]!);
  }
  return out;
}

/**
 * Append a Candidate to the trip's `candidates: [...]` array, creating the array (as the last property
 * of the root object) when it is absent. Throws when the id is already used anywhere in the file.
 */
export function insertCandidate(src: string, candidate: Candidate): string {
  if (!/^[a-z0-9-]+$/.test(candidate.id)) throw new Error(`無效的候選地點 id：${candidate.id}`);
  if (typeof candidate.title !== 'string' || candidate.title.trim() === '') throw new Error('候選地點需要標題');
  if (!STATUSES.includes(candidate.status)) throw new Error(`無效的狀態：${String(candidate.status)}`);
  if (findObjectById(src, candidate.id)) throw new Error(`id「${candidate.id}」已存在`);
  const k = scan(src);
  const root = rootObject(src, k);
  const props = listProps(src, k, root.start, root.end);
  const eol = eolOf(src);
  const existing = props.find((p) => p.key === 'candidates');

  if (existing) {
    if (src.charAt(existing.valueStart) !== '[') throw new Error('candidates 不是陣列字面值，無法自動加入');
    const keyLine = lineStartOf(src, existing.keyStart);
    const base = blank(src, k, keyLine, existing.keyStart) ? indentOf(src, keyLine) : '  ';
    const elem = renderCandidate(candidate, `${base}  `).replace(/\n/g, eol);
    return appendToArray(src, k, existing.valueStart, elem, base, true);
  }

  // No candidates array yet: add one after the root object's last property.
  const last = props[props.length - 1];
  const rootLine = lineStartOf(src, root.start);
  const base = last && blank(src, k, lineStartOf(src, last.keyStart), last.keyStart) ? indentOf(src, lineStartOf(src, last.keyStart)) : `${indentOf(src, rootLine)}  `;
  const elem = renderCandidate(candidate, `${base}  `).replace(/\n/g, eol);
  const prop = `${base}candidates: [${eol}${elem},${eol}${base}],`;
  const closeIdx = root.end - 1;
  if (!last) return `${src.slice(0, root.start + 1)}${eol}${prop}${eol}${indentOf(src, rootLine)}${src.slice(closeIdx)}`;
  const afterLast = last.hasComma ? last.termIdx + 1 : last.valueEnd;
  const lineEnd = lineEndFrom(src, afterLast);
  if (lineEnd < closeIdx) {
    return last.hasComma
      ? `${src.slice(0, lineEnd)}${eol}${prop}${src.slice(lineEnd)}`
      : `${src.slice(0, last.valueEnd)},${src.slice(last.valueEnd, lineEnd)}${eol}${prop}${src.slice(lineEnd)}`;
  }
  // `}` shares the last property's line.
  return `${src.slice(0, afterLast)}${last.hasComma ? '' : ','}${eol}${prop}${eol}${indentOf(src, rootLine)}${src.slice(closeIdx)}`;
}

function renderAttachment(a: Attachment): string {
  const kind = a.kind ? `, kind: ${quote(a.kind)}` : '';
  return `{ file: ${quote(a.file)}, label: ${quote(a.label)}${kind} }`;
}

const ATTACHMENT_KINDS: readonly string[] = ['transport', 'entry', 'booking', 'other'];

/** Append an Attachment to the item with the given id, creating `attachments: [...]` if absent. */
export function addAttachment(src: string, itemId: string, attachment: Attachment): string {
  if (typeof attachment.file !== 'string' || attachment.file === '') throw new Error('附件需要檔名');
  if (typeof attachment.label !== 'string' || attachment.label.trim() === '') throw new Error('附件需要標籤');
  if (attachment.kind !== undefined && !ATTACHMENT_KINDS.includes(attachment.kind)) throw new Error(`無效的附件類型：${String(attachment.kind)}`);
  const hit = locate(src, 'id', itemId);
  if (!hit) throw new Error(`找不到 id 為「${itemId}」的物件`);
  const props = listProps(src, hit.k, hit.start, hit.end);
  const existing = props.find((p) => p.key === 'attachments');
  const elem = renderAttachment(attachment);
  if (!existing) return editProp(src, 'id', itemId, 'attachments', `[${elem}]`);
  if (src.charAt(existing.valueStart) !== '[') throw new Error('attachments 不是陣列字面值，無法自動加入');
  const arrEnd = matchBracket(src, hit.k, existing.valueStart);
  if (arrEnd > 0 && src.slice(existing.valueStart, arrEnd).includes(quote(attachment.file))) {
    throw new Error(`附件「${attachment.file}」已存在於這個項目`);
  }
  const keyLine = lineStartOf(src, existing.keyStart);
  const base = blank(src, hit.k, keyLine, existing.keyStart) ? indentOf(src, keyLine) : '  ';
  return appendToArray(src, hit.k, existing.valueStart, `${base}  ${elem}`, base, false);
}

/** Remove the attachment whose `file` equals `file` from the item; drops `attachments` when it becomes empty. */
export function removeAttachment(src: string, itemId: string, file: string): string {
  const hit = locate(src, 'id', itemId);
  if (!hit) throw new Error(`找不到 id 為「${itemId}」的物件`);
  const { k } = hit;
  const existing = listProps(src, k, hit.start, hit.end).find((p) => p.key === 'attachments');
  if (!existing || src.charAt(existing.valueStart) !== '[') throw new Error(`項目「${itemId}」沒有附件`);
  const open = existing.valueStart;
  const arrEnd = matchBracket(src, k, open);
  if (arrEnd < 0) throw new Error('陣列沒有結尾的 ]');
  const re = new RegExp(`(?<![\\w$])(['"]?)file\\1\\s*:\\s*(['"])${escapeRegExp(file)}\\2`);
  const elems: { start: number; end: number; match: boolean }[] = [];
  for (let i = open + 1; i < arrEnd - 1; i++) {
    if (kindAt(k, i) !== CODE || src.charAt(i) !== '{') continue;
    const end = matchBrace(src, k, i);
    if (end < 0) break;
    const text = src.slice(i, end);
    const m = re.exec(text);
    elems.push({ start: i, end, match: !!m && kindAt(k, i + m.index) !== COMMENT && kindAt(k, i + m.index) !== STR });
    i = end - 1;
  }
  const target = elems.find((e) => e.match);
  if (!target) throw new Error(`項目「${itemId}」沒有附件「${file}」`);
  if (elems.length === 1) return editProp(src, 'id', itemId, 'attachments', null);

  const next = skipTrivia(src, k, target.end, arrEnd - 1);
  const hasComma = src.charAt(next) === ',' && kindAt(k, next) === CODE;
  const after = hasComma ? next + 1 : target.end;
  const lineStart = lineStartOf(src, target.start);
  const lineEnd = lineEndFrom(src, after);
  if (blank(src, k, lineStart, target.start) && blank(src, k, after, lineEnd)) {
    let cut = lineEnd;
    if (src.startsWith('\r\n', cut)) cut += 2;
    else if (src.charAt(cut) === '\n') cut += 1;
    // Removing the last element of a list without a trailing comma leaves the previous comma: harmless.
    return src.slice(0, lineStart) + src.slice(cut);
  }
  if (hasComma) {
    let cut = after;
    while (src.charAt(cut) === ' ' || src.charAt(cut) === '\t') cut++;
    return src.slice(0, target.start) + src.slice(cut);
  }
  let b = target.start - 1;
  while (b > open && (kindAt(k, b) === COMMENT || isWs(src.charAt(b)))) b--;
  const from = src.charAt(b) === ',' && kindAt(k, b) === CODE ? b : target.start;
  return src.slice(0, from) + src.slice(target.end);
}

// ---- v1.2: reorder and schedule ------------------------------------------------

/** One object element of an array literal, with the positions needed to cut it out or insert next to it. */
interface Elem {
  /** Index of `{`. */
  start: number;
  /** Index after the matching `}`. */
  end: number;
  hasComma: boolean;
  commaIdx: number;
  /** Start of the line holding `{`. */
  lineStart: number;
  /** Start of the first attached `// @trip-comment` line above (or lineStart). */
  blockStart: number;
  /** Line terminator at or after the element's trailing comma. */
  lineEnd: number;
  /** True when the element owns whole lines (nothing but whitespace/comments shares them). */
  own: boolean;
}

function arrayElems(src: string, k: Uint8Array, open: number): { elems: Elem[]; close: number } {
  const end = matchBracket(src, k, open);
  if (end < 0) throw new Error('陣列沒有結尾的 ]');
  const close = end - 1;
  const elems: Elem[] = [];
  let depth = 0;
  for (let i = open + 1; i < close; i++) {
    if (kindAt(k, i) !== CODE) continue;
    const c = src.charAt(i);
    if (c === '{' && depth === 0) {
      const e = matchBrace(src, k, i);
      if (e < 0) throw new Error('物件沒有結尾的 }');
      const n = skipTrivia(src, k, e, close);
      const hasComma = n < close && src.charAt(n) === ',' && kindAt(k, n) === CODE;
      const after = hasComma ? n + 1 : e;
      const lineStart = lineStartOf(src, i);
      const lineEnd = lineEndFrom(src, after);
      const own = blank(src, k, lineStart, i) && blank(src, k, after, lineEnd) && !src.slice(e, hasComma ? n : e).includes('\n');
      let blockStart = lineStart;
      while (own && blockStart > 0) {
        const pls = lineStartOf(src, blockStart - 1);
        const text = src.slice(pls, lineEndFrom(src, pls));
        const t = text.trimStart();
        if (t.startsWith('// @trip-comment') && kindAt(k, pls + text.length - t.length) === COMMENT) blockStart = pls;
        else break;
      }
      elems.push({ start: i, end: e, hasComma, commaIdx: n, lineStart, blockStart, lineEnd, own });
      i = e - 1;
    } else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
  }
  return { elems, close };
}

function unquote(s: string): string | null {
  const q = s.charAt(0);
  return (q === "'" || q === '"') && s.length >= 2 && s.endsWith(q) ? s.slice(1, -1) : null;
}

function elemId(src: string, k: Uint8Array, e: Elem): string | null {
  const p = listProps(src, k, e.start, e.end).find((x) => x.key === 'id');
  return p ? unquote(src.slice(p.valueStart, p.valueEnd)) : null;
}

/** Index of the innermost unmatched `[` before `pos`, or -1. */
function enclosingBracket(src: string, k: Uint8Array, pos: number): number {
  let depth = 0;
  for (let i = pos - 1; i >= 0; i--) {
    if (kindAt(k, i) !== CODE) continue;
    const c = src.charAt(i);
    if (c === ']') depth++;
    else if (c === '[') {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

interface DayArray {
  k: Uint8Array;
  /** Index of the `[` of the day's `items`. */
  open: number;
  /** Indentation of the `items:` key line. */
  keyIndent: string;
}

function dayItems(src: string, date: string): DayArray {
  const hit = locate(src, 'date', date);
  if (!hit) throw new Error(`找不到日期為「${date}」的那一天`);
  const items = listProps(src, hit.k, hit.start, hit.end).find((p) => p.key === 'items');
  if (!items || src.charAt(items.valueStart) !== '[') throw new Error(`「${date}」這一天沒有 items 陣列`);
  const line = lineStartOf(src, items.keyStart);
  const keyIndent = blank(src, hit.k, line, items.keyStart) ? indentOf(src, line) : `${indentOf(src, lineStartOf(src, hit.start))}  `;
  return { k: hit.k, open: items.valueStart, keyIndent };
}

interface ItemCtx {
  k: Uint8Array;
  open: number;
  idx: number;
}

/** Find the element with `id` in the array owned by `ownerKey` ('items' of a day, or root 'candidates'). */
function locateElement(src: string, id: string, ownerKey: 'items' | 'candidates'): ItemCtx {
  const label = ownerKey === 'items' ? '行程項目' : '候選地點';
  const hit = locate(src, 'id', id);
  if (!hit) throw new Error(`找不到 id 為「${id}」的${label}`);
  const { k } = hit;
  const open = enclosingBracket(src, k, hit.start);
  const owner = open < 0 ? -1 : enclosingOpen(src, k, open);
  const ownerProp = owner < 0 ? undefined : listProps(src, k, owner, matchBrace(src, k, owner)).find((p) => p.valueStart === open);
  const ok =
    ownerProp?.key === ownerKey &&
    (ownerKey === 'items' ? listProps(src, k, owner, matchBrace(src, k, owner)).some((p) => p.key === 'date') : rootObject(src, k).start === owner);
  if (!ok) {
    const other = ownerProp?.key === (ownerKey === 'items' ? 'candidates' : 'items');
    throw new Error(other ? `「${id}」是${ownerKey === 'items' ? '候選地點' : '行程項目'}，不是${label}` : `找不到 id 為「${id}」的${label}`);
  }
  const { elems } = arrayElems(src, k, open);
  const idx = elems.findIndex((e) => e.start === hit.start);
  if (idx < 0) throw new Error(`找不到 id 為「${id}」的${label}`);
  return { k, open, idx };
}

interface BlockLine {
  t: string;
  /** Inside a multi-line string/template: never re-indented. */
  str: boolean;
}
interface Block {
  /** Lines without indentation; the last one ends with `}` (no comma). */
  lines: BlockLine[];
  /** Whatever followed the comma on the last line (e.g. a trailing comment). */
  tail: string;
}

/** Split src[from, to) into lines with `oldIndent` removed (except inside multi-line strings). */
function dedent(src: string, k: Uint8Array, from: number, to: number, oldIndent: string): BlockLine[] {
  const out: BlockLine[] = [];
  let off = from;
  for (const raw of src.slice(from, to).split('\n')) {
    const lineLen = raw.length;
    const t = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const str = off > from && kindAt(k, off) === STR;
    out.push({ t: !str && t.startsWith(oldIndent) ? t.slice(oldIndent.length) : t, str });
    off += lineLen + 1;
  }
  return out;
}

function extractBlock(src: string, k: Uint8Array, e: Elem): Block {
  const tail = src.slice(e.hasComma ? e.commaIdx + 1 : e.end, e.lineEnd).trimEnd();
  return { lines: dedent(src, k, e.blockStart, e.end, indentOf(src, e.lineStart)), tail };
}

function renderBlock(b: Block, indent: string, eol: string, comma: boolean): string {
  return b.lines
    .map((l, i) => {
      const last = i === b.lines.length - 1;
      const body = l.str || l.t === '' ? l.t : indent + l.t;
      return last ? `${body}${comma ? ',' : ''}${b.tail}` : body;
    })
    .join(eol);
}

function removeElem(src: string, k: Uint8Array, open: number, idx: number): string {
  const { elems } = arrayElems(src, k, open);
  const e = elems[idx];
  if (!e) throw new Error('找不到要移除的元素');
  if (!e.own) throw new Error('這個物件和其他內容在同一行，無法自動移動；請先把它單獨放在一行');
  let cut = e.lineEnd;
  if (src.startsWith('\r\n', cut)) cut += 2;
  else if (src.charAt(cut) === '\n') cut += 1;
  let out = src.slice(0, e.blockStart) + src.slice(cut);
  const prev = elems[idx - 1];
  if (!e.hasComma && prev?.hasComma) out = out.slice(0, prev.commaIdx) + out.slice(prev.commaIdx + 1);
  if (elems.length === 1) {
    // The array is now empty: collapse whitespace-only content so `[ ]` becomes `[]`.
    const o2 = scan(out);
    const close = matchBracket(out, o2, open) - 1;
    if (close > open && out.slice(open + 1, close).trim() === '') out = out.slice(0, open + 1) + out.slice(close);
  }
  return out;
}

/** Insert `block` into the `items` of day `toDate` before item `beforeId`, or at the end. */
function insertBlock(src: string, toDate: string, block: Block, beforeId: string | null | undefined): string {
  const day = dayItems(src, toDate);
  const { elems, close } = arrayElems(src, day.k, day.open);
  const eol = eolOf(src);
  if (beforeId != null) {
    const e = elems.find((x) => elemId(src, day.k, x) === beforeId);
    if (!e) throw new Error(`「${beforeId}」不在 ${toDate} 這一天`);
    if (!e.own) throw new Error('目標位置的項目和其他內容在同一行，無法自動插入');
    const text = renderBlock(block, indentOf(src, e.lineStart), eol, true) + eol;
    return src.slice(0, e.blockStart) + text + src.slice(e.blockStart);
  }
  const last = elems[elems.length - 1];
  if (!last) {
    const inner = src.slice(day.open + 1, close);
    if (!blank(src, day.k, day.open + 1, close)) throw new Error('items 陣列含有無法解析的內容，無法自動插入');
    const text = renderBlock(block, `${day.keyIndent}  `, eol, true);
    if (inner.trim() === '') return `${src.slice(0, day.open + 1)}${eol}${text}${eol}${day.keyIndent}${src.slice(close)}`;
    return `${src.slice(0, day.open + 1)}${eol}${text}${src.slice(day.open + 1)}`;
  }
  if (!last.own) throw new Error('最後一個項目和其他內容在同一行，無法自動插入');
  const indent = indentOf(src, last.lineStart);
  if (last.hasComma) {
    return `${src.slice(0, last.lineEnd)}${eol}${renderBlock(block, indent, eol, true)}${src.slice(last.lineEnd)}`;
  }
  return `${src.slice(0, last.end)},${src.slice(last.end, last.lineEnd)}${eol}${renderBlock(block, indent, eol, false)}${src.slice(last.lineEnd)}`;
}

/**
 * Move an item to day `toDate`, before `beforeItemId` (same-day or cross-day) or to the end of that day.
 * `// @trip-comment` lines directly above the item move with it. The block is re-indented to its new spot.
 */
export function moveItem(src: string, itemId: string, toDate: string, beforeItemId?: string | null): string {
  if (beforeItemId != null && beforeItemId === itemId) throw new Error('不能把項目移到它自己前面');
  const ctx = locateElement(src, itemId, 'items');
  const target = dayItems(src, toDate);
  const { elems: targetElems } = arrayElems(src, target.k, target.open);
  if (beforeItemId != null && !targetElems.some((e) => elemId(src, target.k, e) === beforeItemId)) {
    throw new Error(`「${beforeItemId}」不在 ${toDate} 這一天`);
  }
  if (target.open === ctx.open) {
    const next = targetElems[ctx.idx + 1];
    const stays = beforeItemId != null ? !!next && elemId(src, ctx.k, next) === beforeItemId : ctx.idx === targetElems.length - 1;
    if (stays) return src;
  }
  const elem = arrayElems(src, ctx.k, ctx.open).elems[ctx.idx]!;
  if (!elem.own) throw new Error('這個項目和其他內容在同一行，無法自動移動；請先把它單獨放在一行');
  const block = extractBlock(src, ctx.k, elem);
  return insertBlock(removeElem(src, ctx.k, ctx.open, ctx.idx), toDate, block, beforeItemId);
}

const KEY_RE = /^[A-Za-z_$][\w$]*$/;

function renderValue(v: unknown): string {
  if (typeof v === 'string') return quote(v);
  if (typeof v === 'number') return numLiteral(v);
  if (typeof v === 'boolean') return String(v);
  if (v === null) return 'null';
  if (Array.isArray(v)) return `[${v.map(renderValue).join(', ')}]`;
  if (typeof v === 'object') {
    const parts = Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .map(([key, x]) => `${KEY_RE.test(key) ? key : quote(key)}: ${renderValue(x)}`);
    return parts.length ? `{ ${parts.join(', ')} }` : '{}';
  }
  throw new Error(`無法序列化的值：${String(v)}`);
}

function objectBlock(o: Record<string, unknown>): Block {
  const lines: BlockLine[] = [{ t: '{', str: false }];
  for (const [key, v] of Object.entries(o)) {
    if (v === undefined) continue;
    lines.push({ t: `  ${KEY_RE.test(key) ? key : quote(key)}: ${renderValue(v)},`, str: false });
  }
  lines.push({ t: '}', str: false });
  return { lines, tail: '' };
}

/**
 * Insert a new item into day `toDate` (before `beforeItemId`, or at the end). `item` is either an object
 * (serialized in the file's style) or the source text of one object literal. The id must be new.
 */
export function insertItem(src: string, toDate: string, item: string | Record<string, unknown>, beforeItemId?: string | null): string {
  let block: Block;
  let id: unknown;
  let kind: unknown;
  let title: unknown;
  if (typeof item === 'string') {
    const lit = item.trim();
    const k = scan(lit);
    if (!lit.startsWith('{') || matchBrace(lit, k, 0) !== lit.length) throw new Error('項目必須是單一個物件字面值');
    const props = listProps(lit, k, 0, lit.length);
    const val = (key: string) => {
      const p = props.find((x) => x.key === key);
      return p ? unquote(lit.slice(p.valueStart, p.valueEnd)) : null;
    };
    id = val('id');
    kind = val('kind');
    title = val('title');
    const lastNl = lit.lastIndexOf('\n');
    block = { lines: dedent(lit, k, 0, lit.length, lastNl < 0 ? '' : indentOf(lit, lastNl + 1)), tail: '' };
  } else {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new Error('項目必須是物件');
    ({ id, kind, title } = item);
    block = objectBlock(item);
  }
  if (typeof id !== 'string' || !/^[a-z0-9-]+$/.test(id)) throw new Error(`無效的項目 id：${String(id)}`);
  if (typeof kind !== 'string' || kind === '') throw new Error('項目需要 kind');
  if (typeof title !== 'string' || title.trim() === '') throw new Error('項目需要標題');
  if (findObjectById(src, id)) throw new Error(`id「${id}」已存在`);
  return insertBlock(src, toDate, block, beforeItemId);
}

/**
 * Turn a candidate into a `poi` item in day `toDate` (before `beforeItemId`, or at the end): the candidate
 * leaves `candidates`; title / placeId / loc are copied verbatim, `why` becomes `note`.
 */
export function scheduleCandidate(src: string, candidateId: string, toDate: string, beforeItemId?: string | null): string {
  const ctx = locateElement(src, candidateId, 'candidates');
  const target = dayItems(src, toDate);
  const { elems: targetElems } = arrayElems(src, target.k, target.open);
  if (beforeItemId != null && !targetElems.some((e) => elemId(src, target.k, e) === beforeItemId)) {
    throw new Error(`「${beforeItemId}」不在 ${toDate} 這一天`);
  }
  const elem = arrayElems(src, ctx.k, ctx.open).elems[ctx.idx]!;
  if (!elem.own) throw new Error('這個候選地點和其他內容在同一行，無法自動移動；請先把它單獨放在一行');
  const props = listProps(src, ctx.k, elem.start, elem.end);
  const verbatim = (key: string): string | null => {
    const p = props.find((x) => x.key === key);
    return p ? src.slice(p.valueStart, p.valueEnd) : null;
  };
  const title = verbatim('title');
  if (title === null) throw new Error(`候選地點「${candidateId}」沒有標題`);
  const oldIndent = indentOf(src, elem.lineStart);
  const lines: BlockLine[] = elem.blockStart < elem.lineStart ? dedent(src, ctx.k, elem.blockStart, elem.lineStart - 1, oldIndent) : [];
  const body = ['{', `  id: ${quote(candidateId)},`, "  kind: 'poi',", `  title: ${title},`];
  for (const [key, out] of [['placeId', 'placeId'], ['loc', 'loc'], ['why', 'note']] as const) {
    const v = verbatim(key);
    if (v !== null) body.push(`  ${out}: ${v},`);
  }
  body.push('}');
  for (const t of body) lines.push({ t, str: false });
  return insertBlock(removeElem(src, ctx.k, ctx.open, ctx.idx), toDate, { lines, tail: '' }, beforeItemId);
}

// ---- v1.3: remove and lock -----------------------------------------------------

/**
 * Delete the item with `itemId` from its day, together with the `// @trip-comment` lines directly above it.
 * The comma style of the array is kept: removing a last element without a trailing comma also drops the
 * comma of the one before it, and removing the only element leaves `items: []`.
 */
export function removeItem(src: string, itemId: string): string {
  const ctx = locateElement(src, itemId, 'items');
  return removeElem(src, ctx.k, ctx.open, ctx.idx);
}

/**
 * Set (`true`) or clear (`false`) the `locked` flag of an item. A missing flag is inserted after `id:`;
 * `false` removes the property entirely so the file stays clean. No other field is touched.
 */
export function setLocked(src: string, itemId: string, locked: boolean): string {
  if (typeof locked !== 'boolean') throw new Error('locked 必須是布林值');
  locateElement(src, itemId, 'items');
  return editProp(src, 'id', itemId, 'locked', locked ? 'true' : null);
}

// ---- v1.6: booking status ------------------------------------------------------

export type BookingPatchValue = string | boolean | null;
const BOOKING_KEYS = ['need', 'status', 'bookedAt', 'boughtVia'] as const;
export type BookingPatch = Partial<Record<(typeof BOOKING_KEYS)[number], BookingPatchValue>>;

function literalOf(v: string | boolean): string {
  return typeof v === 'boolean' ? String(v) : quote(v);
}

/** Set (value) or remove (null) one first-level property inside the object-valued property `objProp` of an item. */
function setNested(src: string, itemId: string, objProp: string, key: string, value: string | boolean | null): string {
  const hit = locate(src, 'id', itemId);
  if (!hit) throw new Error(`找不到 id 為「${itemId}」的物件`);
  const outer = listProps(src, hit.k, hit.start, hit.end).find((p) => p.key === objProp);
  if (!outer || src.charAt(outer.valueStart) !== '{') throw new Error(`項目「${itemId}」的 ${objProp} 不是物件字面值，無法自動修改`);
  const end = matchBrace(src, hit.k, outer.valueStart);
  if (end < 0) throw new Error(`${objProp} 沒有結尾的 }`);
  const props = listProps(src, hit.k, outer.valueStart, end);
  const existing = props.find((p) => p.key === key);
  if (existing) {
    if (value === null) return removeProp(src, hit.k, outer.valueStart, existing);
    return src.slice(0, existing.valueStart) + literalOf(value) + src.slice(existing.valueEnd);
  }
  if (value === null) return src;
  const entry = `${key}: ${literalOf(value)}`;
  const last = props[props.length - 1];
  if (!last) return src.slice(0, outer.valueStart) + `{ ${entry} }` + src.slice(end);
  const after = last.hasComma ? last.termIdx + 1 : last.valueEnd;
  const lineEnd = lineEndFrom(src, after);
  if (!blank(src, hit.k, after, lineEnd)) {
    // Everything on one line.
    return last.hasComma ? `${src.slice(0, after)} ${entry},${src.slice(after)}` : `${src.slice(0, last.valueEnd)}, ${entry}${src.slice(last.valueEnd)}`;
  }
  const eol = eolOf(src);
  const lastLine = lineStartOf(src, last.keyStart);
  const indent = blank(src, hit.k, lastLine, last.keyStart) ? indentOf(src, lastLine) : indentOf(src, lineStartOf(src, outer.keyStart)) + '  ';
  if (last.hasComma) return `${src.slice(0, lineEnd)}${eol}${indent}${entry},${src.slice(lineEnd)}`;
  return `${src.slice(0, last.valueEnd)},${src.slice(last.valueEnd, lineEnd)}${eol}${indent}${entry}${src.slice(lineEnd)}`;
}

/**
 * Change an item's `booking` status fields (need, status, bookedAt, boughtVia; `null` removes one). When the item
 * has no `booking` yet it is created from the given values, so `need` and `status` must be among them. Nothing
 * else in the file is touched: links and dates written by hand or by the booking-checklist skill stay as they are.
 */
export function setBooking(src: string, itemId: string, patch: BookingPatch): string {
  for (const key of Object.keys(patch)) if (!(BOOKING_KEYS as readonly string[]).includes(key)) throw new Error(`不允許修改 booking.${key}`);
  const hit = locate(src, 'id', itemId);
  if (!hit) throw new Error(`找不到 id 為「${itemId}」的物件`);
  const has = listProps(src, hit.k, hit.start, hit.end).some((p) => p.key === 'booking');
  if (!has) {
    if (typeof patch.need !== 'string' || typeof patch.status !== 'string') throw new Error('建立 booking 需要 need 與 status');
    const parts = BOOKING_KEYS.flatMap((key) => {
      const v = patch[key];
      return v === undefined || v === null ? [] : [`${key}: ${literalOf(v)}`];
    });
    return editProp(src, 'id', itemId, 'booking', `{ ${parts.join(', ')} }`);
  }
  let out = src;
  for (const key of BOOKING_KEYS) {
    const v = patch[key];
    if (v !== undefined) out = setNested(out, itemId, 'booking', key, v);
  }
  return out;
}

/** Set an item's `loc`, stamped with `fetchedAt` (Google allows caching coordinates for 30 days). */
export function setItemLoc(src: string, itemId: string, loc: { lat: number; lng: number }, fetchedAt: string): string {
  if (!Number.isFinite(loc.lat) || !Number.isFinite(loc.lng) || Math.abs(loc.lat) > 90 || Math.abs(loc.lng) > 180) throw new Error('座標無效');
  if (!locate(src, 'id', itemId)) throw new Error(`找不到 id 為「${itemId}」的物件`);
  return editProp(src, 'id', itemId, 'loc', `{ lat: ${loc.lat}, lng: ${loc.lng}, fetchedAt: ${quote(fetchedAt)} }`);
}

/** Set the day's `color` (1–8, a slot of the viewer's day palette); null removes it so the day goes back to its automatic color. */
export function setDayColor(src: string, date: string, color: number | null): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('date 必須是 YYYY-MM-DD');
  if (color !== null && !(Number.isInteger(color) && color >= 1 && color <= 8)) throw new Error('color 必須是 1 到 8 的整數，或 null');
  if (!locate(src, 'date', date)) throw new Error(`找不到日期為「${date}」的那一天`);
  return editProp(src, 'date', date, 'color', color === null ? null : String(color));
}

/** Set the day's `accepted` list (readiness codes the user accepts for that day); an empty list removes the property. */
export function setDayAccepted(src: string, date: string, codes: string[]): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('date 必須是 YYYY-MM-DD');
  if (!locate(src, 'date', date)) throw new Error(`找不到日期為「${date}」的那一天`);
  const clean = [...new Set(codes)].filter((c) => /^[a-z][a-z-]{1,40}$/.test(c));
  return editProp(src, 'date', date, 'accepted', clean.length === 0 ? null : `[${clean.map(quote).join(', ')}]`);
}


// ---- meals: choosing a place ----------------------------------------------------------------------

/** A JS object/array/string/number/boolean written the way trip files are written (single quotes, bare keys). */
function jsLiteral(v: unknown): string {
  if (typeof v === 'string') return quote(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.map(jsLiteral).join(', ')}]`;
  if (v && typeof v === 'object') {
    const parts = Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .map(([k, x]) => `${/^[A-Za-z_]\w*$/.test(k) ? k : quote(k)}: ${jsLiteral(x)}`);
    return `{ ${parts.join(', ')} }`;
  }
  throw new Error('不能寫進行程檔的值');
}

export interface MealPlacePatch {
  title: string;
  loc?: { lat: number; lng: number; fetchedAt: string };
  placeId?: string;
  slot?: 'breakfast' | 'lunch' | 'dinner' | 'snack';
  dishes?: string[];
  checks?: Record<string, unknown>;
}

/** Put a chosen place into an existing meal item (a placeholder like 「午餐：待選」): title, coordinates, place id, slot, dishes and the checks. */
export function setMealPlace(src: string, itemId: string, patch: MealPlacePatch): string {
  if (!locate(src, 'id', itemId)) throw new Error(`找不到 id 為「${itemId}」的物件`);
  if (typeof patch.title !== 'string' || patch.title.trim() === '') throw new Error('店名不可為空');
  let out = editProp(src, 'id', itemId, 'title', quote(patch.title));
  if (patch.loc) {
    if (!Number.isFinite(patch.loc.lat) || !Number.isFinite(patch.loc.lng) || Math.abs(patch.loc.lat) > 90 || Math.abs(patch.loc.lng) > 180) throw new Error('座標無效');
    out = editProp(out, 'id', itemId, 'loc', jsLiteral({ lat: patch.loc.lat, lng: patch.loc.lng, fetchedAt: patch.loc.fetchedAt }));
  }
  if (patch.placeId !== undefined) out = editProp(out, 'id', itemId, 'placeId', quote(patch.placeId));
  if (patch.slot !== undefined) out = editProp(out, 'id', itemId, 'slot', quote(patch.slot));
  if (patch.dishes !== undefined) out = editProp(out, 'id', itemId, 'dishes', jsLiteral(patch.dishes));
  if (patch.checks !== undefined) out = editProp(out, 'id', itemId, 'checks', jsLiteral(patch.checks));
  return out;
}
