import { useMemo } from 'react';
import { diffDay, formatMinutes, tripDayStats, tripMetrics, type DayDiff, type DayStats, type TripMetrics } from '../compare.ts';
import { dateLabel, dayVar } from '../model.ts';
import type { TripEntry } from '../trips.ts';
import { variantName } from '../variant.ts';

interface Props {
  entry: TripEntry;
  left: string;
  right: string;
  onPick: (side: 'left' | 'right', file: string) => void;
  /** Open a variant/day in the normal view. */
  onOpen: (file: string, dayIdx: number) => void;
}

const METRICS: [keyof TripMetrics, string][] = [
  ['days', '天數'],
  ['pois', '景點'],
  ['hotelChanges', '換飯店'],
  ['transitLegs', '交通段'],
  ['candidates', '候選'],
];

function Metrics({ m, other }: { m: TripMetrics; other: TripMetrics }) {
  return (
    <dl className="cmp-metrics">
      {METRICS.map(([key, label]) => (
        <div key={key} className={m[key] !== other[key] ? 'diff' : ''}>
          <dt>{label}</dt>
          <dd>{m[key]}</dd>
        </div>
      ))}
    </dl>
  );
}

function DayCell({
  file,
  idx,
  stats,
  diff,
  mine,
  date,
  onOpen,
}: {
  file: string;
  idx: number;
  stats: DayStats | undefined;
  diff: DayDiff;
  mine: string[];
  date: string | undefined;
  onOpen: (file: string, dayIdx: number) => void;
}) {
  if (!stats) {
    return <div className="cmp-cell empty">此方案沒有第 {idx + 1} 天</div>;
  }
  return (
    <button
      type="button"
      className={`cmp-cell${diff.differs ? ' differs' : ''}`}
      style={{ ['--day-color' as string]: `var(${dayVar(idx)})` }}
      onClick={() => onOpen(file, idx)}
      aria-label={`在一般檢視開啟 ${variantName(file)} 第 ${idx + 1} 天`}
    >
      <span className="cmp-day-title">
        <b>Day {idx + 1}</b>
        {date && <small className="muted"> {dateLabel(date)}</small>}
        {diff.differs && <em className="cmp-badge">不同</em>}
      </span>
      <span className={`cmp-name${diff.title ? ' diff' : ''}`}>{stats.title || '（未命名）'}</span>
      <span className="cmp-nums">
        <span className={diff.pois ? 'diff' : ''}>景點 {stats.pois}</span>
        <span className={diff.timedMinutes ? 'diff' : ''}>行程 {formatMinutes(stats.timedMinutes)}</span>
        <span className={diff.transitLegs ? 'diff' : ''}>交通 {stats.transitLegs} 段</span>
      </span>
      <span className={`cmp-hotel${diff.hotel ? ' diff' : ''}`}>住：{stats.hotel ?? '—'}</span>
      {mine.length > 0 && <span className="cmp-only">僅此方案：{mine.join('、')}</span>}
    </button>
  );
}

export function CompareView({ entry, left, right, onPick, onOpen }: Props) {
  const lf = entry.files.find((f) => f.file === left) ?? entry.files[0];
  const rf = entry.files.find((f) => f.file === right) ?? entry.files[1] ?? entry.files[0];
  const ls = useMemo(() => (lf ? tripDayStats(lf.trip) : []), [lf]);
  const rs = useMemo(() => (rf ? tripDayStats(rf.trip) : []), [rf]);
  const lm = useMemo(() => (lf ? tripMetrics(lf.trip) : null), [lf]);
  const rm = useMemo(() => (rf ? tripMetrics(rf.trip) : null), [rf]);
  if (!lf || !rf || !lm || !rm) return null;
  const rows = Math.max(ls.length, rs.length);
  const diffCount = Array.from({ length: rows }, (_, i) => diffDay(ls[i], rs[i]).differs).filter(Boolean).length;

  const picker = (side: 'left' | 'right', value: string) => (
    <label className="cmp-pick">
      <span className="sr-only">{side === 'left' ? '左側方案' : '右側方案'}</span>
      <select value={value} onChange={(e) => onPick(side, e.target.value)} aria-label={side === 'left' ? '左側方案' : '右側方案'}>
        {entry.files.map((f) => (
          <option key={f.file} value={f.file}>
            {variantName(f.file)}（{f.file}）
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <section className="compare" aria-label="方案並排比較">
      <p className="cmp-summary" role="status">
        共 {rows} 天，{diffCount === 0 ? '兩個方案的每一天都相同' : `${diffCount} 天內容不同（標示「不同」）`}。點選某一天可在一般檢視開啟。
      </p>
      <div className="cmp-grid">
        {picker('left', lf.file)}
        {picker('right', rf.file)}
        <Metrics m={lm} other={rm} />
        <Metrics m={rm} other={lm} />
        {Array.from({ length: rows }, (_, i) => {
          const a = ls[i];
          const b = rs[i];
          const diff = diffDay(a, b);
          return (
            <div key={i} className="cmp-row" role="group" aria-label={`第 ${i + 1} 天`}>
              <DayCell file={lf.file} idx={i} stats={a} diff={diff} mine={diff.onlyA} date={lf.trip.days[i]?.date} onOpen={onOpen} />
              <DayCell file={rf.file} idx={i} stats={b} diff={diff} mine={diff.onlyB} date={rf.trip.days[i]?.date} onOpen={onOpen} />
            </div>
          );
        })}
      </div>
    </section>
  );
}
