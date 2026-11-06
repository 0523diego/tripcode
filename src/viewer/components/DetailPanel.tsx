import { useEffect, useState } from 'react';
import type { Candidate, Item, Trip } from '../../core/types.ts';
import type { Send } from '../api.ts';
import { KIND_LABEL, STATUS_LABEL, dateLabel, findItem, type Selection } from '../model.ts';
import { Attachments } from './Attachments.tsx';

interface Props {
  tripId: string;
  trip: Trip;
  selection: Selection;
  dayIdx: number | null;
  send: Send;
  onClose: () => void;
  /** Pushed inside the mobile sheet: a back row replaces the floating card's × button. */
  embedded?: boolean;
}

function CommentBox({ targetId, anchor, send, placeholder }: { targetId: string; anchor: 'item' | 'gap' | 'day'; send: Send; placeholder: string }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setText(''), [targetId, anchor]);
  const submit = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    const ok = await send('comment', { targetId, anchor, text: t }, '留言已寫入，等 Claude 套用');
    setBusy(false);
    if (ok) setText('');
  };
  return (
    <div className="comment-box">
      <label>
        <span>留言給 Claude</span>
        <textarea
          rows={2}
          value={text}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void submit();
          }}
        />
      </label>
      <button type="button" className="btn primary" disabled={!text.trim() || busy} onClick={() => void submit()}>
        {busy ? '送出中…' : '送出留言'}
      </button>
    </div>
  );
}

/** Direct edits for a scheduled item: start/end time and lock. Each call is one endpoint write. */
function ItemActions({ item, send }: { item: Item; send: Send }) {
  const commitTime = (field: 'start' | 'end', label: string, next: string) => {
    const v = next.trim();
    // An empty value would be rejected by the endpoint (HH:MM only); there is no way to clear a time here.
    if (!v || v === (item[field] ?? '')) return;
    void send('item-field', { itemId: item.id, field, value: v }, `已更新${label}時間為 ${v}`);
  };
  const timeInput = (field: 'start' | 'end', label: string) => (
    <label className="time-edit">
      <span>{label}</span>
      <input
        key={item[field] ?? ''}
        type="time"
        defaultValue={item[field] ?? ''}
        aria-label={`${item.title} ${label}時間`}
        onBlur={(e) => commitTime(field, label, e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
      />
    </label>
  );
  return (
    <>
      <div className="detail-section item-actions">
        <p className="detail-kicker">直接修改</p>
        <div className="chips">
          {timeInput('start', '開始')}
          {timeInput('end', '結束')}
          <button
            type="button"
            className={`btn${item.locked ? ' on' : ''}`}
            aria-pressed={!!item.locked}
            title={item.locked ? '解除後 Claude 可以調整這個項目' : '鎖定後 Claude 不會更動這個項目'}
            onClick={() =>
              void send('set-locked', { itemId: item.id, locked: !item.locked }, item.locked ? '已解除鎖定' : '已鎖定，Claude 不會更動它')
            }
          >
            {item.locked ? '解除鎖定' : '鎖定'}
          </button>
        </div>
      </div>
    </>
  );
}

function DeleteItem({ item, send, onClose }: { item: Item; send: Send; onClose: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => setConfirming(false), [item.id]);
  if (!confirming) {
    return (
      <button type="button" className="link danger-link" onClick={() => setConfirming(true)}>
        從行程刪除…
      </button>
    );
  }
  return (
    <div className="delete-confirm" role="alertdialog" aria-label="確認刪除">
      <p>
        {item.locked ? '這是「已確定」的項目。' : ''}確定從行程刪除「{item.title}」？它附帶的留言也會一起移除。
      </p>
      <div className="chips">
        <button
          type="button"
          className="btn danger on"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const ok = await send('remove-item', { itemId: item.id }, `已刪除「${item.title}」`);
            setBusy(false);
            if (ok) onClose();
            else setConfirming(false);
          }}
        >
          {busy ? '刪除中…' : '確定刪除'}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => setConfirming(false)}>
          取消
        </button>
      </div>
    </div>
  );
}

