// Runs one agent turn at a time per session: feeds the provider's events into the store, parks
// questions and permission requests until the panel answers them, and handles stop / edit-and-resend.
import { systemPromptAppend, buildTurnPrompt, editedPrompt, rewoundPrompt } from './prompt.ts';
import type { AgentProvider, PermissionRequest, ProviderEvent } from './provider.ts';
import { newId, titleFromPrompt } from './store.ts';
import type { SessionStore } from './store.ts';
import type { AgentEffort, AgentQuestion, AgentTurnContext, RespondPayload } from './types.ts';

export interface SendOptions {
  text: string;
  context?: AgentTurnContext | undefined;
  /** Allow every non-edit tool call without asking (the panel's "自動允許" switch). */
  autoApprove?: boolean | undefined;
  model?: string | null | undefined;
  effort?: AgentEffort | null | undefined;
  /** Id of an earlier user message being edited: the conversation is cut back to it first. */
  edit?: string | undefined;
  /** Repo-relative paths of uploaded pictures (already validated by the route). */
  images?: readonly string[] | undefined;
}

type Pending =
  | { kind: 'question'; resolve: (answers: Record<string, string> | null) => void }
  | { kind: 'permission'; resolve: (allow: boolean) => void };

export interface AgentRunner {
  send(sessionId: string, options: SendOptions): Promise<void>;
  stop(sessionId: string): boolean;
  respond(sessionId: string, itemId: string, payload: RespondPayload): boolean;
  isRunning(sessionId: string): boolean;
  stopAll(): void;
}

function cancelPrompt(prompt: Pending): void {
  if (prompt.kind === 'question') prompt.resolve(null);
  else prompt.resolve(false);
}

