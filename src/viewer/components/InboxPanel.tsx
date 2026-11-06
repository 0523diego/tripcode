import { useMemo, useState } from 'react';
import type { Candidate } from '../../core/types.ts';
import type { Send } from '../api.ts';
import type { InboxFile } from '../trips.ts';
import { inboxStatusText, parseInbox, tileTitle } from '../model.ts';

interface Props {
  inbox: InboxFile[];
  candidates: Candidate[];
  send: Send;
}

export function InboxPanel({ inbox, candidates, send }: Props) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const notes = useMemo(() => inbox.map(parseInbox), [inbox]);

  const submit = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    const ok = await send('inbox', { text: t }, '已匯入，請 Claude「解析匯入欄」');
    setBusy(false);
    if (ok) setText('');
  };

  return (
    <div>
      <div className="inbox-form">
        <label>
          <span className="sr-only">貼上文字</span>
          <textarea
            value={text}
            placeholder="貼上小紅書、部落格或朋友給的景點文字"
            rows={4}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void submit();
            }}
          />
        </label>
        <div className="row-end">
          <span>⌘ + Enter 匯入</span>
          <button type="button" className="btn primary" disabled={!text.trim() || busy} onClick={() => void submit()}>
            {busy ? '匯入中…' : '匯入'}
          </button>
        </div>
      </div>

      <p className="section-label">已匯入 · {notes.length}</p>
      <ul className="tiles">
        {notes.length === 0 && <li className="muted">還沒有匯入的內容。</li>}
        {notes.map((n) => {
          const st = inboxStatusText(n, candidates);
          const open = openFile === n.file;
          return (
            <li key={n.file} className="tile">
              <button
                type="button"
                className="tile-head"
                aria-expanded={open}
                onClick={() => setOpenFile(open ? null : n.file)}
              >
                <span className="tile-title">{tileTitle(n.body)}</span>
                <span className="tile-name">{n.file}</span>
                <span className={`status ${st.tone}`}>{st.text}</span>
              </button>
              {open && <pre className="raw">{n.body || n.raw}</pre>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
