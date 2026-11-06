import { useState } from 'react';
import type { Trip } from '../../core/types.ts';
import type { SentComment } from '../comment-log.ts';
import { CommentLog, useCommentStates } from './CommentLog.tsx';
import type { Health } from './FactsPanel.tsx';

/** Candidates the user has not decided on yet (not accepted, not rejected). */
export function openCandidates(trip: Trip): number {
  return trip.candidates.filter((c) => c.status === 'unconfirmed' || c.status === 'discuss').length;
}

export interface Open {
  candidates: number;
  /** Health errors + warnings. */
  issues: number;
  inbox: number;
  total: number;
}

export function openThings(trip: Trip, health: Health, pendingInbox: number): Open {
  const candidates = openCandidates(trip);
  const issues = health.failed ? 0 : health.issues.length;
  return { candidates, issues, inbox: pendingInbox, total: candidates + issues + pendingInbox };
}

interface Props {
  tripId: string;
  trip: Trip;
  health: Health;
  lockedCount: number;
  pendingInbox: number;
  comments: SentComment[];
  /** Variant label when the trip has more than one plan file. */
  variant?: string;
  onFacts: () => void;
  onCandidates: () => void;
  onInbox: () => void;
  onPrint: () => void;
}

/**
 * Footer of the rail. Reads top-down: how many things are still undecided, then the three numbers
 * behind that (locked / candidates / health), then comments sent this session.
 */
export function RailFoot({ tripId, trip, health, lockedCount, pendingInbox, comments, variant, onFacts, onCandidates, onInbox, onPrint }: Props) {
  const [logOpen, setLogOpen] = useState(false);
  const states = useCommentStates(tripId, comments);
  const waiting = states.filter((s) => s !== 'maybe-applied').length;
  const open = openThings(trip, health, pendingInbox);
  const errors = health.errors;
  const warns = health.issues.length - errors;
  const healthTone = health.failed ? 'warn' : errors ? 'err' : warns ? 'warn' : 'ok';
  const healthText = health.failed ? '健檢無法執行' : health.issues.length === 0 ? '健檢通過' : [errors ? `${errors} 個錯誤` : '', warns ? `${warns} 個提醒` : ''].filter(Boolean).join('、');

  return (
    <footer className="rail-foot">
      <div className="foot-status">
        <p className={`foot-headline ${open.total === 0 && !health.failed ? 'ok' : 'todo'}`}>
          {open.total === 0 ? (health.failed ? '健檢無法執行，請手動確認' : '這趟都確定了') : `還有 ${open.total} 件事沒定`}
        </p>
        <ul className="foot-chips">
          <li>
            <button type="button" className="chip" onClick={onFacts} title="已鎖定的訂位、航班與必去項目">
              已確定 <b>{lockedCount}</b>
            </button>
          </li>
          <li>
            <button type="button" className={`chip${open.candidates > 0 ? ' todo' : ''}`} onClick={onCandidates} title="還沒決定要不要去的候選景點">
              候選 <b>{open.candidates}</b>
            </button>
          </li>
          <li>
            <button type="button" className={`chip ${healthTone}`} onClick={onFacts} title="行程健檢（時間、營業日、移動距離）">
              {healthText}
            </button>
          </li>
          {pendingInbox > 0 && (
            <li>
              <button type="button" className="chip todo" onClick={onInbox} title="貼上的文章還沒整理成候選">
                待整理匯入 <b>{pendingInbox}</b>
              </button>
            </li>
          )}
        </ul>
      </div>

      {comments.length > 0 && (
        <div className="foot-comments">
          <button type="button" className="link comments-toggle" aria-expanded={logOpen} onClick={() => setLogOpen(!logOpen)}>
            {waiting > 0 ? `已留言 ${waiting} 則，等 Claude 處理` : `已留言 ${comments.length} 則，可能已套用`}
            <span aria-hidden="true"> {logOpen ? '▾' : '▸'}</span>
          </button>
          {logOpen && <CommentLog comments={comments} states={states} />}
        </div>
      )}

      <div className="foot-meta">
        {variant && <span className="hint">{variant}</span>}
        <button type="button" className="link foot-print" onClick={onPrint}>
          列印行程
        </button>
      </div>
    </footer>
  );
}
