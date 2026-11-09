// The color dot next to a day's heading. Click it to pick one of the 8 palette colors for this day; when the day shares a
// hotel with other days they can all change together (the default), and 恢復自動 goes back to "same hotel, same color".
import { useEffect, useRef, useState } from 'react';
import { PALETTE_SIZE, dayColorVar } from '../../core/day-colors.ts';

export const COLOR_NAMES = ['藍', '橙', '綠', '粉', '青', '金', '紫', '紅'] as const;

interface Props {
  date: string;
  /** The color the day shows now (1–8). */
  slot: number;
  /** The day has its own color; 恢復自動 is offered only then (or when sharing days do). */
  custom: boolean;
  /** Dates that sleep in the same hotel, this day included. A single date means there is nothing to share with. */
  sameStay: string[];
  /** Whether any of those days carries its own color, so 恢復自動 has something to undo. */
  anyCustom: boolean;
  onPick: (dates: string[], color: number | null) => void;
}

export function DayColorPicker({ date, slot, custom, sameStay, anyCustom, onPick }: Props) {
  const [open, setOpen] = useState(false);
  const [together, setTogether] = useState(true);
  const wrap = useRef<HTMLSpanElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  const shared = sameStay.length > 1;
  const targets = shared && together ? sameStay : [date];

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    first.current?.focus();
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const pick = (color: number | null) => {
    onPick(targets, color);
    setOpen(false);
  };

  return (
    <span className="day-swatch-wrap" ref={wrap} onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
      <button
        type="button"
        className="swatch swatch-btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`這天的顏色：${COLOR_NAMES[slot - 1] ?? slot}，按一下更換`}
        title="換顏色"
        onClick={() => setOpen((o) => !o)}
      />
      {open && (
        <div className="color-pop" role="dialog" aria-label="選這天的顏色">
          <div className="color-grid">
            {Array.from({ length: PALETTE_SIZE }, (_, i) => i + 1).map((n) => (
              <button
                key={n}
                ref={n === slot ? first : undefined}
                type="button"
                className={`color-dot${n === slot ? ' on' : ''}`}
                style={{ ['--c' as string]: `var(${dayColorVar(n)})` }}
                aria-label={`${COLOR_NAMES[n - 1]}色`}
                aria-pressed={n === slot}
                title={`${COLOR_NAMES[n - 1]}色`}
                onClick={() => pick(n)}
              />
            ))}
          </div>
          {shared && (
            <label className="color-together">
              <input type="checkbox" checked={together} onChange={(e) => setTogether(e.target.checked)} />
              同一住宿的 {sameStay.length} 天一起換
            </label>
          )}
          <button type="button" className="color-auto" disabled={!(custom || (shared && together && anyCustom))} onClick={() => pick(null)}>
            恢復自動（同住宿同顏色）
          </button>
        </div>
      )}
    </span>
  );
}
