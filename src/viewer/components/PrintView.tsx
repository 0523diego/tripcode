// Print layout (列印行程). Hidden on screen, shown by @media print.
//
// Paper is the one copy of the plan that never runs out of battery, so this view is written for
// someone standing on a street corner, not for someone reading at a desk: every located stop
// carries a QR that opens it in a phone map, the stay for each day is repeated in the day header,
// and booking references sit on the first page where they can be found in a hurry.
//
// Three things are deliberately absent. A printed URL cannot be typed in at a street corner, so
// every link is a QR code instead. A route drawing with no streets and no usable scale cannot be
// navigated, so there is no printed map. And there is no whole-day route code either: what you
// need on the pavement is the next stop, which each row already carries, and a code holding ten
// waypoints needs 26mm of every day's header to stay scannable.
import { useMemo } from 'react';
import type { Candidate, Day, Item, Trip } from '../../core/types.ts';
import type { EcLevel } from '../../core/qr.ts';
import { qrMatrix, qrPath } from '../../core/qr.ts';
import { KIND_LABEL, STATUS_LABEL, dateLabel } from '../model.ts';
import { MODE_LABEL, duration, transitText, transitTime } from '../travel.ts';

/** Five decimals is about a metre — more digits only make the QR denser. */
const coord = (p: { lat: number; lng: number }) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;

const placeUrl = (p: { lat: number; lng: number }) => `https://maps.google.com/?q=${coord(p)}`;

function Qr({ text, mm, level = 'M', label }: { text: string; mm: number; level?: EcLevel; label: string }) {
  const matrix = useMemo(() => {
    try {
      return qrMatrix(text, level);
    } catch {
      return null; // too long to encode: the page simply shows no code
    }
  }, [text, level]);
  if (!matrix) return null;
  // Two modules of quiet zone rather than the four the spec asks for: the printed page is white
  // all around the code anyway, and four would spend a fifth of the width on nothing, pushing the
  // modules below the ~0.45mm a phone camera needs to read them off paper.
  const span = matrix.length + 4;
  return (
    <svg
      className="qr"
      viewBox={`-2 -2 ${span} ${span}`}
      style={{ width: `${mm}mm`, height: `${mm}mm` }}
      shapeRendering="crispEdges"
      role="img"
      aria-label={label}
    >
      <rect x={-2} y={-2} width={span} height={span} fill="#fff" />
      <path d={qrPath(matrix)} fill="#000" />
    </svg>
  );
}

/** Which hotel covers each date, so every day header can repeat where you sleep that night. */
function stayByDate(trip: Trip): Map<string, Item> {
  const out = new Map<string, Item>();
  trip.days.forEach((day, i) => {
    for (const it of day.items) {
      if (it.kind !== 'hotel') continue;
      for (let n = 0; n < Math.max(1, it.nights); n++) {
        const covered = trip.days[i + n];
        if (covered) out.set(covered.date, it);
      }
    }
  });
  return out;
}

function timeText(it: Item): string {
  if (it.start && it.end) return `${it.start}–${it.end}`;
  if (it.start) return it.start;
  return it.end ? `抵 ${it.end}` : '';
}

/** Start and end on two lines: a range on one line needs 18mm of column that the stops want. */
function Time({ item }: { item: Item }) {
  if (item.start && item.end) {
    return (
      <span className="pd-time">
        {item.start}
        <span className="pd-until">–{item.end}</span>
      </span>
    );
  }
  return <span className="pd-time">{timeText(item)}</span>;
}

/** Stay length or visit length, when it is known. */
function lengthText(it: Item): string | null {
  if (it.kind === 'hotel') return `${it.nights} 晚`;
  if (it.kind === 'poi' && it.minutes) return duration(it.minutes);
  return null;
}

