import { useRef, useState } from 'react';
import type { Attachment, Item } from '../../core/types.ts';
import type { Send } from '../api.ts';

const KINDS: [NonNullable<Attachment['kind']>, string][] = [
  ['transport', '交通票'],
  ['entry', '門票'],
  ['booking', '訂單確認'],
  ['other', '其他'],
];
const ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,.heic,.pkpass';
const MAX_BYTES = 15 * 1024 * 1024;

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error ?? new Error('讀取檔案失敗'));
    r.readAsDataURL(file);
  });
}

interface Props {
  tripId: string;
  item: Item;
  send: Send;
}

/** Tickets / booking files attached to an item: list, open, upload, remove. */
export function Attachments({ tripId, item, send }: Props) {
  const input = useRef<HTMLInputElement | null>(null);
  const [kind, setKind] = useState<NonNullable<Attachment['kind']>>(item.kind === 'transit' || item.kind === 'flight' ? 'transport' : 'entry');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = item.attachments ?? [];

  const upload = async (file: File) => {
    if (file.size > MAX_BYTES) return setError('檔案超過 15 MB');
    setBusy(true);
    setError(null);
    try {
      const dataBase64 = await toBase64(file);
      const label = file.name.replace(/\.[^.]+$/, '');
      await send('attach', { itemId: item.id, label, kind, filename: file.name, dataBase64 }, `已加入票券「${label}」`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <div className="attachments">
      {list.length > 0 && (
        <ul className="att-list">
          {list.map((a) => (
            <li key={a.file}>
              <a href={`/trips/${tripId}/${a.file}`} target="_blank" rel="noreferrer noopener" className="att-open">
                <span className="att-icon" aria-hidden="true">
                  {/\.pdf$/i.test(a.file) ? 'PDF' : /\.pkpass$/i.test(a.file) ? 'PASS' : 'IMG'}
                </span>
                <span className="att-label">{a.label}</span>
                {a.kind && <span className="tag">{KINDS.find(([k]) => k === a.kind)?.[1] ?? a.kind}</span>}
              </a>
              <button
                type="button"
                className="link"
                aria-label={`移除 ${a.label}`}
                onClick={() => void send('detach', { itemId: item.id, attachmentFile: a.file }, `已移除「${a.label}」`)}
              >
                移除
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="att-add">
        <select value={kind} onChange={(e) => setKind(e.target.value as NonNullable<Attachment['kind']>)} aria-label="票券類型">
          {KINDS.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
        <button type="button" className="btn" disabled={busy} onClick={() => input.current?.click()}>
          {busy ? '上傳中…' : '＋ 上傳票券'}
        </button>
        <input
          ref={input}
          type="file"
          accept={ACCEPT}
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
          }}
        />
      </div>
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}
