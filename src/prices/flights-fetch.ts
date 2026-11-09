// The one place TripCode talks to Google Flights. A plain GET of the public search page, with the limits that keep it
// safe and polite: https to two Google hosts only (a redirect anywhere else stops the request), no cookies sent or kept,
// a hard cap on time and size, and a clear error, never a guess, for every way Google can say no.
//
// The user agent is a real Chrome string followed by `tripcode/0.1`: with an honest-only string Google sends the
// request to its "unsupported browser" page and returns no prices (tested 2026-11-07). Nothing else about a browser is
// imitated: no TLS fingerprint, no consent cookie. Google's consent step is followed as Google presents it.

export type FlightsFetchCode =
  | 'unsupported-client'
  | 'blocked'
  | 'consent-required'
  | 'redirect-offsite'
  | 'timeout'
  | 'too-large'
  | 'http'
  | 'network'
  | 'no-data'
  | 'breaker-open';

export class FlightsFetchError extends Error {
  readonly code: FlightsFetchCode;
  constructor(code: FlightsFetchCode, message: string) {
    super(message);
    this.name = 'FlightsFetchError';
    this.code = code;
  }
}

export const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 tripcode/0.1';
export const ALLOWED_HOSTS = ['www.google.com', 'consent.google.com'] as const;
export const MAX_BODY_BYTES = 5 * 1024 * 1024;
export const REQUEST_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

export type FetchFn = (url: string, init: { headers: Record<string, string>; redirect: 'manual'; signal: AbortSignal }) => Promise<Response>;

function checkTarget(url: URL): void {
  if (url.protocol !== 'https:' || !(ALLOWED_HOSTS as readonly string[]).includes(url.hostname) || url.port !== '') {
    throw new FlightsFetchError('redirect-offsite', `Google 把請求轉到了不允許的地址（${url.hostname}），已中止`);
  }
}

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new FlightsFetchError('too-large', `頁面超過 ${MAX_BODY_BYTES / 1024 / 1024} MB，已中止`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Fetches a search-page URL and returns its HTML. Throws FlightsFetchError. */
export async function fetchPage(startUrl: string, fetchFn: FetchFn = fetch as unknown as FetchFn): Promise<string> {
  let url = new URL(startUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    checkTarget(url);
    let res: Response;
    try {
      res = await fetchFn(url.toString(), {
        headers: { 'user-agent': USER_AGENT, 'accept-language': 'en-US,en;q=0.9', accept: 'text/html,application/xhtml+xml', 'accept-encoding': 'br, gzip' },
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') throw new FlightsFetchError('timeout', `Google 超過 ${REQUEST_TIMEOUT_MS / 1000} 秒沒有回應`);
      throw new FlightsFetchError('network', '連不上 Google Flights，請檢查網路');
    }
    if (res.status === 429) throw new FlightsFetchError('blocked', 'Google 要求放慢（429）：已暫停查價');
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new FlightsFetchError('http', `Google 回了 ${res.status} 卻沒有指向哪裡`);
      await res.body?.cancel().catch(() => undefined);
      const next = new URL(location, url);
      if (next.pathname.startsWith('/travel/flights/unsupported')) throw new FlightsFetchError('unsupported-client', 'Google 說這個瀏覽器不支援（不再接受這個 User-Agent）');
      if (next.pathname.startsWith('/sorry')) throw new FlightsFetchError('blocked', 'Google 要求驗證你不是機器人：已暫停查價，請改用瀏覽器直接查');
      url = next;
      continue;
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => undefined);
      throw new FlightsFetchError('http', `Google 回了 HTTP ${res.status}`);
    }
    if (url.hostname === 'consent.google.com') {
      await res.body?.cancel().catch(() => undefined);
      throw new FlightsFetchError('consent-required', 'Google 要你先按同意：TripCode 不會替你按。請先在瀏覽器開 Google Flights 完成一次，或改用其他方式');
    }
    return readCapped(res);
  }
  throw new FlightsFetchError('http', 'Google 轉址太多次');
}
