// Renders a PrintDocument (print-model.ts). Used for the hidden print layer today and for the live preview of the print page.
// The @page rules (paper size, running header and footer, one named page per day so a day's continuation sheet repeats its
// heading) are generated here because they depend on the options.
import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { loadTicketPages } from './ticket-pages.ts';
import type { TicketPagesResult } from './ticket-pages.ts';
import type { BookingsSection, CandidatesSection, CoverSection, DaySection, LegRow, NotesSection, PrintDocument, StopRow, TicketRef, TicketsSection } from './print-model.ts';

const cssString = (s: string) => `"${s.replace(/[\\"]/g, '\\$&').replace(/[\r\n]+/g, ' ')}"`;

/** The @page rules for a document. Compact density does not name pages: a named page forces a sheet break. */
export function pageStyles(doc: PrintDocument): string {
  const size = doc.paper === 'Letter' ? 'letter' : 'A4';
  const box = 'font: 7.5pt/1.2 "PingFang TC","Heiti TC","Microsoft JhengHei","Noto Sans CJK TC",sans-serif; color: #555;';
  const rules = [
    `@page { size: ${size}; margin: 15mm 12mm 14mm;`,
    `  @top-left { content: ${cssString(doc.title)}; ${box} }`,
    `  @bottom-left { content: ${cssString(`TripCode · 列印於 ${doc.printedOn} · 時間與預約以官方資訊為準`)}; ${box} }`,
    `  @bottom-right { content: counter(page) " / " counter(pages); ${box} }`,
    '}',
  ];
  if (doc.density !== 'compact') {
    for (const s of doc.sections) {
      if (s.kind === 'day') rules.push(`@page d${s.dayNo} { @top-right { content: ${cssString(`Day ${s.dayNo} · ${s.dateLabel}`)}; ${box} } }`);
    }
  }
  return rules.join('\n');
}

function Row({ row }: { row: StopRow | LegRow }) {
  if (row.kind === 'leg') {
    return (
      <div className="pd-leg">
        <span />
        <span>
          ↓ {row.mode}
          {row.travel && ` · ${row.travel}`} · {row.title}
          {row.note && <span className="pd-note"> {row.note}</span>}
        </span>
      </div>
    );
  }
  return (
    <div className={`pd-row${row.status === '已訂' || row.status === '已確定' ? ' fixed' : ''}`}>
      <span className="pd-time">
        {row.arriveOnly ? `抵 ${row.end}` : row.start}
        {row.start && row.end && <span className="pd-until">–{row.end}</span>}
      </span>
      <span className="pd-body">
        <span className="pd-titleline">
          <b className="pd-name">{row.title}</b>
          <small className="pd-kind">
            {row.kindLabel}
            {row.meta.map((m) => ` · ${m}`).join('')}
          </small>
        </span>
        {row.note && <span className="pd-note">{row.note}</span>}
        {row.tickets.length > 0 && <span className="pd-note">票券：{row.tickets.join('、')}（印在最後的票券頁）</span>}
      </span>
      <span className="pd-status">{row.status}</span>
    </div>
  );
}

function DayPage({ day, named }: { day: DaySection; named: boolean }) {
  const [first, second, ...rest] = day.rows;
  const lead = [first, second].filter((r): r is StopRow | LegRow => !!r);
  return (
    <section
      className="pd-day"
      data-break={day.breakBefore ? 'true' : 'false'}
      data-keep={day.keepTogether ? 'true' : 'false'}
      style={{ '--pd-color': `var(--print-day-${day.color})`, ...(named ? { page: `d${day.dayNo}` } : {}) } as CSSProperties}
    >
      <div className="pd-keep">
        <header className="pd-dayhead">
          <div className="pd-daymark" aria-hidden="true">
            <span className="pd-dayno">{day.dayNo}</span>
            <small>DAY</small>
          </div>
          <div className="pd-daymeta">
            <h2>
              Day {day.dayNo} · {day.dateLabel}
            </h2>
            {day.title && <p className="pd-daytitle">{day.title}</p>}
            {day.weatherClear && <p className="pd-weather">需要好天氣，可與其他天對調</p>}
          </div>
          {day.sleep && (
            <div className="pd-sleep">
              <span className="pd-sleeptext">
                <small>{day.sleep.label}</small>
                <b>{day.sleep.title}</b>
              </span>
            </div>
          )}
        </header>
        {lead.map((r) => (
          <Row key={r.itemId} row={r} />
        ))}
      </div>
      {rest.map((r) => (
        <Row key={r.itemId} row={r} />
      ))}
      {day.rows.length === 0 && <p className="pd-empty">這天還沒有安排。</p>}
    </section>
  );
}

