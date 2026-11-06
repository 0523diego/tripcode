import { useEffect, useMemo, useState } from 'react';
import type { Trip } from '../../core/types.ts';
import { commentState, snippet, type CommentState, type SentComment } from '../comment-log.ts';
import { dateLabel, findItem } from '../model.ts';

// Raw trip sources, loaded on demand only (the list is the one place that needs to see the markers).
const rawTrips = import.meta.glob<string>('/trips/*/*.ts', { query: '?raw', import: 'default' });

async function readSource(tripId: string, file: string): Promise<string | null> {
  const load = rawTrips[`/trips/${tripId}/${file}`];
  if (!load) return null;
  try {
    return await load();
  } catch {
    return null;
  }
}

/** Human title for what a comment is about, for the list. */
export function targetTitle(trip: Trip, targetId: string, anchor: string): string {
  if (anchor === 'day') return `${dateLabel(targetId)} 整天`;
  const hit = findItem(trip, targetId);
  if (hit) return anchor === 'gap' ? `「${hit.item.title}」之前的空檔` : hit.item.title;
  return trip.candidates.find((c) => c.id === targetId)?.title ?? targetId;
}

/** Which of this session's comments are still sitting in the trip file. `null` until loaded. */
export function useCommentStates(tripId: string, comments: SentComment[]): CommentState[] {
  const [sources, setSources] = useState<Record<string, string | null>>({});
  const files = useMemo(() => [...new Set(comments.map((c) => c.file))].join('\n'), [comments]);
  useEffect(() => {
    if (!files) return;
    let live = true;
    void Promise.all(
      files.split('\n').map(async (f) => [f, await readSource(tripId, f)] as const),
    ).then((rows) => {
      if (live) setSources(Object.fromEntries(rows));
    });
    return () => {
      live = false;
    };
  }, [tripId, files]);
  return useMemo(() => comments.map((c) => commentState(c, sources)), [comments, sources]);
}

const STATE_LABEL: Record<CommentState, string> = {
  waiting: '等 Claude 處理',
  'maybe-applied': '可能已套用',
  unknown: '等 Claude 處理',
};

function timeText(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function CommentLog({ comments, states }: { comments: SentComment[]; states: CommentState[] }) {
  return (
    <ol className="comment-log" aria-label="本次已送出的留言">
      {comments
        .map((c, i) => ({ c, s: states[i] ?? 'unknown' }))
        .reverse()
        .map(({ c, s }) => (
          <li key={`${c.at}-${c.text}`} className={`cl-row ${s}`}>
            <span className="cl-meta">
              {timeText(c.at)} · {c.target}
            </span>
            <span className="cl-text">{snippet(c.text, 60)}</span>
            <span className={`cl-state ${s}`}>{STATE_LABEL[s]}</span>
          </li>
        ))}
      <li className="cl-note">「可能已套用」表示檔案裡找不到這則留言了；實際結果請以行程為準。</li>
    </ol>
  );
}
