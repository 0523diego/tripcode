// Client for the dev-server endpoints in vite-plugin-tripcode.ts (all POST JSON).

import type { HistoryInfo } from '../core/history.ts';

export interface ApiResult {
  ok: boolean;
  error?: string;
  /** Present on edits, undo, redo and `history`: what the Undo / Redo buttons can do for this file now. */
  history?: HistoryInfo;
  /** undo / redo only: what was undone, and the item it touched. */
  label?: string;
  itemId?: string;
}

export async function post(endpoint: string, body: Record<string, unknown>): Promise<ApiResult> {
  try {
    const res = await fetch(`/__tripcode/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => null)) as ApiResult | null;
    if (data && typeof data.ok === 'boolean') return data;
    return res.ok ? { ok: true } : { ok: false, error: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Sends a write request; `tripId`/`file` are filled in by the caller (see App.tsx). */
export type Send = (
  endpoint: string,
  body: Record<string, unknown>,
  okMessage: string,
) => Promise<boolean>;

export const GOOGLE_MAPS_KEY: string | undefined =
  (import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined) || undefined;
