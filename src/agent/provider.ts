// The seam between the agent runner and a concrete coding agent. Only Claude Code exists today
// (claude.ts); the runner talks to this interface so a second provider would not touch it.
import path from 'node:path';
import type { AgentEffort, AgentModelOption, AgentQuestion } from './types.ts';

export type ProviderEvent =
  | { type: 'session-id'; id: string }
  /** A point in the provider's own history that a later edit can rewind to. */
  | { type: 'checkpoint'; id: string }
  | { type: 'text-start'; id: string }
  | { type: 'text-delta'; id: string; text: string }
  | { type: 'text-end'; id: string; text: string | null }
  | { type: 'tool-start'; id: string; name: string; title: string; detail: string | null }
  | { type: 'tool-end'; id: string; ok: boolean }
  | { type: 'error'; text: string }
  | { type: 'result'; durationMs: number | null; costUsd: number | null };

export interface PermissionRequest {
  tool: string;
  title: string;
  detail: string | null;
}

export interface ProviderRunOptions {
  cwd: string;
  /** Directories the agent may write without asking (trips/, destinations/). Anything else needs approval. */
  writableRoots: string[];
  prompt: string;
  systemPromptAppend: string;
  resume: string | null;
  resumeAt: string | null;
  model: string | null;
  effort: AgentEffort | null;
  signal: AbortSignal;
  emit: (event: ProviderEvent) => void;
  askUser: (questions: AgentQuestion[]) => Promise<Record<string, string> | null>;
  requestPermission: (request: PermissionRequest) => Promise<boolean>;
}

export interface AgentProvider {
  name: string;
  sdkPackage: string;
  cliCommand: string;
  /** Appended to the system prompt: how this provider should ask the user a question. */
  askInstruction: string;
  canRewind: boolean;
  models(): AgentModelOption[];
  run(opts: ProviderRunOptions): Promise<void>;
}

export class ProviderUnavailableError extends Error {
  constructor(provider: AgentProvider) {
    super(`尚未連接 ${provider.name}：請先在 agent 面板安裝 ${provider.sdkPackage}。`);
    this.name = 'ProviderUnavailableError';
  }
}

const DETAIL_MAX = 400;

export function clipDetail(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = typeof value === 'string' ? value : safeJson(value);
  if (!text) return null;
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > DETAIL_MAX ? `${oneLine.slice(0, DETAIL_MAX - 1)}…` : oneLine;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** True when `file` resolves to one of `roots` or a path under it; `..` tricks and absolute escapes are not. */
export function isInsideRoots(cwd: string, file: unknown, roots: string[]): boolean {
  if (typeof file !== 'string' || !file) return false;
  const resolved = path.resolve(cwd, file);
  return roots.some((root) => {
    const rel = path.relative(root, resolved);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
}

export function relativeToCwd(cwd: string, file: unknown): string | null {
  if (typeof file !== 'string' || !file) return null;
  const normalizedCwd = cwd.replace(/[\\/]+$/, '');
  if (file.startsWith(normalizedCwd)) {
    const rest = file.slice(normalizedCwd.length).replace(/^[\\/]+/, '');
    return rest || '.';
  }
  return file;
}

/** Normalises the AskUserQuestion tool input, dropping anything malformed. */
export function parseQuestions(input: Record<string, unknown>): AgentQuestion[] {
  const raw = Array.isArray(input.questions) ? input.questions : [];
  const questions: AgentQuestion[] = [];
  for (const q of raw) {
    if (!q || typeof q !== 'object') continue;
    const r = q as Record<string, unknown>;
    if (typeof r.question !== 'string') continue;
    const options: AgentQuestion['options'] = [];
    if (Array.isArray(r.options)) {
      for (const o of r.options) {
        if (!o || typeof o !== 'object') continue;
        const opt = o as Record<string, unknown>;
        if (typeof opt.label !== 'string') continue;
        options.push({ label: opt.label, ...(typeof opt.description === 'string' ? { description: opt.description } : {}) });
      }
    }
    questions.push({
      header: typeof r.header === 'string' ? r.header : '',
      question: r.question,
      options,
      multiSelect: r.multiSelect === true,
    });
  }
  return questions;
}
