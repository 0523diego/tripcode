// The in-viewer agent panel: chat with Claude Code about the trip on screen. Everything it shows is
// the server's session (see agent-store.ts); the agent edits trips/<id>/ and the viewer reloads itself.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AgentItem, AgentQuestion, AgentSessionSummary, AgentTurnContext } from '../../agent/types.ts';
import { AGENT_EFFORTS } from '../../agent/types.ts';
import {
  closeSession,
  focusTrip,
  installSdk,
  newSession,
  openSession,
  refreshStatus,
  removeSession,
  respond,
  sendMessage,
  stopSession,
  updateSettings,
  useAgent,
} from './agent-store.ts';
import type { AgentState } from './agent-store.ts';
import { fileUrl } from './files.ts';
import { Markdown } from './markdown.tsx';
import { PanelResizer } from './PanelResizer.tsx';
import { MAX_ATTACHMENTS, useAttachments } from './useAttachments.ts';
import type { Attachments } from './useAttachments.ts';

export interface AgentPanelProps {
  context: AgentTurnContext;
  /** Human-readable "what the agent will treat as 這個", shown above the composer. */
  contextLabel: string;
  onClose: () => void;
}

export function AgentPanel({ context, contextLabel, onClose }: AgentPanelProps) {
  const agent = useAgent();
  const [history, setHistory] = useState(false);
  // Each trip has its own conversations: the panel follows the trip it is opened for.
  const tripId = context.tripId ?? null;
  useEffect(() => {
    void focusTrip(tripId);
  }, [tripId]);
  const mine = useMemo(() => agent.sessions.filter((s) => s.tripId === tripId), [agent.sessions, tripId]);

  const { status, active } = agent;
  const ready = status?.enabled && status.sdkInstalled;
  const running = active?.status === 'running';

  // Pictures can be dropped anywhere on the panel, pasted into the box, or picked with the paperclip.
  const attachments = useAttachments(tripId);
  const [dragging, setDragging] = useState(false);
  const canAttach = Boolean(ready) && !history;
  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes('Files');

  return (
    <section
      className={`agent card${dragging ? ' dragging' : ''}`}
      aria-label="AI 助手"
      onDragOver={(e) => {
        if (!canAttach || !hasFiles(e)) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e) => {
        setDragging(false);
        if (!canAttach || !hasFiles(e)) return;
        e.preventDefault();
        attachments.add(Array.from(e.dataTransfer.files));
      }}
    >
      <PanelResizer />
      <header className="ag-head">
        <div className="ag-title">
          <h2>AI 助手</h2>
          {ready && <span className="ag-sub">{active ? active.title : '新對話'}</span>}
        </div>
        <div className="ag-head-actions">
          {ready && (
            <>
              <button type="button" className="ag-icon" onClick={() => setHistory((h) => !h)} aria-pressed={history} aria-label="對話紀錄" title="對話紀錄">
                ☰
              </button>
              <button
                type="button"
                className="ag-icon"
                onClick={() => {
                  closeSession();
                  setHistory(false);
                }}
                disabled={!active || running}
                aria-label="新對話"
                title="新對話"
              >
                ＋
              </button>
            </>
          )}
          <button type="button" className="ag-icon" onClick={onClose} aria-label="關閉 AI 助手" title="關閉">
            ×
          </button>
        </div>
      </header>

      {!status && !agent.statusFailed && <p className="ag-note">連線中…</p>}
      {agent.statusFailed && <p className="ag-note err">無法連到開發伺服器的 agent 服務。請確認是用 <code>npm run dev</code> 開的。</p>}
      {status && !status.enabled && <p className="ag-note">AI 助手只能從這台電腦的開發伺服器使用。</p>}
      {status?.enabled && !status.sdkInstalled && <ConnectView agent={agent} />}
      {ready && history && (
        <HistoryView
          sessions={mine}
          activeId={active?.id ?? null}
          onOpen={(id) => {
            setHistory(false);
            void openSession(id);
          }}
        />
      )}
      {ready && !history && (
        <>
          <Transcript agent={agent} context={context} />
          <Composer agent={agent} context={context} contextLabel={contextLabel} attachments={attachments} />
        </>
      )}
    </section>
  );
}

// ---------- connect ----------