function PrintDay({ day, index, stay }: { day: Day; index: number; stay: Item | undefined }) {
  // Stop numbers run in visiting order, matching the circled numbers in the list.
  let n = 0;
  const numbers = new Map<string, number>();
  for (const it of day.items) {
    if (it.kind === 'transit' || !it.loc) continue;
    numbers.set(it.id, ++n);
  }
  return (
    <section className="print-day">
      <header className="pd-head">
        <div className="pd-when">
          <h2>
            Day {index + 1} · {dateLabel(day.date)}
          </h2>
          {day.title && <p className="pd-title">{day.title}</p>}
          {stay && <p className="pd-stay">住 {stay.title}</p>}
          {day.weather === 'clear' && <p className="pd-weather">需要好天氣，可與其他天對調</p>}
        </div>
      </header>
      <ol className="pd-items">
        {day.items.map((it, i) => {
          if (it.kind === 'transit') {
            const text = transitText(transitTime(day.items, i));
            return (
              <li key={it.id} className="pd-leg">
                <span className="pd-time" />
                <span className="pd-leg-body">
                  ↓ {MODE_LABEL[it.mode] ?? it.mode}
                  {text && ` · ${text}`} · {it.title}
                  {it.note && <span className="pd-note"> {it.note}</span>}
                </span>
                <span />
              </li>
            );
          }
          const no = numbers.get(it.id);
          const len = lengthText(it);
          return (
            <li key={it.id} className={`pd-stop${it.locked ? ' locked' : ''}`}>
              <Time item={it} />
              <span className="pd-body">
                <span className="pd-title-line">
                  {no !== undefined && <b className="pd-no">{no}</b>}
                  <b className="pd-name">{it.title}</b>
                  <small>
                    {KIND_LABEL[it.kind]}
                    {len ? ` · ${len}` : ''}
                    {it.kind === 'flight' && it.flightNo ? ` · ${it.flightNo}` : ''}
                    {it.locked ? ' · 已確定' : ''}
                  </small>
                </span>
                {it.note && <span className="pd-note">{it.note}</span>}
                {it.attachments && it.attachments.length > 0 && (
                  <span className="pd-att">票券：{it.attachments.map((a) => a.label).join('、')}</span>
                )}
              </span>
              <span className="pd-qr">{it.loc && <Qr text={placeUrl(it.loc)} mm={15} label={`${it.title} 的位置`} />}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** Hotels and booked transport, with their references — the page you look at when something goes wrong. */
function KeyFacts({ trip }: { trip: Trip }) {
  const rows: { item: Item; when: string; ref?: string }[] = [];
  const seen = new Set<string>();
  trip.days.forEach((day, i) => {
    for (const it of day.items) {
      if (seen.has(it.id)) continue;
      if (it.kind === 'hotel') {
        const out = trip.days[i + Math.max(1, it.nights)];
        seen.add(it.id);
        rows.push({
          item: it,
          when: `${dateLabel(day.date)} – ${out ? dateLabel(out.date) : dateLabel(trip.end)}`,
          ref: it.bookingRef,
        });
      } else if (it.kind === 'flight' || (it.locked && it.kind !== 'poi' && it.kind !== 'meal' && it.kind !== 'free')) {
        seen.add(it.id);
        rows.push({
          item: it,
          when: `${dateLabel(day.date)}${timeText(it) ? ` ${timeText(it)}` : ''}`,
          ref: it.kind === 'flight' ? it.bookingRef : undefined,
        });
      }
    }
  });
  if (rows.length === 0) return null;
  return (
    <section className="print-keys">
      <h2>住宿與已訂項目</h2>
      <ul>
        {rows.map(({ item, when, ref }) => (
          <li key={item.id}>
            <span className="pk-qr">{item.loc && <Qr text={placeUrl(item.loc)} mm={16} label={`${item.title} 的位置`} />}</span>
            <span className="pk-body">
              <b>{item.title}</b>
              <span className="pk-when">
                {when}
                {item.kind === 'flight' && item.flightNo ? ` · ${item.flightNo}` : ''}
                {ref ? ` · 訂位 ${ref}` : ''}
              </span>
              {item.note && <span className="pd-note">{item.note}</span>}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Candidates({ candidates }: { candidates: Candidate[] }) {
  const open = candidates.filter((c) => c.status !== 'rejected');
  if (open.length === 0) return null;
  return (
    <section className="print-cands">
      <h2>候選景點（還沒排進行程）</h2>
      <ul>
        {open.map((c) => (
          <li key={c.id}>
            <span className="pk-qr">{c.loc && <Qr text={placeUrl(c.loc)} mm={15} label={`${c.title} 的位置`} />}</span>
            <span className="pk-body">
              <b>{c.title}</b>
              <span className="pk-when">
                {STATUS_LABEL[c.status]}
                {c.status === 'accepted' && c.day ? ` · 第 ${c.day} 天` : ''}
              </span>
              {c.why && <span className="pd-note">{c.why}</span>}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function PrintView({ trip, fileLabel }: { trip: Trip; fileLabel: string }) {
  const stays = useMemo(() => stayByDate(trip), [trip]);
  const party = `${trip.party.adults} 位成人${trip.party.childrenAges.length > 0 ? `、${trip.party.childrenAges.length} 位孩童（${trip.party.childrenAges.join('、')} 歲）` : ''}`;
  return (
    <div className="print-root" aria-hidden="true">
      <header className="print-head">
        <h1>{trip.title}</h1>
        <p className="print-meta">
          {trip.start} ~ {trip.end} · {trip.days.length} 天 · {party} · 時區 {trip.tz} · {fileLabel}
        </p>
        <p className="print-hint">方框是 QR：用手機相機掃描可在地圖開啟該地點。路線為直線示意，不是實際路徑。</p>
      </header>
      <KeyFacts trip={trip} />
      {trip.days.map((d, i) => (
        <PrintDay key={d.date} day={d} index={i} stay={stays.get(d.date)} />
      ))}
      <Candidates candidates={trip.candidates} />
    </div>
  );
}
