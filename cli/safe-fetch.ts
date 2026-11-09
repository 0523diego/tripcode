// A fetch for public web pages and pictures that the tool follows on someone's say-so (an address the AI found). It will not
// reach into the user's own machine or network: https only, no address that is private, loopback or link-local (checked on the
// name's real addresses, and again after every redirect), a size cap, a time cap, no cookies, no credentials in the address.
// Best effort, not a sandbox: a name could still change its answer between the check and the request, so what comes back is
// only ever parsed for one picture address or checked as a picture, never shown to the AI or run.
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class SafeFetchError extends Error {}

/** True for an address a public site never has: this machine, the local network, link-local, carrier NAT, multicast, reserved. */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 0) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    if (mapped) return isPrivateAddress(mapped[1]!);
    if (x === '::' || x === '::1') return true;
    const first = parseInt(x.split(':')[0] || '0', 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;
  }
  return true;
}

export interface SafeFetchDeps {
  fetch?: (url: string, init: { redirect: 'manual'; signal: AbortSignal; headers: Record<string, string> }) => Promise<Response>;
  lookup?: (host: string) => Promise<string[]>;
}

const defaultLookup = async (host: string): Promise<string[]> => (await dnsLookup(host, { all: true })).map((a) => a.address);

async function checkUrl(raw: string, lookup: NonNullable<SafeFetchDeps['lookup']>): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SafeFetchError('網址不合法');
  }
  if (url.protocol !== 'https:') throw new SafeFetchError('只能用 https 網址');
  if (url.username || url.password) throw new SafeFetchError('網址不能帶帳號密碼');
  if (url.port && url.port !== '443') throw new SafeFetchError('只能用標準的 https 連接埠');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || (!host.includes('.') && !isIP(host))) throw new SafeFetchError('不能連到本機或內部網路的位址');
  const addresses = isIP(host) ? [host] : await lookup(host).catch(() => []);
  if (addresses.length === 0) throw new SafeFetchError('找不到這個網站');
  if (addresses.some(isPrivateAddress)) throw new SafeFetchError('不能連到本機或內部網路的位址');
  return url;
}

export interface PublicResponse {
  /** The address after redirects. */
  url: string;
  contentType: string;
  bytes: Uint8Array;
}

export async function fetchPublicHttps(raw: string, opts: { maxBytes: number; accept: string; userAgent: string; timeoutMs?: number }, deps: SafeFetchDeps = {}): Promise<PublicResponse> {
  const doFetch = deps.fetch ?? ((u, init) => fetch(u, init));
  const lookup = deps.lookup ?? defaultLookup;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 12_000);
  let current = raw;
  for (let hop = 0; hop <= 3; hop++) {
    const url = await checkUrl(current, lookup);
    const res = await doFetch(url.toString(), { redirect: 'manual', signal, headers: { accept: opts.accept, 'user-agent': opts.userAgent } }).catch((e: unknown) => {
      throw new SafeFetchError(`連不上：${e instanceof Error ? e.message : String(e)}`);
    });
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get('location');
      if (!next) throw new SafeFetchError('轉址沒有目的地');
      current = new URL(next, url).toString();
      continue;
    }
    if (!res.ok) throw new SafeFetchError(`對方回應 ${res.status}`);
    const declared = Number(res.headers.get('content-length'));
    if (declared > opts.maxBytes) throw new SafeFetchError('檔案太大');
    const reader = res.body?.getReader();
    if (!reader) throw new SafeFetchError('對方沒有回內容');
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > opts.maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new SafeFetchError('檔案太大');
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.length;
    }
    return { url: url.toString(), contentType: res.headers.get('content-type') ?? '', bytes };
  }
  throw new SafeFetchError('轉址太多次');
}
