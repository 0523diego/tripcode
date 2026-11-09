// Reads the "Eat" section of an English Wikivoyage page through the MediaWiki API (https://en.wikivoyage.org/w/api.php).
// Network, clock and sleep are injected so tests never touch the network. Polite use: a descriptive User-Agent, at most one request
// a second (shared with the OSM throttle), two requests per page, and only when the user asks. Wikivoyage text is CC BY-SA 4.0:
// we keep names and a link, never the prose (see src/core/wikivoyage-food.ts).
import { CliError } from './context.ts';
import type { FetchLike } from './google.ts';
import { Throttle } from './osm.ts';

// One throttle for the whole process: the dev server makes a new request per click, and they must still be a second apart.
const sharedThrottle = new Throttle();
const API = 'https://en.wikivoyage.org/w/api.php';
const PAGE_RE = /^[\p{L}\p{N} _,.'()\-/]{1,80}$/u;
const MAX_CHARS = 1_500_000;

export interface EatSection {
  title: string;
  /** https://en.wikivoyage.org/wiki/<Title> */
  url: string;
  /** The revision the text came from, so the dish list can say which version of the page it read. */
  revision: string;
  wikitext: string;
}

async function getJson(url: string, opts: { fetch: FetchLike; userAgent: string; throttle: Throttle }): Promise<Record<string, any>> { // eslint-disable-line @typescript-eslint/no-explicit-any
  await opts.throttle.wait();
  let res: Response;
  try {
    res = await opts.fetch(url, { headers: { 'user-agent': opts.userAgent, accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new CliError('連不上 Wikivoyage，請檢查網路');
  }
  if (!res.ok) throw new CliError(`Wikivoyage 回了 HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_CHARS) throw new CliError('Wikivoyage 回的內容比預期大很多，已中止');
  try {
    return JSON.parse(text) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  } catch {
    throw new CliError('Wikivoyage 回的不是 JSON');
  }
}

export async function fetchEatSection(page: string, opts: { fetch: FetchLike; userAgent: string; throttle?: Throttle }): Promise<EatSection> {
  const title = page.trim();
  if (!PAGE_RE.test(title)) throw new CliError('頁面名稱只能是英文 Wikivoyage 的頁面標題（例如 Rome、Osaka、Rome/Colosseo）');
  const o = { fetch: opts.fetch, userAgent: opts.userAgent, throttle: opts.throttle ?? sharedThrottle };
  const base = `${API}?action=parse&page=${encodeURIComponent(title)}&redirects=1&format=json&formatversion=2`;

  const sections = await getJson(`${base}&prop=sections`, o);
  if (sections.error) throw new CliError(`Wikivoyage 找不到頁面「${title}」`);
  const list = Array.isArray(sections.parse?.sections) ? (sections.parse.sections as { line?: string; level?: string; index?: string }[]) : [];
  const eat = list.find((s) => s.level === '2' && s.line === 'Eat');
  if (!eat?.index || !/^\d+$/.test(eat.index)) throw new CliError(`「${title}」這一頁沒有 Eat 段（城市的分區頁才有；試試分區，例如 ${title}/<分區>）`);

  const data = await getJson(`${base}&prop=wikitext%7Crevid&section=${eat.index}`, o);
  const parsed = data.parse;
  if (!parsed || typeof parsed.wikitext !== 'string' || typeof parsed.title !== 'string') throw new CliError('Wikivoyage 的回應格式不對');
  return {
    title: parsed.title,
    url: `https://en.wikivoyage.org/wiki/${encodeURIComponent(parsed.title.replace(/ /g, '_')).replace(/%2F/g, '/')}`,
    revision: String(parsed.revid ?? ''),
    wikitext: parsed.wikitext,
  };
}