function ConnectView({ agent }: { agent: AgentState }) {
  const { status, installing, installError } = agent;
  if (!status) return null;
  return (
    <div className="ag-connect">
      <h3>連接 Claude Code</h3>
      <p>
        AI 助手用你電腦上的 Claude Code 來改行程，需要這個專案裝一個 SDK（<code>{status.sdkPackage}</code>）。它不是預設依賴，按下按鈕才會安裝。
      </p>
      <ul className="ag-checks">
        <li className={status.cliFound ? 'ok' : 'warn'}>{status.cliFound ? `找到 Claude Code ${status.cliVersion ?? ''}` : '找不到 claude 指令（SDK 會用它內建的版本，但你需要先登入過 Claude Code）'}</li>
        <li>安裝會挑發布超過 7 天的最新版本，精確鎖版，並寫入 <code>package.json</code> 與 <code>package-lock.json</code>。</li>
      </ul>
      {installError && <pre className="ag-install-error">{installError}</pre>}
      <div className="ag-connect-actions">
        <button type="button" className="btn primary" onClick={() => void installSdk()} disabled={installing}>
          {installing ? '安裝中…（可能要一兩分鐘）' : '安裝並連接'}
        </button>
        <button type="button" className="btn" onClick={() => void refreshStatus()} disabled={installing}>
          我已自己裝好，重新偵測
        </button>
      </div>
    </div>
  );
}

// ---------- history ----------

