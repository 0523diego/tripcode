// Undo / redo for the viewer's edits. The dev server records the before and after text of every
// trip-file write the viewer makes, per file. An undo only goes through when the file still holds
// exactly the text that edit produced: if Claude (or the user in an editor) changed the file since,
// restoring an older snapshot would silently throw their work away, so it is refused instead.
// Pure and in-memory; the plugin does the reading and writing.

export interface HistoryEntry {
  /** Short zh-TW description for the toast and the button tooltip, e.g. 「改標題」. */
  label: string;
  before: string;
  after: string;
  /** The item (or candidate) the edit touched, so the viewer can jump back to it. */
  itemId?: string;
}

export interface HistoryInfo {
  undo: number;
  redo: number;
  undoLabel?: string;
  redoLabel?: string;
  undoItemId?: string;
  redoItemId?: string;
}

export type Direction = 'undo' | 'redo';

export type StepPlan =
  | { ok: true; content: string; entry: HistoryEntry; commit: () => void }
  | { ok: false; reason: 'empty' | 'conflict'; error: string };

const MAX_ENTRIES = 50;

interface Stacks {
  undo: HistoryEntry[];
  redo: HistoryEntry[];
}

export class EditHistory {
  private readonly files = new Map<string, Stacks>();

  private stacks(key: string): Stacks {
    let s = this.files.get(key);
    if (!s) {
      s = { undo: [], redo: [] };
      this.files.set(key, s);
    }
    return s;
  }

  /** Records a write. A new edit ends the redo chain, like any editor. Edits that changed nothing are not recorded. */
  record(key: string, entry: HistoryEntry): void {
    if (entry.before === entry.after) return;
    const s = this.stacks(key);
    s.undo.push(entry);
    if (s.undo.length > MAX_ENTRIES) s.undo.splice(0, s.undo.length - MAX_ENTRIES);
    s.redo.length = 0;
  }

  info(key: string): HistoryInfo {
    const s = this.files.get(key);
    if (!s) return { undo: 0, redo: 0 };
    const u = s.undo.at(-1);
    const r = s.redo.at(-1);
    return {
      undo: s.undo.length,
      redo: s.redo.length,
      ...(u ? { undoLabel: u.label, ...(u.itemId ? { undoItemId: u.itemId } : {}) } : {}),
      ...(r ? { redoLabel: r.label, ...(r.itemId ? { redoItemId: r.itemId } : {}) } : {}),
    };
  }

  /**
   * Works out one undo or redo against the file's `current` text. Nothing changes until the caller has
   * written `content` and calls `commit()`, so a failed write leaves the history as it was. A mismatch
   * means the file moved on without us: both stacks are dropped, since the older entries no longer
   * line up with what is on disk either.
   */
  plan(key: string, direction: Direction, current: string): StepPlan {
    const s = this.stacks(key);
    const from = direction === 'undo' ? s.undo : s.redo;
    const to = direction === 'undo' ? s.redo : s.undo;
    const entry = from.at(-1);
    if (!entry) return { ok: false, reason: 'empty', error: direction === 'undo' ? '沒有可以復原的動作' : '沒有可以重做的動作' };
    const expected = direction === 'undo' ? entry.after : entry.before;
    if (current !== expected) {
      s.undo.length = 0;
      s.redo.length = 0;
      return { ok: false, reason: 'conflict', error: '檔案在這個動作之後被改過（可能是 AI 助手或編輯器），為了不蓋掉那些修改，沒有復原。' };
    }
    return {
      ok: true,
      content: direction === 'undo' ? entry.before : entry.after,
      entry,
      commit: () => {
        from.pop();
        to.push(entry);
      },
    };
  }
}
