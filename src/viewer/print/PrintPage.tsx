// 列印行程 page (#/trip/<id>/print?...): what to print on the left, a live preview on the right, and a button that opens
// the browser's print dialog (choose 「另存為 PDF」 there for a file). The options live in the URL, so a printout can be
// reproduced from a link, and the choices that are about taste (density, QR, paper...) are remembered for next time.
import { useEffect, useMemo, useState } from 'react';
import { go } from '../route.ts';
import { variantName } from '../variant.ts';
import type { TripEntry } from '../trips.ts';
import { dateInTz, todayDayIdx } from '../today.ts';
import { PrintDocumentView } from './PrintDocumentView.tsx';
import { buildPrintDocument } from './print-model.ts';
import type { Density, PrintOptions } from './print-model.ts';
import { ticketsReady } from './ticket-pages.ts';
import { estimatePages, loadPrefs, mergeOptions, parsePrintQuery, printFileTitle, savePrefs, toPrintQuery } from './print-options.ts';

function Choice<T extends string>({ name, value, options, onChange }: { name: string; value: T; options: { value: T; label: string; hint?: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="pp-choices" role="radiogroup" aria-label={name}>
      {options.map((o) => (
        <label key={o.value} className={value === o.value ? 'on' : undefined}>
          <input type="radio" name={name} checked={value === o.value} onChange={() => onChange(o.value)} />
          <span>{o.label}</span>
          {o.hint && <small>{o.hint}</small>}
        </label>
      ))}
    </div>
  );
}

function Check({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="pp-check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
      {hint && <small>{hint}</small>}
    </label>
  );
}

export function PrintPage({ entry, query }: { entry: TripEntry; query: string }) {
  // ?file=variant-b.ts prints that plan; without it, the main one.
  const fileParam = new URLSearchParams(query).get('file');
  const chosen = entry.files.find((f) => f.file === fileParam) ?? entry.files[0];
  const trip = chosen?.trip;
  const variant = chosen && chosen.file !== 'trip.ts' ? variantName(chosen.file) : undefined;
  const [opts, setOpts] = useState<PrintOptions>(() => mergeOptions(loadPrefs(), parsePrintQuery(query)));
  const now = useMemo(() => new Date(), []);
  const todayIdx = useMemo(() => (trip ? todayDayIdx(trip, dateInTz(trip.tz, now)) : null), [trip, now]);
  const doc = useMemo(() => (trip ? buildPrintDocument(trip, opts, { now, todayIdx, tripId: entry.id, ...(variant ? { variant } : {}) }) : null), [trip, opts, now, todayIdx, variant, entry.id]);

  // Keep the address in step with the options without adding a history entry for every click.
  useEffect(() => {
    const q = [toPrintQuery(opts), chosen && chosen.file !== 'trip.ts' ? `file=${chosen.file}` : ''].filter(Boolean).join('&');
    window.history.replaceState(null, '', `#/trip/${entry.id}/print${q ? `?${q}` : ''}`);
  }, [opts, entry.id, chosen]);

  if (!trip || !doc) return <main className="pp-empty">找不到這趟行程。</main>;

  // Functional, so two quick clicks never build on a stale copy of the options.
  const update = (patch: Partial<PrintOptions> | ((o: PrintOptions) => Partial<PrintOptions>)) =>
    setOpts((prev) => {
      const next = { ...prev, ...(typeof patch === 'function' ? patch(prev) : patch) };
      savePrefs(next);
      return next;
    });
  const daysMode = opts.days === 'all' ? 'all' : opts.days === 'from-today' ? 'today' : 'pick';
  const picked = new Set(Array.isArray(opts.days) ? opts.days : []);
  const toggleDay = (n: number) =>
    update((o) => {
      const next = new Set(Array.isArray(o.days) ? o.days : []);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return { days: [...next].sort((a, b) => a - b) };
    });

  const print = async () => {
    // Ticket PDFs are turned into pictures first; printing before they arrive would print an empty ticket page.
    await ticketsReady();
    await new Promise((r) => setTimeout(r, 80));
    await Promise.all([...document.querySelectorAll<HTMLImageElement>('.pd-ticketimg')].map((img) => img.decode().catch(() => undefined)));
    const previous = document.title;
    document.title = printFileTitle(trip, new Date());
    const restore = () => {
      document.title = previous;
      window.removeEventListener('afterprint', restore);
    };
    window.addEventListener('afterprint', restore);
    window.print();
  };

  return (
    <div className="pp">
      <header className="pp-top">
        <button type="button" className="link" onClick={() => go(`/trip/${entry.id}`)}>
          ← 回行程
        </button>
        <h1>列印行程：{trip.title}{variant ? `（${variant}）` : ''}</h1>
      </header>
      <div className="pp-body">
        <aside className="pp-options" aria-label="列印選項">
          <section>
            <h2>要印哪幾天</h2>
            <Choice
              name="days"
              value={daysMode}
              options={[
                { value: 'all', label: '全部' },
                { value: 'today', label: '從今天起', hint: todayIdx === null ? (trip.end < dateInTz(trip.tz, now) ? '旅行已經結束，等於全部' : '還沒開始旅行，等於全部') : undefined },
                { value: 'pick', label: '自己選' },
              ]}
              onChange={(v) => update({ days: v === 'all' ? 'all' : v === 'today' ? 'from-today' : trip.days.map((_, i) => i + 1) })}
            />
            {daysMode === 'pick' && (
              <div className="pp-days">
                {trip.days.map((_, i) => (
                  <button key={i} type="button" className={picked.has(i + 1) ? 'on' : undefined} aria-pressed={picked.has(i + 1)} onClick={() => toggleDay(i + 1)}>
                    {i + 1}
                  </button>
                ))}
              </div>
            )}
          </section>
          <section>
            <h2>內容</h2>
            <Check label="封面總覽" hint="整趟一眼看完、住宿、航班" checked={opts.cover} onChange={(cover) => update({ cover })} />
            <Check label="訂票總表" checked={opts.bookings} onChange={(bookings) => update({ bookings })} />
            <Check label="票券" hint="你附在行程上的門票、車票、訂位確認，連同上面的 QR 碼一起印" checked={opts.tickets} onChange={(tickets) => update({ tickets })} />
            <Check label="候選景點" hint="還沒排進行程的「也許」清單" checked={opts.candidates} onChange={(candidates) => update({ candidates })} />
            <Check label="備註與筆記頁" hint="電話欄位留空給你手寫" checked={opts.notes} onChange={(notes) => update({ notes })} />
          </section>
          <section>
            <h2>字的大小</h2>
            <Choice<Density>
              name="density"
              value={opts.density}
              options={[
                { value: 'compact', label: '精簡', hint: '短的幾天共用一張，頁數最少' },
                { value: 'normal', label: '標準', hint: '一天一張，可以只帶當天那張' },
                { value: 'large', label: '大字', hint: '給需要大字的人' },
              ]}
              onChange={(density) => update({ density })}
            />
          </section>
          <section>
            <h2>紙張</h2>
            <Choice name="paper" value={opts.paper} options={[{ value: 'A4', label: 'A4' }, { value: 'Letter', label: 'Letter' }]} onChange={(paper) => update({ paper })} />
          </section>
          <section className="pp-go">
            <p>
              約 {estimatePages(doc)} 張<small>（實際張數以瀏覽器為準）</small>
            </p>
            <button type="button" className="btn primary" onClick={() => void print()} disabled={doc.sections.length === 0}>
              列印／另存 PDF
            </button>
            <p className="pp-note">在跳出的列印視窗，目的地選「另存為 PDF」就會得到檔案。</p>
          </section>
        </aside>
        <main className="pp-preview" aria-label="預覽">
          {doc.sections.length === 0 ? <p className="pp-empty">沒有選任何內容。</p> : <PrintDocumentView doc={doc} />}
          <p className="pp-previewnote">預覽：每一塊是一張紙的內容，實際分頁以瀏覽器列印為準。</p>
        </main>
      </div>
    </div>
  );
}
