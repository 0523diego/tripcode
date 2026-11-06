import { useRef, useState } from 'react';
import { inlineProblem, normalizeInline } from '../inline-edit.ts';
import type { InlineKind } from '../inline-edit.ts';

interface Props {
  kind: InlineKind;
  value: string;
  label: string;
  /** Called with the cleaned value, only when it differs from `value`. */
  onCommit: (value: string) => void;
  onDone: () => void;
  className?: string;
}

/**
 * A one-line input that replaces a title or time in the itinerary. Enter or leaving the field saves,
 * Escape cancels; a value that cannot be sent keeps the field open (Enter) or is dropped (leaving).
 */
export function InlineEdit({ kind, value, label, onCommit, onDone, className }: Props) {
  const [draft, setDraft] = useState(value);
  const [invalid, setInvalid] = useState(false);
  const finished = useRef(false);

  const finish = (save: boolean, keepOpenIfInvalid: boolean) => {
    if (finished.current) return;
    if (!save) {
      finished.current = true;
      onDone();
      return;
    }
    const clean = normalizeInline(kind, draft);
    if (clean === null) {
      if (keepOpenIfInvalid) {
        setInvalid(true);
        return;
      }
      finished.current = true;
      onDone();
      return;
    }
    finished.current = true;
    if (clean !== value) onCommit(clean);
    onDone();
  };

  return (
    <input
      className={`inline-edit${invalid ? ' invalid' : ''}${className ? ` ${className}` : ''}`}
      type="text"
      value={draft}
      aria-label={label}
      aria-invalid={invalid || undefined}
      title={invalid ? inlineProblem(kind, draft) : undefined}
      size={kind === 'time' ? 5 : undefined}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => {
        setDraft(e.target.value);
        setInvalid(false);
      }}
      onKeyDown={(e) => {
        // Enter also confirms an IME candidate (注音 / 倉頡); only a bare Enter outside composition saves.
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
          e.preventDefault();
          finish(true, true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          finish(false, false);
        }
      }}
      onBlur={() => finish(true, false)}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    />
  );
}
