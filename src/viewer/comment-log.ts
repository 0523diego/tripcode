// Comments sent from this browser session. Kept in sessionStorage only (no backend): a comment is
// written into trip.ts as `// @trip-comment(...)`, so the list answers "what did I leave, did Claude
// get to it?" by checking whether that marker is still in the file.

export interface SentComment {
  /** Epoch ms. */
  at: number;
  /** Trip file the marker was written to, e.g. "trip.ts". */
  file: string;
  /** Human title of what the comment is about (item / day / gap). */
  target: string;
  /** What the user wrote (one line, as the endpoint stores it). */
  text: string;
}

const KEY = 'tripcode.viewer.comments';
const MAX = 50;

export function loadComments(tripId: string): SentComment[] {
  try {
    const v = JSON.parse(sessionStorage.getItem(`${KEY}.${tripId}`) ?? '[]') as unknown;
    return Array.isArray(v) ? (v as SentComment[]).filter((c) => c && typeof c.text === 'string') : [];
  } catch {
    return [];
  }
}

export function appendComment(tripId: string, c: SentComment): SentComment[] {
  const next = [...loadComments(tripId), c].slice(-MAX);
  try {
    sessionStorage.setItem(`${KEY}.${tripId}`, JSON.stringify(next));
  } catch {
    /* storage unavailable: the list just won't survive a reload */
  }
  return next;
}

export function clearComments(tripId: string): void {
  try {
    sessionStorage.removeItem(`${KEY}.${tripId}`);
  } catch {
    /* ignore */
  }
}

/** The comment text as the endpoint writes it: whitespace collapsed to single spaces. */
export function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** A short preview for the list. */
export function snippet(text: string, max = 28): string {
  const t = normalizeText(text);
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** Does `src` still contain a `// @trip-comment(...)` line with this exact text? */
export function markerPresent(src: string, text: string): boolean {
  const want = normalizeText(text);
  for (const line of src.split(/\r?\n/)) {
    const m = /^\s*\/\/ @trip-comment\([a-z]+\):\s*(.*?)\s*$/.exec(line);
    if (m && m[1] === want) return true;
  }
  return false;
}

export type CommentState = 'waiting' | 'maybe-applied' | 'unknown';

/**
 * `sources` maps file name → current raw source (null when it could not be read). A comment whose
 * marker is gone was most likely applied (or deleted by hand) — we say "maybe", never "done".
 */
export function commentState(c: SentComment, sources: Record<string, string | null>): CommentState {
  const src = sources[c.file];
  if (src === undefined || src === null) return 'unknown';
  return markerPresent(src, c.text) ? 'waiting' : 'maybe-applied';
}
