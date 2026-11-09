// Client state for the agent panel. The server (src/agent/) owns the sessions; this module mirrors
// them: one fetch for the current session, then every change arrives as a server-sent event.
// Kept as a module singleton so the conversation survives closing and reopening the panel.
import { useSyncExternalStore } from 'react';
import type {
  AgentEffort,
  AgentItem,
  AgentSession,
  AgentSessionSummary,
  AgentStatus,
  AgentStreamEvent,
  AgentTurnContext,
  RespondPayload,
} from '../../agent/types.ts';
import { isAgentEffort } from '../../agent/types.ts';

export interface AgentSettings {
  model: string;
  effort: AgentEffort | '';
  autoApprove: boolean;
}

export interface AgentState {
  status: AgentStatus | null;
  /** The status request itself failed (dev server down, not the dev server at all). */
  statusFailed: boolean;
  connected: boolean;
  sessions: AgentSessionSummary[];
  active: AgentSession | null;
  installing: boolean;
  installError: string | null;
  /** A failed action (send, stop, …); cleared by the next one. */
  actionError: string | null;
  settings: AgentSettings;
}

const SETTINGS_KEY = 'tripcode.agent.settings';
// Each trip remembers its own open conversation, like a project does in Claude Code.
const activeKey = (tripId: string | null) => `tripcode.agent.session.${tripId ?? '-'}`;

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* private mode / blocked storage: the panel just forgets its choices on reload */
  }
}

export function readSettings(raw: string | null): AgentSettings {
  const fallback: AgentSettings = { model: '', effort: '', autoApprove: false };
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as Partial<AgentSettings>;
    return {
      model: typeof parsed.model === 'string' && /^[\w.:[\]-]{0,80}$/.test(parsed.model) ? parsed.model : '',
      effort: isAgentEffort(parsed.effort) ? parsed.effort : '',
      autoApprove: parsed.autoApprove === true,
    };
  } catch {
    return fallback;
  }
}

let state: AgentState = {
  status: null,
  statusFailed: false,
  connected: false,
  sessions: [],
  active: null,
  installing: false,
  installError: null,
  actionError: null,
  settings: readSettings(readLocal(SETTINGS_KEY)),
};
const listeners = new Set<() => void>();

function set(patch: Partial<AgentState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useAgent(): AgentState {
  return useSyncExternalStore(subscribe, () => state);
}

export function getAgentState(): AgentState {
  return state;
}

// ---------- applying server events (pure, exported for tests) ----------

function sortSessions(list: AgentSessionSummary[]): AgentSessionSummary[] {
  return [...list].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

export function applyEvent(prev: Pick<AgentState, 'sessions' | 'active'>, event: AgentStreamEvent): Pick<AgentState, 'sessions' | 'active'> {
  const { sessions, active } = prev;
  switch (event.type) {
    case 'session': {
      const next = sortSessions([...sessions.filter((s) => s.id !== event.session.id), event.session]);
      return { sessions: next, active: active?.id === event.session.id ? { ...active, ...event.session } : active };
    }
    case 'session-removed':
      return { sessions: sessions.filter((s) => s.id !== event.sessionId), active: active?.id === event.sessionId ? null : active };
    case 'item': {
      if (active?.id !== event.sessionId) return prev;
      const index = active.items.findIndex((i) => i.id === event.item.id);
      const items: AgentItem[] = index === -1 ? [...active.items, event.item] : active.items.map((i, n) => (n === index ? event.item : i));
      return { sessions, active: { ...active, items } };
    }
    case 'delta': {
      if (active?.id !== event.sessionId) return prev;
      const items = active.items.map((i) => (i.id === event.itemId && i.kind === 'assistant' ? { ...i, text: i.text + event.text } : i));
      return { sessions, active: { ...active, items } };
    }
    case 'truncate': {
      if (active?.id !== event.sessionId) return prev;
      const index = active.items.findIndex((i) => i.id === event.itemId);
      return index === -1 ? prev : { sessions, active: { ...active, items: active.items.slice(0, index) } };
    }
  }
}

/**
 * Which conversation belongs on screen for a trip: the one it had open last if that still exists, else its most
 * recent one (the list is newest-first), else none, so the first message starts a fresh conversation for this trip.
 */
export function pickSessionFor(sessions: AgentSessionSummary[], tripId: string | null, remembered: string | null): string | null {
  const mine = sessions.filter((s) => s.tripId === tripId);
  return mine.find((s) => s.id === remembered)?.id ?? mine[0]?.id ?? null;
}

// ---------- transport ----------

async function request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? 'GET';
  const res = await fetch(`/__agent${path}`, {
    method,
    ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body ?? {}) } : {}),
  });
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data as T;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

let stream: EventSource | null = null;
let startPromise: Promise<void> | null = null;
/** The trip whose conversation the panel is showing; a conversation of another trip is never written to. */
let focusedTrip: string | null | undefined;
let focusToken = 0;

function openStream(): void {
  if (stream) return;
  stream = new EventSource('/__agent/events');
  stream.onopen = () => {
    set({ connected: true });
    // Events missed while disconnected (server restart, sleeping laptop) are gone: resync.
    void loadSessions();
    if (state.active) void refreshSession(state.active.id);
  };
  stream.onerror = () => set({ connected: false });
  stream.onmessage = (e) => {
    try {
      set(applyEvent(state, JSON.parse(e.data as string) as AgentStreamEvent));
    } catch {
      /* a malformed frame is skipped */
    }
  };
}

async function loadSessions(): Promise<void> {
  try {
    const { sessions } = await request<{ sessions: AgentSessionSummary[] }>('/sessions');
    set({ sessions });
  } catch {
    /* the status call already reports an unreachable server */
  }
}

