// Claude Code as the agent behind the panel, driven through @anthropic-ai/claude-agent-sdk.
// The SDK is imported from the workspace at run time (see detect.ts), so TripCode compiles and
// runs without it; the panel's connect view installs it on request.
import { findSpawnableCli, importWorkspacePackage } from './detect.ts';
import { forbiddenForAgent } from './guard.ts';
import { clipDetail, isInsideRoots, parseQuestions, ProviderUnavailableError, relativeToCwd } from './provider.ts';
import type { AgentProvider, ProviderEvent } from './provider.ts';
import { AGENT_EFFORTS } from './types.ts';
import type { AgentEffort, AgentModelOption } from './types.ts';

export const CLAUDE_SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';

const CLAUDE_MODELS: AgentModelOption[] = [
  { id: 'opus', label: 'Opus', efforts: [...AGENT_EFFORTS] },
  { id: 'sonnet', label: 'Sonnet', efforts: [...AGENT_EFFORTS] },
  { id: 'haiku', label: 'Haiku', efforts: [] },
];

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

// The SDK's message union is large and moves with every release; the mapper only reads a few
// fields, so it takes loose records instead of tracking those types.
type Msg = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export function describeClaudeTool(name: string, input: Record<string, unknown>, cwd: string): { title: string; detail: string | null } {
  const file = relativeToCwd(cwd, input.file_path ?? input.path ?? input.notebook_path);
  switch (name) {
    case 'Read':
      return { title: '讀取', detail: file };
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return { title: name === 'Write' ? '寫入' : '編輯', detail: file };
    case 'Bash':
      return { title: '執行指令', detail: clipDetail(input.command) };
    case 'Glob':
    case 'Grep':
      return { title: '搜尋', detail: clipDetail(input.pattern) };
    case 'WebFetch':
      return { title: '擷取網頁', detail: clipDetail(input.url) };
    case 'WebSearch':
      return { title: '網路搜尋', detail: clipDetail(input.query) };
    case 'Skill':
      return { title: '技能', detail: clipDetail(input.skill ?? input.name) };
    case 'Task':
      return { title: '子任務', detail: clipDetail(input.description) };
    case 'AskUserQuestion':
      return { title: '提問', detail: null };
    case 'TodoWrite':
      return { title: '計畫', detail: null };
    default:
      return { title: name, detail: clipDetail(input) };
  }
}

/** Turns the SDK's message stream into the provider-neutral events the runner understands. */
export function createClaudeMapper(emit: (event: ProviderEvent) => void, cwd: string) {
  let counter = 0;
  const nextId = () => `t-${Date.now().toString(36)}-${(counter++).toString(36)}`;
  const textByIndex = new Map<number, string>();
  const openTextIds: string[] = [];
  let resultSeen = false;

  const handleBlocks = (blocks: Msg[]) => {
    for (const block of blocks) {
      if (block.type === 'text') {
        const text = String(block.text ?? '');
        const id = openTextIds.shift();
        if (id) {
          emit({ type: 'text-end', id, text });
        } else if (text.trim()) {
          // A text block that never streamed (e.g. replayed history): show it whole.
          const fresh = nextId();
          emit({ type: 'text-start', id: fresh });
          emit({ type: 'text-end', id: fresh, text });
        }
      } else if (block.type === 'tool_use') {
        const { title, detail } = describeClaudeTool(String(block.name), (block.input ?? {}) as Record<string, unknown>, cwd);
        emit({ type: 'tool-start', id: String(block.id), name: String(block.name), title, detail });
      }
    }
    textByIndex.clear();
    openTextIds.length = 0;
  };

  return {
    get resultSeen() {
      return resultSeen;
    },
    handle(msg: Msg) {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'system' && msg.subtype === 'init') {
        emit({ type: 'session-id', id: msg.session_id });
        return;
      }
      if (msg.type === 'stream_event') {
        if (msg.parent_tool_use_id) return; // a subagent's stream, not the main conversation
        const ev = msg.event;
        if (ev.type === 'content_block_start') {
          if (ev.content_block.type === 'text') {
            const id = nextId();
            textByIndex.set(ev.index, id);
            openTextIds.push(id);
            emit({ type: 'text-start', id });
          }
        } else if (ev.type === 'content_block_delta') {
          const id = textByIndex.get(ev.index);
          if (id && ev.delta.type === 'text_delta' && ev.delta.text) emit({ type: 'text-delta', id, text: ev.delta.text });
        }
        return;
      }
      if (msg.type === 'assistant') {
        if (msg.parent_tool_use_id) return;
        handleBlocks(msg.message?.content ?? []);
        if (msg.uuid) emit({ type: 'checkpoint', id: msg.uuid });
        return;
      }
      if (msg.type === 'user') {
        if (msg.parent_tool_use_id) return;
        if (msg.uuid) emit({ type: 'checkpoint', id: msg.uuid });
        const content = msg.message?.content;
        if (!Array.isArray(content)) return;
        for (const block of content) {
          if (block.type === 'tool_result') emit({ type: 'tool-end', id: block.tool_use_id, ok: !block.is_error });
        }
        return;
      }
      if (msg.type === 'result') {
        resultSeen = true;
        if (msg.session_id) emit({ type: 'session-id', id: msg.session_id });
        if (msg.is_error || (msg.subtype && msg.subtype !== 'success')) {
          emit({
            type: 'error',
            text:
              (Array.isArray(msg.errors) && msg.errors.length ? msg.errors.join('\n') : null) ??
              (typeof msg.result === 'string' && msg.result ? msg.result : null) ??
              `Claude Code 已停止：${msg.subtype ?? 'error'}`,
          });
        }
        emit({
          type: 'result',
          durationMs: typeof msg.duration_ms === 'number' ? msg.duration_ms : null,
          costUsd: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : null,
        });
      }
    },
  };
}