const colorOf = (slot: number): CSSProperties => ({ '--pd-color': `var(--print-day-${slot})` }) as CSSProperties;

function CoverPage({ cover }: { cover: CoverSection }) {
  return (
    <section className="pd-cover">
      <header className="pd-covermeta">
        <h1>{cover.title}</h1>
        <p>{cover.dateLine}</p>
      </header>

      <h2 className="pd-h">行程總覽</h2>
      <table className="pd-glance">
        <tbody>
          {cover.glance.map((g) => (
            <tr key={g.dayNo} style={colorOf(g.color)}>
              <th scope="row">
                <span className="pd-glancebar" />
                {g.dayNo}
              </th>
              <td className="pd-glancedate">{g.dateLabel}</td>
              <td>
                <b>{g.title ?? ''}</b>
                {g.fixed.length > 0 && <span className="pd-glancefixed">{g.fixed.map((f) => `${f.time} ${f.title}`).join('　')}</span>}
              </td>
              <td className="pd-glancesleep">{g.sleep ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {cover.stays.length > 0 && (
        <>
          <h2 className="pd-h">住宿</h2>
          <div className="pd-stays">
            {cover.stays.map((s) => (
              <div key={s.itemId} className="pd-stay" style={colorOf(s.color)}>
                <div className="pd-staytext">
                  <small>
                    {s.checkIn} 入住 → {s.checkOut} 退房 · {s.nights} 晚
                  </small>
                  <b>{s.title}</b>
                  <span className="pd-ref">訂位編號 {s.bookingRef ?? <i className="pd-blank" />}</span>
                  {s.note && <span className="pd-note">{s.note}</span>}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {cover.transport.length > 0 && (
        <>
          <h2 className="pd-h">航班與長途交通</h2>
          <table className="pd-table">
            <tbody>
              {cover.transport.map((t, i) => (
                <tr key={i}>
                  <td className="pd-nowrap">{t.date}</td>
                  <td className="pd-nowrap">{t.time ?? ''}</td>
                  <td>{t.title}</td>
                  <td className="pd-nowrap">{t.code ?? ''}</td>
                  <td className="pd-nowrap">訂位編號 {t.bookingRef ?? <i className="pd-blank" />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {cover.urgent.length > 0 && (
        <>
          <h2 className="pd-h">出發前要先處理</h2>
          <ul className="pd-urgent">
            {cover.urgent.map((u) => (
              <li key={u.title}>
                <b>{u.title}</b> <span>{u.why}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function BookingsPage({ bookings }: { bookings: BookingsSection }) {
  return (
    <section className="pd-closing">
      <h2 className="pd-h">訂票與票券</h2>
      <table className="pd-table pd-bookings">
        <thead>
          <tr>
            <th>日期</th>
            <th>項目</th>
            <th>狀態</th>
            <th>購買處</th>
            <th>票券</th>
            <th>期限與取消</th>
          </tr>
        </thead>
        <tbody>
          {bookings.rows.map((r, i) => (
            <tr key={i}>
              <td className="pd-nowrap">{r.date}</td>
              <td>
                <b>{r.title}</b> <small>{r.category}</small>
              </td>
              <td className="pd-nowrap">
                <b>{r.status}</b>
              </td>
              <td>{r.via ?? ''}</td>
              <td>{r.voucher ? '有' : ''}</td>
              <td className="pd-small">{[r.opensOn ? `開賣 ${r.opensOn}` : '', r.deadlineOn ? `期限 ${r.deadlineOn}` : '', r.cancellation ?? ''].filter(Boolean).join('；')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function CandidatesPage({ candidates }: { candidates: CandidatesSection }) {
  return (
    <section className="pd-closing">
      <h2 className="pd-h">候選景點（還沒排進行程）</h2>
      <ul className="pd-cands">
        {candidates.items.map((c) => (
          <li key={c.title}>
            <span className="pd-candtext">
              <b>{c.title}</b>
              <small>
                {c.status}
                {c.day ? ` · 第 ${c.day} 天` : ''}
              </small>
              {c.why && <span className="pd-note">{c.why}</span>}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** One ticket file, shown the way the file shows it: the picture itself, or the pages of the PDF. */
function TicketFigure({ tripId, t, first }: { tripId: string; t: TicketRef; first: boolean }) {
  const [state, setState] = useState<{ status: 'loading' } | { status: 'error'; error: string } | { status: 'ready'; result: TicketPagesResult }>({ status: 'loading' });
  useEffect(() => {
    if (t.how !== 'convert') return;
    let live = true;
    void loadTicketPages(tripId, t.file).then((r) => {
      if (live) setState(r.ok ? { status: 'ready', result: r } : { status: 'error', error: r.error });
    });
    return () => {
      live = false;
    };
  }, [tripId, t.file, t.how]);

  const caption = (
    <figcaption className="pd-ticketcap">
      <b>
        Day {t.dayNo} · {t.dateLabel}
      </b>{' '}
      {t.itemTitle} — {t.label}
    </figcaption>
  );
  const sources: string[] = t.how === 'image' ? [`/trips/${tripId}/${t.file}`] : state.status === 'ready' ? state.result.pages.map((p) => `data:${p.mime};base64,${p.dataBase64}`) : [];
  return (
    <>
      {sources.map((src, i) => (
        <figure key={i} className="pd-ticket" data-first={first && i === 0 ? 'true' : 'false'}>
          {caption}
          <img className="pd-ticketimg" src={src} alt={`${t.itemTitle} ${t.label}${sources.length > 1 ? `（第 ${i + 1} 頁）` : ''}`} />
          {t.how === 'convert' && state.status === 'ready' && i === sources.length - 1 && (state.result.more || state.result.firstPageOnly) && (
            <p className="pd-note">{state.result.firstPageOnly ? '這台電腦只能轉出這個檔案的第一頁；其餘頁請另外列印原檔。' : `只印前 ${sources.length} 頁；其餘頁請另外列印原檔。`}</p>
          )}
        </figure>
      ))}
      {t.how === 'convert' && state.status === 'loading' && (
        <figure className="pd-ticket" data-first={first ? 'true' : 'false'}>
          {caption}
          <p className="pd-note">正在把這個檔案轉成可以列印的圖片…</p>
        </figure>
      )}
      {t.how === 'convert' && state.status === 'error' && (
        <figure className="pd-ticket" data-first={first ? 'true' : 'false'}>
          {caption}
          <p className="pd-note pd-ticketerr">這個檔案沒辦法轉成圖片（{state.error}）。請另外列印原檔：trips/{tripId}/{t.file}</p>
        </figure>
      )}
    </>
  );
}

function TicketsPage({ tickets }: { tickets: TicketsSection }) {
  return (
    <section className="pd-tickets">
      <h2 className="pd-h">票券：照你附的檔案原樣印出（QR 碼在票上，直接給人員掃）</h2>
      {tickets.items.map((t, i) => (
        <TicketFigure key={t.file} tripId={tickets.tripId} t={t} first={i === 0} />
      ))}
      {tickets.skipped.length > 0 && (
        <p className="pd-note pd-ticketskip">
          這些附件不是圖片或 PDF，沒辦法印在這裡，請另外列印：{tickets.skipped.map((k) => `Day ${k.dayNo} ${k.itemTitle}「${k.label}」`).join('、')}
        </p>
      )}
    </section>
  );
}

function NotesPage({ notes }: { notes: NotesSection }) {
  return (
    <section className="pd-closing pd-notes">
      <h2 className="pd-h">出發前自己填</h2>
      <ul className="pd-writeins">
        {notes.writeIns.map((w) => (
          <li key={w}>
            <span>{w}</span>
            <i className="pd-blank wide" />
          </li>
        ))}
      </ul>
      <h2 className="pd-h">筆記</h2>
      <div className="pd-lines">
        {Array.from({ length: notes.lines }, (_, i) => (
          <i key={i} />
        ))}
      </div>
    </section>
  );
}

export function PrintDocumentView({ doc }: { doc: PrintDocument }) {
  return (
    <div className="pdoc" data-density={doc.density} data-paper={doc.paper}>
      <style>{pageStyles(doc)}</style>
      {doc.sections.map((s) => {
        switch (s.kind) {
          case 'cover':
            return <CoverPage key="cover" cover={s} />;
          case 'day':
            return <DayPage key={s.date} day={s} named={doc.density !== 'compact'} />;
          case 'tickets':
            return <TicketsPage key="tickets" tickets={s} />;
          case 'bookings':
            return <BookingsPage key="bookings" bookings={s} />;
          case 'candidates':
            return <CandidatesPage key="candidates" candidates={s} />;
          case 'notes':
            return <NotesPage key="notes" notes={s} />;
        }
      })}
    </div>
  );
}