function HistoryView({ sessions, activeId, onOpen }: { sessions: AgentSessionSummary[]; activeId: string | null; onOpen: (id: string) => void }) {
  if (sessions.length === 0) return <p className="ag-note">還沒有對話。</p>;
  return (
    <ul className="ag-history">
      {sessions.map((s) => (
        <li key={s.id} className={s.id === activeId ? 'on' : undefined}>
          <button type="button" className="ag-hist-open" onClick={() => onOpen(s.id)}>
            <span className="ag-hist-title">{s.title}</span>
            <span className="ag-hist-meta">
              {s.tripId ? `${s.tripId} · ` : ''}
              {formatWhen(s.updatedAt)}
              {s.status === 'running' ? ' · 執行中' : ''}
            </span>
          </button>
          <button type="button" className="ag-icon" onClick={() => void removeSession(s.id)} aria-label={`刪除「${s.title}」`} title="刪除">
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}

export function formatWhen(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === now.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

// ---------- transcript ----------

function Transcript({ agent, context }: { agent: AgentState; context: AgentTurnContext }) {
  const { active } = agent;
  const box = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const items = active?.items ?? [];

  // Follow the stream while the user is at the bottom; leave them alone once they scroll up to read.
  useLayoutEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  const running = active?.status === 'running';
  const lastKind = items.at(-1)?.kind;

  return (
    <div
      className="ag-transcript"
      ref={box}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      {items.length === 0 && <Empty idea={context.idea} />}
      {active?.trimmed && <p className="ag-note">（較早的訊息已省略）</p>}
      {items.map((item) => (
        <ItemView key={item.id} item={item} idle={!running} context={context} />
      ))}
      {running && lastKind !== 'assistant' && lastKind !== 'question' && lastKind !== 'permission' && (
        <p className="ag-working" role="status">
          Claude 正在處理…
        </p>
      )}
      {agent.actionError && <p className="ag-error">{agent.actionError}</p>}
      {!agent.connected && <p className="ag-note err">與開發伺服器的連線中斷，重連中…</p>}
    </div>
  );
}

const EXAMPLES = ['把這一天排鬆一點', '幫我找這附近適合午餐的地方', '檢查整趟有沒有時間衝突'];
// Step 0 (找方向) has no trip to change yet: the panel invites the user to talk about what kind of trip they want.
const IDEA_EXAMPLES = ['六月想去看山，預算每人五萬', '想吃好吃的、不想太累，七天', '直接推薦三個地方給我'];

function Empty({ idea }: { idea?: boolean }) {
  return (
    <div className="ag-empty">
      {idea ? (
        <p>跟我說你想要什麼樣的旅行，也可以直接點左邊的卡片。我會把答案記下來，畫面會馬上更新。</p>
      ) : (
        <p>直接說你想怎麼改這趟行程。我會改 <code>trips/</code> 裡的檔案，畫面會馬上更新。</p>
      )}
      <ul>
        {(idea ? IDEA_EXAMPLES : EXAMPLES).map((e) => (
          <li key={e}>{e}</li>
        ))}
      </ul>
    </div>
  );
}

function ItemView({ item, idle, context }: { item: AgentItem; idle: boolean; context: AgentTurnContext }) {
  switch (item.kind) {
    case 'user':
      return <UserMessage item={item} idle={idle} context={context} />;
    case 'assistant':
      return <div className={`ag-msg ag-assistant${item.streaming ? ' streaming' : ''}`}>{item.text ? <Markdown text={item.text} /> : <span className="ag-dots" aria-hidden="true" />}</div>;
    case 'tool':
      return (
        <div className={`ag-tool ${item.status}`}>
          <span className="ag-tool-icon" aria-label={item.status === 'running' ? '進行中' : item.status === 'done' ? '完成' : '失敗'}>
            {item.status === 'running' ? '…' : item.status === 'done' ? '✓' : '✗'}
          </span>
          <span className="ag-tool-title">{item.title}</span>
          {item.detail && <code className="ag-tool-detail">{item.detail}</code>}
        </div>
      );
    case 'permission':
      return <PermissionCard item={item} />;
    case 'question':
      return <QuestionCard item={item} />;
    case 'error':
      return <p className="ag-error">{item.text}</p>;
    case 'result':
      return (
        <p className="ag-result">
          {item.aborted ? '已停止' : '完成'}
          {item.durationMs !== null ? ` · ${(item.durationMs / 1000).toFixed(1)} 秒` : ''}
          {item.costUsd !== null ? ` · $${item.costUsd.toFixed(3)}` : ''}
        </p>
      );
  }
}

function UserMessage({ item, idle, context }: { item: Extract<AgentItem, { kind: 'user' }>; idle: boolean; context: AgentTurnContext }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.text);
  if (editing) {
    return (
      <div className="ag-msg ag-user editing">
        <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} aria-label="編輯訊息" autoFocus />
        <div className="ag-edit-actions">
          <button type="button" className="btn" onClick={() => setEditing(false)}>
            取消
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={!draft.trim()}
            onClick={() => {
              setEditing(false);
              void sendMessage(draft, context, item.id);
            }}
          >
            重新送出
          </button>
        </div>
        <p className="ag-hint">會回到這則訊息之前重來；已經改過的檔案會保留。</p>
      </div>
    );
  }
  return (
    <div className="ag-msg ag-user">
      {item.images && item.images.length > 0 && (
        <div className="ag-pics">
          {item.images.map((ref) => (
            <a key={ref} href={fileUrl(ref)} target="_blank" rel="noreferrer noopener" title="在新分頁開啟">
              <img src={fileUrl(ref)} alt="附加的圖片" loading="lazy" />
            </a>
          ))}
        </div>
      )}
      <p>{item.text}</p>
      {idle && (
        <button
          type="button"
          className="ag-edit"
          onClick={() => {
            setDraft(item.text);
            setEditing(true);
          }}
          aria-label="編輯這則訊息"
        >
          編輯
        </button>
      )}
    </div>
  );
}

function PermissionCard({ item }: { item: Extract<AgentItem, { kind: 'permission' }> }) {
  return (
    <div className={`ag-card ag-permission ${item.status}`} role={item.status === 'pending' ? 'alert' : undefined}>
      <p className="ag-card-title">
        {item.status === 'pending' ? 'Claude 想要：' : item.status === 'allowed' ? '已允許：' : '已拒絕：'}
        {item.title}
      </p>
      {item.detail && <code className="ag-card-detail">{item.detail}</code>}
      {item.status === 'pending' && (
        <div className="ag-card-actions">
          <button type="button" className="btn primary" onClick={() => void respond(item.id, { allow: true })}>
            允許
          </button>
          <button type="button" className="btn" onClick={() => void respond(item.id, { allow: false })}>
            拒絕
          </button>
        </div>
      )}
    </div>
  );
}

function QuestionCard({ item }: { item: Extract<AgentItem, { kind: 'question' }> }) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const open = item.status === 'pending';

  const toggle = (q: AgentQuestion, label: string) =>
    setPicked((p) => {
      const cur = p[q.question] ?? [];
      const next = q.multiSelect ? (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]) : [label];
      return { ...p, [q.question]: next };
    });
  const answerFor = (q: AgentQuestion): string => [...(picked[q.question] ?? []), ...(other[q.question]?.trim() ? [other[q.question]!.trim()] : [])].join('、');
  const complete = item.questions.every((q) => answerFor(q) !== '');

  return (
    <div className={`ag-card ag-question ${item.status}`}>
      {item.questions.map((q) => (
        <fieldset key={q.question} disabled={!open}>
          <legend>
            {q.header && <span className="ag-chip">{q.header}</span>}
            {q.question}
          </legend>
          {open ? (
            <>
              <div className="ag-options">
                {q.options.map((o) => {
                  const on = (picked[q.question] ?? []).includes(o.label);
                  return (
                    <button key={o.label} type="button" className={`ag-option${on ? ' on' : ''}`} aria-pressed={on} onClick={() => toggle(q, o.label)}>
                      <span>{o.label}</span>
                      {o.description && <small>{o.description}</small>}
                    </button>
                  );
                })}
              </div>
              <input
                className="ag-other"
                type="text"
                placeholder="其他（自己寫）"
                value={other[q.question] ?? ''}
                onChange={(e) => setOther((o) => ({ ...o, [q.question]: e.target.value }))}
              />
            </>
          ) : (
            <p className="ag-answer">{item.answers?.[q.question] ?? '（略過）'}</p>
          )}
        </fieldset>
      ))}
      {open && (
        <div className="ag-card-actions">
          <button
            type="button"
            className="btn primary"
            disabled={!complete}
            onClick={() => void respond(item.id, { answers: Object.fromEntries(item.questions.map((q) => [q.question, answerFor(q)])) })}
          >
            送出答案
          </button>
          <button type="button" className="btn" onClick={() => void respond(item.id, { cancel: true })}>
            略過
          </button>
        </div>
      )}
    </div>
  );
}

// ---------- composer ----------

function Composer({ agent, context, contextLabel, attachments }: { agent: AgentState; context: AgentTurnContext; contextLabel: string; attachments: Attachments }) {
  const { active, settings, status } = agent;
  const running = active?.status === 'running';
  const [text, setText] = useState('');
  const area = useRef<HTMLTextAreaElement | null>(null);
  const model = status?.models.find((m) => m.id === settings.model);

  // Grow with the text, up to a few lines.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [text]);

  const picker = useRef<HTMLInputElement | null>(null);
  const canSend = (text.trim() !== '' || attachments.refs.length > 0) && !attachments.busy;

  const submit = async () => {
    if (running || !canSend) return;
    const sent = text;
    const pictures = attachments.refs;
    setText('');
    if (await sendMessage(sent, context, undefined, pictures)) attachments.clear();
    else setText(sent);
  };

  return (
    <div className="ag-composer">
      {contextLabel && (
        <p className="ag-context" title="「這一天」「這個景點」會指這裡">
          正在看：{contextLabel}
        </p>
      )}
      {attachments.items.length > 0 && (
        <div className="ag-attach" aria-label="要附上的圖片">
          {attachments.items.map((a) => (
            <div key={a.key} className={`ag-thumb${a.error ? ' failed' : a.ref ? '' : ' loading'}`} title={a.error ?? undefined}>
              <img src={a.preview} alt="" />
              {!a.ref && !a.error && <span className="ag-thumb-state">上傳中</span>}
              {a.error && <span className="ag-thumb-state">失敗</span>}
              <button type="button" className="ag-thumb-x" onClick={() => attachments.remove(a.key)} aria-label="移除這張圖片">
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      {attachments.items.some((a) => a.error) && <p className="ag-error">{attachments.items.find((a) => a.error)?.error}</p>}
      {attachments.notice && <p className="ag-note">{attachments.notice}</p>}
      {attachments.items.length > 0 && <p className="ag-hint">圖片會送給 Claude 分析；請不要附護照、信用卡等證件。</p>}
      <textarea
        ref={area}
        value={text}
        rows={1}
        placeholder={running ? 'Claude 正在處理…' : context.idea ? '想要什麼樣的旅行？' : '想怎麼改這趟行程？可以貼上或拖進圖片'}
        aria-label="給 AI 助手的訊息"
        onChange={(e) => setText(e.target.value)}
        onPaste={(e) => {
          // A screenshot on the clipboard becomes an attachment; pasting text still works as usual.
          const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'));
          if (files.length === 0) return;
          e.preventDefault();
          attachments.add(files);
        }}
        onKeyDown={(e) => {
          // Enter confirms an IME candidate (注音 / 倉頡); only a bare Enter outside composition sends.
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <div className="ag-composer-bar">
        <input
          ref={picker}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            attachments.add(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
        <button
          type="button"
          className="ag-icon ag-attach-btn"
          onClick={() => picker.current?.click()}
          disabled={attachments.items.length >= MAX_ATTACHMENTS}
          aria-label="附上圖片"
          title="附上圖片（也可以直接貼上或拖進來）"
        >
          ＋圖
        </button>
        <select value={settings.model} onChange={(e) => updateSettings({ model: e.target.value, effort: '' })} aria-label="模型">
          <option value="">預設模型</option>
          {status?.models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        {model && model.efforts.length > 0 && (
          <select value={settings.effort} onChange={(e) => updateSettings({ effort: AGENT_EFFORTS.find((x) => x === e.target.value) ?? '' })} aria-label="思考程度">
            <option value="">預設思考</option>
            {model.efforts.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
        )}
        <label className="ag-auto" title="開了之後，指令、網路搜尋等不再逐一詢問（改 trips/ 本來就不用問）">
          <input type="checkbox" checked={settings.autoApprove} onChange={(e) => updateSettings({ autoApprove: e.target.checked })} />
          自動允許
        </label>
        {running ? (
          <button type="button" className="btn ag-send" onClick={() => void stopSession()}>
            停止
          </button>
        ) : (
          <button type="button" className="btn primary ag-send" onClick={() => void submit()} disabled={!canSend}>
            送出
          </button>
        )}
      </div>
    </div>
  );
}