function claudeEffort(effort: AgentEffort | null): AgentEffort | undefined {
  return effort ?? undefined;
}

export function createClaudeProvider(): AgentProvider {
  const provider: AgentProvider = {
    name: 'Claude Code',
    sdkPackage: CLAUDE_SDK_PACKAGE,
    cliCommand: 'claude',
    askInstruction: '要問使用者問題時，一律使用 AskUserQuestion 工具，不要用純文字問。',
    canRewind: true,
    models: () => CLAUDE_MODELS,
    async run(opts) {
      const sdk = await importWorkspacePackage(opts.cwd, CLAUDE_SDK_PACKAGE);
      if (!sdk || typeof sdk.query !== 'function') throw new ProviderUnavailableError(provider);
      const mapper = createClaudeMapper(opts.emit, opts.cwd);
      if (opts.signal.aborted) return;
      const abortController = new AbortController();
      opts.signal.addEventListener('abort', () => abortController.abort(), { once: true });

      // Edits inside trips/ and destinations/ are the whole point of the panel, so they go through
      // without a prompt; everything else (shell, web, edits elsewhere) asks the user first.
      const canUseTool = async (toolName: string, input: Record<string, unknown>) => {
        if (toolName === 'AskUserQuestion') {
          const answers = await opts.askUser(parseQuestions(input));
          if (!answers) return { behavior: 'deny', message: '使用者略過了這個問題。' };
          return { behavior: 'allow', updatedInput: { ...input, answers } };
        }
        const forbidden = forbiddenForAgent(toolName, input);
        if (forbidden) return { behavior: 'deny', message: forbidden };
        const target = input.file_path ?? input.notebook_path;
        if (EDIT_TOOLS.has(toolName) && isInsideRoots(opts.cwd, target, opts.writableRoots)) {
          return { behavior: 'allow', updatedInput: input };
        }
        const { title, detail } = describeClaudeTool(toolName, input, opts.cwd);
        const allowed = await opts.requestPermission({ tool: toolName, title, detail });
        return allowed
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: '使用者在 TripCode agent 面板拒絕了這個動作。' };
      };

      // Prefer the user's own `claude` (already logged in) over the binary the SDK may bundle.
      const localCli = findSpawnableCli('claude');
      const effort = claudeEffort(opts.effort);
      let stderr = '';
      const stream = (sdk.query as (args: { prompt: string; options: Record<string, unknown> }) => AsyncIterable<Msg>)({
        prompt: opts.prompt,
        options: {
          cwd: opts.cwd,
          permissionMode: 'default',
          // Loads CLAUDE.md and .claude/skills/ from the project, so the TripCode skills apply as-is.
          settingSources: ['user', 'project', 'local'],
          systemPrompt: { type: 'preset', preset: 'claude_code', append: opts.systemPromptAppend },
          includePartialMessages: true,
          abortController,
          canUseTool,
          ...(opts.resume ? { resume: opts.resume } : {}),
          ...(opts.resume && opts.resumeAt ? { resumeSessionAt: opts.resumeAt } : {}),
          ...(opts.model ? { model: opts.model } : {}),
          ...(effort ? { effort } : {}),
          ...(localCli ? { pathToClaudeCodeExecutable: localCli } : {}),
          stderr: (data: string) => {
            stderr = (stderr + data).slice(-2000);
          },
        },
      });
      try {
        for await (const message of stream) mapper.handle(message);
      } catch (err) {
        // An abort or a stream that already ended with a result is not a failure.
        if (opts.signal.aborted || mapper.resultSeen) return;
        const base = err instanceof Error ? err.message : String(err);
        const tail = stderr.trim();
        throw new Error(tail && !base.includes(tail) ? `${base}\n${tail}` : base);
      }
    },
  };
  return provider;
}