function CandidateActions({ cand, trip, dayIdx, send }: { cand: Candidate; trip: Trip; dayIdx: number | null; send: Send }) {
  const set = (status: Candidate['status'], day?: number) =>
    send('candidate', { candidateId: cand.id, status, ...(day !== undefined ? { day } : {}) }, `已設為「${STATUS_LABEL[status]}」`);
  const [pick, setPick] = useState(() => cand.day ?? (dayIdx !== null ? dayIdx + 1 : 1));
  useEffect(() => setPick(cand.day ?? (dayIdx !== null ? dayIdx + 1 : 1)), [cand.id, cand.day, dayIdx]);
  return (
    <div className="cand-actions">
      <div className="chips add-day">
        <label>
          加入第{' '}
          <select value={pick} onChange={(e) => setPick(Number(e.target.value))} aria-label="選擇天數">
            {trip.days.map((d, i) => (
              <option key={d.date} value={i + 1}>
                {i + 1}
              </option>
            ))}
          </select>{' '}
          天
        </label>
        <button
          type="button"
          className="btn primary"
          onClick={() => {
            const date = trip.days[pick - 1]?.date;
            if (date) void send('schedule-candidate', { candidateId: cand.id, toDate: date }, `已排入第 ${pick} 天`);
          }}
        >
          排入
        </button>
      </div>
      <div className="chips">
        <button type="button" className={`btn${cand.status === 'discuss' ? ' on' : ''}`} onClick={() => void set('discuss')}>
          待討論
        </button>
        <button type="button" className={`btn danger${cand.status === 'rejected' ? ' on' : ''}`} onClick={() => void set('rejected')}>
          不去
        </button>
        {cand.status !== 'unconfirmed' && (
          <button type="button" className="btn" onClick={() => void set('unconfirmed')}>
            恢復
          </button>
        )}
      </div>
    </div>
  );
}

export function DetailPanel({ tripId, trip, selection, dayIdx, send, onClose, embedded }: Props) {
  let body: React.ReactNode = null;
  let title = '';
  let kicker = '';

  if (selection.type === 'item') {
    const ref = findItem(trip, selection.id);
    if (!ref) return null;
    const { item, dayIdx: di, day } = ref;
    title = item.title;
    kicker = KIND_LABEL[item.kind];
    body = (
      <>
        <p className="meta">
          Day {di + 1} · {dateLabel(day.date)}
          {item.start && ` · ${item.start}${item.end ? `–${item.end}` : ''}`}
          {item.locked && <em className="tag lock">已確定</em>}
        </p>
        {item.note && <p>{item.note}</p>}
        <ItemActions item={item} send={send} />
        <div className="detail-section">
          <p className="detail-kicker">票券與文件</p>
          <Attachments tripId={tripId} item={item} send={send} />
        </div>
        <CommentBox targetId={item.id} anchor="item" send={send} placeholder="想改什麼？例如：改到下午、換成別的景點" />
        <DeleteItem item={item} send={send} onClose={onClose} />
      </>
    );
  } else if (selection.type === 'candidate') {
    const cand = trip.candidates.find((c) => c.id === selection.id);
    if (!cand) return null;
    title = cand.title;
    kicker = '候選景點';
    body = (
      <>
        <p className="meta">
          <span className={`status-chip s-${cand.status}`}>{STATUS_LABEL[cand.status]}</span>
          {cand.status === 'accepted' && cand.day ? `第 ${cand.day} 天` : ''}
        </p>
        {cand.why && <p>{cand.why}</p>}
        <p className="muted">來源：{cand.sources.join('、') || '—'}</p>
        <CandidateActions cand={cand} trip={trip} dayIdx={dayIdx} send={send} />
        <CommentBox targetId={cand.id} anchor="item" send={send} placeholder="對這個地點的想法…" />
      </>
    );
  } else if (selection.type === 'gap') {
    const next = findItem(trip, selection.targetId);
    title = `${selection.from}–${selection.to}`;
    kicker = '空檔';
    body = (
      <>
        <p className="muted">
          在「{next?.item.title ?? selection.targetId}」之前的空檔，可以留言請 Claude 安排。
        </p>
        <CommentBox targetId={selection.targetId} anchor="gap" send={send} placeholder="這段想做什麼？例如：加一個咖啡廳" />
      </>
    );
  } else {
    title = dateLabel(selection.date);
    kicker = '整天';
    body = <CommentBox targetId={selection.date} anchor="day" send={send} placeholder="對這一天整體的想法…" />;
  }

  return (
    <section className={`detail card${embedded ? ' embedded' : ''}`} aria-label="詳細資料">
      {embedded && (
        <button type="button" className="detail-back" onClick={onClose}>
          ‹ 返回行程
        </button>
      )}
      <header className="detail-head">
        <div>
          <div className="detail-kicker">{kicker}</div>
          <h3>{title}</h3>
        </div>
        {!embedded && (
          <button type="button" className="close-x" onClick={onClose} aria-label="關閉詳細資料">
            ×
          </button>
        )}
      </header>
      {body}
    </section>
  );
}
