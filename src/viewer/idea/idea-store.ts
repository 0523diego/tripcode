// Client side of step 0: reads trips/<id>/idea.json through the dev server and keeps it fresh.
//
// The file is NOT imported through a Vite glob (that would reload the page on every answer, restarting the globe and
// flickering the AI panel). Instead the dev server watches trips/*/idea.json and sends a `tripcode:idea` HMR event;
// we refetch. Our own writes use the response directly.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Idea, IdeaStep } from '../../core/idea.ts';
import { post } from '../api.ts';
import type { ApiResult } from '../api.ts';

interface IdeaResult extends ApiResult {
  idea?: Idea;
  next?: IdeaStep;
  ideas?: IdeaListEntry[];
}

export interface IdeaListEntry {
  id: string;
  updatedAt: string;
  next: IdeaStep;
  summary: string[];
}

export const IDEA_EVENT = 'tripcode:idea';

/** Calls `fn(tripId)` for every idea.json change the dev server reports. Returns the unsubscribe function. */
function onIdeaChanged(fn: (tripId: string) => void): () => void {
  const hot = import.meta.hot;
  if (!hot) return () => {};
  const cb = (data: { tripId?: string }) => {
    if (typeof data?.tripId === 'string') fn(data.tripId);
  };
  hot.on(IDEA_EVENT, cb);
  return () => hot.off?.(IDEA_EVENT, cb);
}

export type IdeaStatus = 'loading' | 'ready' | 'missing' | 'error';

export interface IdeaHandle {
  idea: Idea | null;
  status: IdeaStatus;
  error: string | null;
  /** True while one of our own requests is in flight. */
  busy: boolean;
  /** Sends an `idea` op; the answer replaces the state. Returns whether it worked (the message is in `error`). */
  run: (body: Record<string, unknown>) => Promise<boolean>;
  /** Stop reading the file (the folder is about to move away when the trip is created). */
  freeze: (frozen: boolean) => void;
}

export function useIdea(id: string): IdeaHandle {
  const [idea, setIdea] = useState<Idea | null>(null);
  const [status, setStatus] = useState<IdeaStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const latest = useRef<Idea | null>(null);
  const frozen = useRef(false);
  const freeze = useCallback((v: boolean) => {
    frozen.current = v;
  }, []);

  // Responses can cross (our POST vs. a watcher refetch): never go back to an older file.
  const accept = useCallback((next: Idea) => {
    const cur = latest.current;
    if (cur && cur.updatedAt > next.updatedAt) return;
    latest.current = next;
    setIdea(next);
    setStatus('ready');
  }, []);

  const refetch = useCallback(async () => {
    if (frozen.current) return;
    const r = (await post('idea', { tripId: id, op: 'get' })) as IdeaResult;
    if (r.ok && r.idea) {
      setError(null);
      accept(r.idea);
    } else if (r.error?.includes('找不到')) {
      // The folder is gone: never created, or the idea just became a trip (idea.json moved to trips/<newId>/).
      setStatus('missing');
    } else if (!latest.current) {
      setStatus('error');
      setError(r.error ?? '讀取失敗');
    }
  }, [id, accept]);

  useEffect(() => {
    latest.current = null;
    setIdea(null);
    setStatus('loading');
    void refetch();
    const off = onIdeaChanged((tripId) => {
      if (tripId === id) void refetch();
    });
    // Backup for a missed event (sleeping laptop, dropped websocket).
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refetch();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      off();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [id, refetch]);

  const run = useCallback(
    async (body: Record<string, unknown>) => {
      setBusy(true);
      setError(null);
      const r = (await post('idea', { tripId: id, ...body })) as IdeaResult;
      setBusy(false);
      if (r.ok && r.idea) {
        accept(r.idea);
        return true;
      }
      setError(r.error ?? '失敗了，請再試一次');
      return false;
    },
    [id, accept],
  );

  return { idea, status, error, busy, run, freeze };
}

/** Unfinished ideas for the home page, refreshed when any idea.json changes. */
export function useIdeaList(): IdeaListEntry[] {
  const [list, setList] = useState<IdeaListEntry[]>([]);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const r = (await post('idea-list', {})) as IdeaResult;
      if (alive && r.ok && r.ideas) setList(r.ideas);
    };
    void load();
    const off = onIdeaChanged(() => void load());
    return () => {
      alive = false;
      off();
    };
  }, []);
  return list;
}

/** Creates trips/<id>/idea.json. */
export async function createIdeaFile(id: string): Promise<ApiResult> {
  return post('idea-new', { tripId: id });
}

/** Creates the trip from a finished idea. */
export async function finishIdeaFile(id: string, body: Record<string, unknown>): Promise<ApiResult & { tripId?: string }> {
  return (await post('idea-finish', { tripId: id, ...body })) as ApiResult & { tripId?: string };
}
