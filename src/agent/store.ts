// In-memory agent sessions, persisted to node_modules/.tripcode/agent-sessions.json so a conversation
// survives a dev-server restart. Every change is also emitted as a stream event: the SSE route in
// routes.ts relays them, so the panel is just a view of this store.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sessionSummary } from './types.ts';
import type { AgentItem, AgentItemKind, AgentSession, AgentSessionSummary, AgentStreamEvent } from './types.ts';

const MAX_SESSIONS = 30;
const MAX_ITEMS_PER_SESSION = 400;
const SAVE_DEBOUNCE_MS = 150;
const TITLE_MAX = 60;

export function newId(prefix: string): string {
  return `${prefix}-${randomBytes(6).toString('hex')}`;
}

export function titleFromPrompt(text: string): string {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return '未命名對話';
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
}

/** An item that was in flight when the server stopped can never finish, so settle it on load. */
export function closePending(item: AgentItem): AgentItem {
  if (item.kind === 'assistant' && item.streaming) return { ...item, streaming: false };
  if (item.kind === 'tool' && item.status === 'running') return { ...item, status: 'error' };
  if (item.kind === 'question' && item.status === 'pending') return { ...item, status: 'cancelled' };
  if (item.kind === 'permission' && item.status === 'pending') return { ...item, status: 'denied' };
  return item;
}

function readPersisted(file: string): AgentSession[] {
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { version?: number; sessions?: AgentSession[] };
    if (parsed.version !== 1 || !Array.isArray(parsed.sessions)) return [];
    return parsed.sessions.map((s) => ({ ...s, status: 'idle' as const, items: s.items.map(closePending) }));
  } catch {
    return [];
  }
}

export interface SessionStore {
  list(): AgentSessionSummary[];
  get(id: string): AgentSession | null;
  create(tripId: string | null): AgentSession;
  remove(id: string): boolean;
  patch(id: string, changes: Partial<Omit<AgentSession, 'id' | 'items'>>): AgentSession;
  appendItem(sessionId: string, item: AgentItem): AgentItem;
  updateItem(sessionId: string, itemId: string, kind: AgentItemKind, changes: Record<string, unknown>): AgentItem | null;
  truncateFrom(sessionId: string, itemId: string): boolean;
  appendDelta(sessionId: string, itemId: string, text: string): void;
  subscribe(listener: (event: AgentStreamEvent) => void): () => void;
  flush(): Promise<void>;
}

/** `file` is optional so tests can run without touching the disk. */
export function createSessionStore(opts: { file?: string } = {}): SessionStore {
  const sessions = new Map<string, AgentSession>();
  const order = new Map<string, number>();
  const listeners = new Set<(event: AgentStreamEvent) => void>();
  let saveTimer: NodeJS.Timeout | null = null;
  let seq = 0;

  if (opts.file) {
    for (const s of readPersisted(opts.file)) {
      sessions.set(s.id, s);
      order.set(s.id, seq++);
    }
  }

  const emit = (event: AgentStreamEvent) => {
    for (const l of listeners) l(event);
  };

  const writeSnapshot = async (file: string) => {
    const body = { version: 1, sessions: list().flatMap((s) => sessions.get(s.id) ?? []) };
    const tmp = `${file}.tmp`;
    try {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(tmp, JSON.stringify(body), { encoding: 'utf8', mode: 0o600 });
      await rename(tmp, file);
    } catch (err) {
      console.error('[tripcode] 無法儲存 agent 對話：', err);
      await rm(tmp, { force: true }).catch(() => {});
    }
  };

  let saving: Promise<void> = Promise.resolve();
  const save = () => {
    const file = opts.file;
    if (!file) return saving;
    saving = saving.then(() => writeSnapshot(file));
    return saving;
  };
  const scheduleSave = () => {
    if (!opts.file) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void save();
    }, SAVE_DEBOUNCE_MS);
  };

  const touch = (session: AgentSession) => {
    session.updatedAt = new Date().toISOString();
    order.set(session.id, seq++);
    emit({ type: 'session', session: sessionSummary(session) });
    scheduleSave();
  };

  const need = (id: string): AgentSession => {
    const session = sessions.get(id);
    if (!session) throw new Error(`未知的 agent 對話：${id}`);
    return session;
  };

  function list(): AgentSessionSummary[] {
    return Array.from(sessions.values())
      .sort((a, b) => {
        if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
        return (order.get(b.id) ?? 0) - (order.get(a.id) ?? 0);
      })
      .map(sessionSummary);
  }

  return {
    list,
    get: (id) => sessions.get(id) ?? null,
    create(tripId) {
      const now = new Date().toISOString();
      const session: AgentSession = {
        id: newId('s'),
        title: '新對話',
        createdAt: now,
        updatedAt: now,
        status: 'idle',
        tripId,
        providerSessionId: null,
        providerCheckpoint: null,
        trimmed: false,
        items: [],
      };
      sessions.set(session.id, session);
      order.set(session.id, seq++);
      // Only idle conversations are dropped, so a running turn never loses its session.
      for (const stale of list().filter((s) => s.status === 'idle').slice(MAX_SESSIONS)) {
        sessions.delete(stale.id);
        order.delete(stale.id);
        emit({ type: 'session-removed', sessionId: stale.id });
      }
      touch(session);
      return session;
    },
    remove(id) {
      if (!sessions.delete(id)) return false;
      order.delete(id);
      emit({ type: 'session-removed', sessionId: id });
      scheduleSave();
      return true;
    },
    patch(id, changes) {
      const session = need(id);
      Object.assign(session, changes);
      touch(session);
      return session;
    },
    appendItem(sessionId, item) {
      const session = need(sessionId);
      session.items.push(item);
      if (session.items.length > MAX_ITEMS_PER_SESSION) {
        session.items.splice(0, session.items.length - MAX_ITEMS_PER_SESSION);
        session.trimmed = true;
      }
      emit({ type: 'item', sessionId, item });
      touch(session);
      return item;
    },
    updateItem(sessionId, itemId, kind, changes) {
      const session = need(sessionId);
      const index = session.items.findIndex((i) => i.id === itemId && i.kind === kind);
      if (index === -1) return null;
      const next = { ...session.items[index], ...changes } as AgentItem;
      session.items[index] = next;
      emit({ type: 'item', sessionId, item: next });
      touch(session);
      return next;
    },
    truncateFrom(sessionId, itemId) {
      const session = need(sessionId);
      const index = session.items.findIndex((i) => i.id === itemId);
      if (index === -1) return false;
      session.items.splice(index);
      emit({ type: 'truncate', sessionId, itemId });
      touch(session);
      return true;
    },
    appendDelta(sessionId, itemId, text) {
      if (!text) return;
      const item = need(sessionId).items.find((i) => i.id === itemId);
      if (item?.kind !== 'assistant') return;
      item.text += text;
      emit({ type: 'delta', sessionId, itemId, text });
      scheduleSave();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async flush() {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      await save();
    },
  };
}