/** Idempotent: call when the panel first opens. Everyone who calls it waits for the same start. */
export function startAgent(): Promise<void> {
  if (!startPromise) {
    startPromise = (async () => {
      await refreshStatus();
      if (!state.status?.enabled) {
        startPromise = null; // not the dev server (or no access): the next open tries again
        return;
      }
      openStream();
      await loadSessions();
    })();
  }
  return startPromise;
}

/** Shows the conversation that belongs to this trip (see pickSessionFor). Safe to call again for the same trip. */
export async function focusTrip(tripId: string | null): Promise<void> {
  await startAgent();
  if (focusedTrip === tripId) return;
  focusedTrip = tripId;
  const token = ++focusToken;
  const id = pickSessionFor(state.sessions, tripId, readLocal(activeKey(tripId)));
  if (!id) return set({ active: null, actionError: null });
  const session = await fetchSession(id);
  if (token !== focusToken) return; // the user moved on to another trip while this was loading
  set({ active: session });
}

export async function refreshStatus(): Promise<void> {
  try {
    set({ status: await request<AgentStatus>('/status'), statusFailed: false });
  } catch {
    set({ statusFailed: true });
  }
}

export async function installSdk(): Promise<boolean> {
  if (state.installing) return false;
  set({ installing: true, installError: null });
  try {
    await request<{ ok: true; version: string }>('/install', { method: 'POST' });
    await refreshStatus();
    set({ installing: false });
    return true;
  } catch (e) {
    set({ installing: false, installError: message(e) });
    return false;
  }
}

async function fetchSession(id: string): Promise<AgentSession | null> {
  try {
    return await request<AgentSession>(`/sessions/${id}`);
  } catch (e) {
    // Deleted elsewhere (or the store was reset): the caller drops its stale pointer.
    set({ actionError: message(e) });
    return null;
  }
}

/** After a reconnect: reload the open conversation, keeping what is on screen if the server no longer has it. */
async function refreshSession(id: string): Promise<void> {
  const session = await fetchSession(id);
  if (session && state.active?.id === id) set({ active: session, actionError: null });
}

/** Opens a conversation from the history list; it becomes the one this trip comes back to. */
export async function openSession(id: string): Promise<void> {
  const session = await fetchSession(id);
  if (!session) {
    set({ active: state.active?.id === id ? null : state.active });
    return;
  }
  writeLocal(activeKey(session.tripId), id);
  focusedTrip = session.tripId;
  focusToken++;
  set({ active: session, actionError: null });
}

export async function newSession(tripId: string | null): Promise<AgentSession | null> {
  try {
    const session = await request<AgentSession>('/sessions', { method: 'POST', body: { tripId } });
    writeLocal(activeKey(tripId), session.id);
    set({ active: session, actionError: null });
    return session;
  } catch (e) {
    set({ actionError: message(e) });
    return null;
  }
}

export async function removeSession(id: string): Promise<void> {
  try {
    await request(`/sessions/${id}`, { method: 'DELETE' });
    const gone = state.sessions.find((s) => s.id === id);
    if (gone && readLocal(activeKey(gone.tripId)) === id) writeLocal(activeKey(gone.tripId), null);
  } catch (e) {
    set({ actionError: message(e) });
  }
}

/** 「新對話」: the panel goes blank for this trip; the next message starts a fresh conversation. */
export function closeSession(): void {
  if (state.active) writeLocal(activeKey(state.active.tripId), null);
  set({ active: null, actionError: null });
}

export function updateSettings(patch: Partial<AgentSettings>): void {
  const settings = { ...state.settings, ...patch };
  writeLocal(SETTINGS_KEY, JSON.stringify(settings));
  set({ settings });
}

/** Uploads one (already scaled) picture and returns its repo-relative path; throws a readable message on refusal. */
export async function uploadImage(base64: string, tripId: string | null): Promise<string> {
  const { ref } = await request<{ ref: string }>('/uploads', { method: 'POST', body: { tripId, data: base64 } });
  return ref;
}

/**
 * Sends a message, creating a session first when none is open. `edit` is the user message id being rewritten;
 * `images` are the paths uploadImage returned (a message may be pictures only).
 */
export async function sendMessage(text: string, context: AgentTurnContext, edit?: string, images: string[] = []): Promise<boolean> {
  const trimmed = text.trim();
  if (!trimmed && images.length === 0) return false;
  // The message must never land in another trip's conversation, even when it is sent before the panel has shown.
  await focusTrip(context.tripId ?? null);
  let session = state.active;
  if (!session) session = await newSession(context.tripId ?? null);
  if (!session) return false;
  const { model, effort, autoApprove } = state.settings;
  set({ actionError: null });
  try {
    await request(`/sessions/${session.id}/messages`, {
      method: 'POST',
      body: {
        text: trimmed,
        context,
        autoApprove,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        ...(edit ? { edit } : {}),
        ...(images.length > 0 ? { images } : {}),
      },
    });
    return true;
  } catch (e) {
    set({ actionError: message(e) });
    return false;
  }
}

export async function stopSession(): Promise<void> {
  if (!state.active) return;
  try {
    await request(`/sessions/${state.active.id}/stop`, { method: 'POST' });
  } catch (e) {
    set({ actionError: message(e) });
  }
}

export async function respond(itemId: string, payload: RespondPayload): Promise<void> {
  if (!state.active) return;
  try {
    await request(`/sessions/${state.active.id}/respond`, { method: 'POST', body: { itemId, ...payload } });
  } catch (e) {
    set({ actionError: message(e) });
  }
}