export function createAgentRunner(opts: {
  userCwd: string;
  writableRoots: string[];
  store: SessionStore;
  provider: AgentProvider;
}): AgentRunner {
  const { userCwd, writableRoots, store, provider } = opts;
  const running = new Map<string, AbortController>();
  const pending = new Map<string, Pending>();
  const now = () => new Date().toISOString();

  async function send(sessionId: string, options: SendOptions): Promise<void> {
    const session = store.get(sessionId);
    if (!session) throw new Error(`未知的 agent 對話：${sessionId}`);
    if (running.has(sessionId)) throw new Error('這個對話正在執行');
    let images = options.images ? [...options.images] : [];
    let text = options.text.trim();
    // A picture alone is a fine message.
    if (!text && images.length > 0) text = '（請看附上的圖片）';
    if (!text) throw new Error('訊息是空的');

    let promptText = text;
    let resumeAt: string | null = null;
    if (options.edit) {
      const index = session.items.findIndex((i) => i.id === options.edit);
      const target = session.items[index];
      if (target?.kind !== 'user') throw new Error('找不到那則訊息');
      // Rewriting a message keeps the pictures that were on it unless the edit brings its own.
      if (!options.images && target.images) images = [...target.images];
      if (!session.trimmed && !session.items.slice(0, index).some((i) => i.kind === 'user')) {
        // Editing the very first message: start the provider conversation over.
        store.patch(sessionId, { providerSessionId: null, providerCheckpoint: null });
      } else if (provider.canRewind && target.resumeAt) {
        resumeAt = target.resumeAt;
        store.patch(sessionId, { providerCheckpoint: resumeAt });
        promptText = rewoundPrompt(text);
      } else {
        promptText = editedPrompt(target.text, text);
      }
      store.truncateFrom(sessionId, target.id);
    }

    const controller = new AbortController();
    running.set(sessionId, controller);
    if (session.items.length === 0) store.patch(sessionId, { title: titleFromPrompt(text) });
    if (options.context?.tripId && !session.tripId) store.patch(sessionId, { tripId: options.context.tripId });
    // A question nobody answered before the next message is moot.
    for (const item of session.items) {
      if (item.kind === 'question' && item.status === 'pending') store.updateItem(sessionId, item.id, 'question', { status: 'cancelled' });
    }

    store.appendItem(sessionId, {
      kind: 'user',
      id: newId('u'),
      ts: now(),
      text,
      ...(images.length > 0 ? { images } : {}),
      ...(session.providerCheckpoint ? { resumeAt: session.providerCheckpoint } : {}),
    });
    store.patch(sessionId, { status: 'running' });

    const openText = new Set<string>();
    const openTools = new Set<string>();
    const startedAt = Date.now();
    let resultSeen = false;

    const emit = (event: ProviderEvent): void => {
      if (!store.get(sessionId)) return;
      switch (event.type) {
        case 'session-id':
          store.patch(sessionId, { providerSessionId: event.id });
          return;
        case 'checkpoint':
          store.patch(sessionId, { providerCheckpoint: event.id });
          return;
        case 'text-start':
          openText.add(event.id);
          store.appendItem(sessionId, { kind: 'assistant', id: event.id, ts: now(), text: '', streaming: true });
          return;
        case 'text-delta':
          if (!openText.has(event.id)) emit({ type: 'text-start', id: event.id });
          store.appendDelta(sessionId, event.id, event.text);
          return;
        case 'text-end': {
          if (!openText.has(event.id)) {
            if (!event.text) return;
            emit({ type: 'text-start', id: event.id });
          }
          openText.delete(event.id);
          store.updateItem(sessionId, event.id, 'assistant', event.text !== null ? { streaming: false, text: event.text } : { streaming: false });
          return;
        }
        case 'tool-start':
          openTools.add(event.id);
          store.appendItem(sessionId, { kind: 'tool', id: event.id, ts: now(), name: event.name, title: event.title, detail: event.detail, status: 'running' });
          return;
        case 'tool-end':
          openTools.delete(event.id);
          store.updateItem(sessionId, event.id, 'tool', { status: event.ok ? 'done' : 'error' });
          return;
        case 'error':
          store.appendItem(sessionId, { kind: 'error', id: newId('e'), ts: now(), text: event.text });
          return;
        case 'result':
          resultSeen = true;
          store.appendItem(sessionId, {
            kind: 'result',
            id: newId('r'),
            ts: now(),
            durationMs: event.durationMs ?? Date.now() - startedAt,
            costUsd: event.costUsd,
            aborted: false,
          });
          return;
      }
    };

    const askUser = (questions: AgentQuestion[]) =>
      new Promise<Record<string, string> | null>((resolve) => {
        if (controller.signal.aborted) return resolve(null);
        const item = store.appendItem(sessionId, { kind: 'question', id: newId('q'), ts: now(), questions, answers: null, status: 'pending' });
        pending.set(item.id, {
          kind: 'question',
          resolve: (answers) => {
            pending.delete(item.id);
            store.updateItem(sessionId, item.id, 'question', { answers, status: answers ? 'answered' : 'cancelled' });
            resolve(answers);
          },
        });
      });

    const requestPermission = (request: PermissionRequest) =>
      new Promise<boolean>((resolve) => {
        if (controller.signal.aborted) return resolve(false);
        const item = store.appendItem(sessionId, {
          kind: 'permission',
          id: newId('p'),
          ts: now(),
          tool: request.tool,
          title: request.title,
          detail: request.detail,
          status: options.autoApprove ? 'allowed' : 'pending',
        });
        if (options.autoApprove) return resolve(true);
        pending.set(item.id, {
          kind: 'permission',
          resolve: (allow) => {
            pending.delete(item.id);
            store.updateItem(sessionId, item.id, 'permission', { status: allow ? 'allowed' : 'denied' });
            resolve(allow);
          },
        });
      });

    const finish = () => {
      running.delete(sessionId);
      if (!store.get(sessionId)) return;
      for (const id of openText) store.updateItem(sessionId, id, 'assistant', { streaming: false });
      for (const id of openTools) store.updateItem(sessionId, id, 'tool', { status: 'error' });
      if (!resultSeen) {
        store.appendItem(sessionId, { kind: 'result', id: newId('r'), ts: now(), durationMs: Date.now() - startedAt, costUsd: null, aborted: controller.signal.aborted });
      }
      store.patch(sessionId, { status: 'idle' });
    };

    provider
      .run({
        cwd: userCwd,
        writableRoots,
        prompt: buildTurnPrompt(promptText, options.context, images),
        systemPromptAppend: systemPromptAppend(provider.askInstruction),
        resume: session.providerSessionId,
        resumeAt,
        model: options.model ?? null,
        effort: options.effort ?? null,
        signal: controller.signal,
        emit,
        askUser,
        requestPermission,
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        emit({ type: 'error', text: err instanceof Error ? err.message : String(err) });
      })
      .finally(finish);
  }

  function stop(sessionId: string): boolean {
    const controller = running.get(sessionId);
    if (!controller) return false;
    const session = store.get(sessionId);
    if (session) {
      for (const item of session.items) {
        const prompt = pending.get(item.id);
        if (prompt) cancelPrompt(prompt);
      }
    }
    controller.abort();
    return true;
  }

  function respond(sessionId: string, itemId: string, payload: RespondPayload): boolean {
    if (!store.get(sessionId)?.items.some((i) => i.id === itemId)) return false;
    const prompt = pending.get(itemId);
    if (!prompt) return false;
    if ('cancel' in payload) {
      cancelPrompt(prompt);
      return true;
    }
    if (prompt.kind === 'question' && 'answers' in payload) {
      prompt.resolve(payload.answers);
      return true;
    }
    if (prompt.kind === 'permission' && 'allow' in payload) {
      prompt.resolve(payload.allow);
      return true;
    }
    return false;
  }

  return {
    send,
    stop,
    respond,
    isRunning: (sessionId) => running.has(sessionId),
    stopAll() {
      for (const id of Array.from(running.keys())) stop(id);
    },
  };
}
