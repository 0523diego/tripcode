// Polls the dev server's /__buy/state so the office page stays live. Pauses while the tab is hidden.
import { useCallback, useEffect, useState } from 'react';
import type { OfficeState } from '../../purchase/office.ts';

export interface OfficeApi {
  state: OfficeState | null;
  error: string | null;
  /** Wall-clock ms, refreshed every few seconds so "3 分鐘前" and "working" ageing keep moving. */
  nowMs: number;
  refresh: () => Promise<void>;
  act: (endpoint: string, body: Record<string, unknown>) => Promise<{ ok: boolean; error?: string; [k: string]: unknown }>;
}

export function useOffice(tripId: string, pollMs = 3000): OfficeApi {
  const [state, setState] = useState<OfficeState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNow] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/__buy/state?trip=${encodeURIComponent(tripId)}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setState((await res.json()) as OfficeState);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setNow(Date.now());
  }, [tripId]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => {
      if (!document.hidden) void refresh();
    }, pollMs);
    const onVisible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh, pollMs]);

  const act = useCallback(
    async (endpoint: string, body: Record<string, unknown>) => {
      try {
        const res = await fetch(`/__buy/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const json = (await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))) as { ok: boolean; error?: string };
        await refresh();
        return json;
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    [refresh],
  );

  return { state, error, nowMs, refresh, act };
}
