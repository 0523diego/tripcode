// Shared by the dev-server agent (src/agent/*) and the viewer's agent panel. Pure types plus two
// tiny helpers, so the viewer can import it without pulling in any Node code.
// The shape follows open-slide's in-app agent panel: a session is an ordered list of items
// (messages, tool calls, questions, permission requests) that the server streams to the browser.

export const AGENT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type AgentEffort = (typeof AGENT_EFFORTS)[number];

export function isAgentEffort(value: unknown): value is AgentEffort {
  return typeof value === 'string' && (AGENT_EFFORTS as readonly string[]).includes(value);
}

export interface AgentModelOption {
  /** Empty for "whatever Claude Code defaults to". */
  id: string;
  label: string;
  efforts: AgentEffort[];
}

export interface AgentStatus {
  /** False when the request did not come from this machine; the panel then stays hidden. */
  enabled: boolean;
  /** The Claude Agent SDK is an opt-in install (see CLAUDE.md), so the panel starts on a connect view. */
  sdkInstalled: boolean;
  sdkVersion: string | null;
  sdkPackage: string;
  cliFound: boolean;
  cliVersion: string | null;
  models: AgentModelOption[];
}

export interface AgentQuestionOption {
  label: string;
  description?: string;
}

export interface AgentQuestion {
  header: string;
  question: string;
  options: AgentQuestionOption[];
  multiSelect: boolean;
}

export type AgentItem =
  | {
      kind: 'user';
      id: string;
      ts: string;
      text: string;
      /** Repo-relative paths of pictures the user attached (see attachments.ts); the agent views them with Read. */
      images?: string[];
      /** The provider history point just before this message, so editing it rewinds the conversation there. */
      resumeAt?: string;
    }
  | { kind: 'assistant'; id: string; ts: string; text: string; streaming: boolean }
  | {
      kind: 'tool';
      id: string;
      ts: string;
      name: string;
      title: string;
      detail: string | null;
      status: 'running' | 'done' | 'error';
    }
  | {
      kind: 'question';
      id: string;
      ts: string;
      questions: AgentQuestion[];
      answers: Record<string, string> | null;
      status: 'pending' | 'answered' | 'cancelled';
    }
  | {
      kind: 'permission';
      id: string;
      ts: string;
      tool: string;
      title: string;
      detail: string | null;
      status: 'pending' | 'allowed' | 'denied';
    }
  | { kind: 'error'; id: string; ts: string; text: string }
  | { kind: 'result'; id: string; ts: string; durationMs: number | null; costUsd: number | null; aborted: boolean };

export type AgentItemKind = AgentItem['kind'];

export interface AgentSessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: 'idle' | 'running';
  tripId: string | null;
}

export interface AgentSession extends AgentSessionSummary {
  providerSessionId: string | null;
  providerCheckpoint: string | null;
  /** Set once the oldest items were dropped to stay under the item cap. */
  trimmed: boolean;
  items: AgentItem[];
}

/** What the viewer is showing, sent with every turn (the same cursor the current-trip skill reads). */
export interface AgentTurnContext {
  tripId?: string;
  file?: string;
  /** 1-based day number, like current.json. */
  day?: number;
  itemId?: string;
  tripTitle?: string;
  /** The viewer is on the step-0 page (#/idea/<id>): tripId names a folder that so far only has idea.json. */
  idea?: boolean;
}

export type RespondPayload = { answers: Record<string, string> } | { allow: boolean } | { cancel: true };

export type AgentStreamEvent =
  | { type: 'session'; session: AgentSessionSummary }
  | { type: 'session-removed'; sessionId: string }
  | { type: 'item'; sessionId: string; item: AgentItem }
  | { type: 'delta'; sessionId: string; itemId: string; text: string }
  | { type: 'truncate'; sessionId: string; itemId: string };

export function sessionSummary(session: AgentSession): AgentSessionSummary {
  const { providerSessionId: _p, providerCheckpoint: _c, trimmed: _t, items: _i, ...summary } = session;
  return summary;
}
