import { useMemo } from 'react';
import type { Issue, Item, Trip } from '../../core/types.ts';
import { checkTrip } from '../../core/index.ts';
import type { Send } from '../api.ts';
import { KIND_LABEL, dateLabel, lockedItems, type Selection } from '../model.ts';
import { Attachments } from './Attachments.tsx';

type Field = 'title' | 'start' | 'end' | 'flightNo' | 'bookingRef' | 'note';

interface FieldDef {
  field: Field;
  label: string;
  type: 'text' | 'time';
  required?: boolean;
  wide?: boolean;
}

const FIELDS: FieldDef[] = [
  { field: 'flightNo', label: '航班', type: 'text', required: true },
  { field: 'bookingRef', label: '訂位代號', type: 'text' },
  { field: 'start', label: '開始', type: 'time', required: true },
  { field: 'end', label: '結束', type: 'time', required: true },
  { field: 'note', label: '備註', type: 'text', wide: true },
];

function appliesTo(item: Item, field: Field): boolean {
  if (field === 'flightNo') return item.kind === 'flight';
  if (field === 'bookingRef') return item.kind === 'flight' || item.kind === 'hotel';
  return true;
}

function currentValue(item: Item, field: Field): string {
  const v = (item as unknown as Record<string, unknown>)[field];
  return typeof v === 'string' ? v : '';
}

export interface Health {
  issues: Issue[];
  errors: number;
  failed?: string;
}

export function useHealth(trip: Trip): Health {
  return useMemo(() => {
    try {
      const issues = checkTrip(trip);
      return { issues, errors: issues.filter((i) => i.level === 'error').length };
    } catch (e) {
      return { issues: [], errors: 0, failed: e instanceof Error ? e.message : String(e) };
    }
  }, [trip]);
}

export function healthText(h: Health): { tone: 'ok' | 'warn' | 'err'; text: string } {
  if (h.failed) return { tone: 'warn', text: '健檢無法執行' };
  if (h.issues.length === 0) return { tone: 'ok', text: '行程健檢通過' };
  const warns = h.issues.length - h.errors;
  const parts = [h.errors ? `${h.errors} 個錯誤` : '', warns ? `${warns} 個提醒` : ''].filter(Boolean);
  return { tone: h.errors ? 'err' : 'warn', text: parts.join('、') };
}

function FactInput({ item, def, send, className }: { item: Item; def: FieldDef; send: Send; className?: string }) {
  const value = currentValue(item, def.field);
  const commit = (next: string) => {
    const v = next.trim();
    if (v === value) return;
    if (def.required && v === '') return; // never write an empty required value
    void send('item-field', { itemId: item.id, field: def.field, value: v }, `已更新「${def.label}」，健檢已重新執行`);
  };
  return (
    <input
      key={value}
      className={className}
      type={def.type}
      defaultValue={value}
      aria-label={`${item.title} ${def.label}`}
      placeholder={def.type === 'text' ? '—' : undefined}
      onBlur={(e) => commit(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
    />
  );
}

interface Props {
  tripId: string;
  trip: Trip;
  health: Health;
  send: Send;
  onSelect: (sel: Selection, dayIdx: number | null) => void;
}

export function FactsPanel({ tripId, trip, health, send, onSelect }: Props) {
  const locked = useMemo(() => lockedItems(trip), [trip]);
  const dayIndexOf = (date?: string) => {
    const i = date ? trip.days.findIndex((d) => d.date === date) : -1;
    return i >= 0 ? i : null;
  };
  const titleDef: FieldDef = { field: 'title', label: '名稱', type: 'text', required: true };

  return (
    <div>
      <p className="section-label">已確定的項目 · 直接修改、上傳票券，不必告訴 Claude</p>
      {locked.length === 0 && <p className="muted">還沒有已確定的項目。訂好的機票、飯店會出現在這裡。</p>}
      {locked.map(({ item, dayIdx, day }) => (
        <article className="fact" key={item.id}>
          <div className="fact-head">
            <span className="tag">{KIND_LABEL[item.kind]}</span>
            <span>
              Day {dayIdx + 1} · {dateLabel(day.date)}
              {item.kind === 'hotel' ? ` · ${item.nights} 晚` : ''}
            </span>
            <button type="button" className="link" onClick={() => onSelect({ type: 'item', id: item.id }, dayIdx)}>
              在地圖上看
            </button>
          </div>
          <FactInput item={item} def={titleDef} send={send} className="fact-title" />
          <div className="fact-grid">
            {FIELDS.filter((def) => appliesTo(item, def.field)).map((def) => (
              <label key={def.field} className={def.wide ? 'wide' : ''}>
                {def.label}
                <FactInput item={item} def={def} send={send} />
              </label>
            ))}
          </div>
          <Attachments tripId={tripId} item={item} send={send} />
        </article>
      ))}

      <p className="section-label">行程健檢</p>
      {health.failed ? (
        <p className="muted">健檢無法執行：{health.failed}</p>
      ) : health.issues.length === 0 ? (
        <p className="ok-note">● 沒有發現問題</p>
      ) : (
        <ul className="issues" aria-label="行程健檢結果">
          {health.issues.map((is, i) => (
            <li key={`${is.code}-${is.itemId ?? is.date ?? ''}-${i}`} className={is.level}>
              <button
                type="button"
                disabled={!is.itemId}
                onClick={() => {
                  if (is.itemId) onSelect({ type: 'item', id: is.itemId }, dayIndexOf(is.date));
                }}
              >
                <span>
                  {is.message}
                  <code>
                    {is.level === 'error' ? '錯誤' : '提醒'} · {is.code}
                  </code>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
