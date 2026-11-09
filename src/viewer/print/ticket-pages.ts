// Fetches the printable pages of a ticket PDF / HEIC from the dev server (cli/ticket-render.ts) and remembers them for
// the life of the page, so the preview, the page count and the print dialog all share one conversion.
import { post } from '../api.ts';

export interface TicketPagesResult {
  ok: true;
  pages: { mime: 'image/png'; dataBase64: string }[];
  more: boolean;
  firstPageOnly: boolean;
}
export type TicketPagesOutcome = TicketPagesResult | { ok: false; error: string };

const cache = new Map<string, Promise<TicketPagesOutcome>>();

export function loadTicketPages(tripId: string, file: string): Promise<TicketPagesOutcome> {
  const key = `${tripId}/${file}`;
  let hit = cache.get(key);
  if (!hit) {
    hit = post('ticket-image', { tripId, attachmentFile: file }).then((r): TicketPagesOutcome => {
      const data = r as unknown as Partial<TicketPagesResult>;
      if (r.ok && Array.isArray(data.pages)) return { ok: true, pages: data.pages, more: !!data.more, firstPageOnly: !!data.firstPageOnly };
      // A failure is not remembered: the next look (or a retry after installing a tool) tries again.
      cache.delete(key);
      return { ok: false, error: r.error ?? '轉換失敗' };
    });
    cache.set(key, hit);
  }
  return hit;
}

/** Resolves when every conversion started so far has finished (the print button waits for this). */
export async function ticketsReady(): Promise<void> {
  await Promise.all([...cache.values()]);
}
