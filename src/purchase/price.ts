// Reads a price (or "can I buy this yet") out of a page's HTML. Only structured, declared data is trusted:
// the user's own regex, JSON-LD offers, product meta tags, itemprop. Anything else is "unreadable" — a price
// is never guessed from loose text (CLAUDE.md: never invent prices).

export interface PriceReading {
  amount: number;
  currency?: string;
  via: 'regex' | 'json-ld' | 'meta' | 'itemprop';
}

const MAX_HTML = 2_000_000;

/** "1,234.56", "1.234,56", "12,50", "120" → number. Undefined when it is not a number. */
export function parseAmount(raw: string): number | undefined {
  const s = raw.replace(/[^\d.,]/g, '');
  if (!/\d/.test(s)) return undefined;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let normalized: string;
  if (lastDot !== -1 && lastComma !== -1) {
    const decimal = lastDot > lastComma ? '.' : ',';
    const thousands = decimal === '.' ? ',' : '.';
    normalized = s.split(thousands).join('').replace(decimal, '.');
  } else if (lastDot !== -1 || lastComma !== -1) {
    const sep = lastDot !== -1 ? '.' : ',';
    const parts = s.split(sep);
    // "1,234" / "1.234.567" read as thousands; "12,5" / "0.50" / "12,50" as decimals.
    const isThousands = parts.length > 2 || (parts.length === 2 && parts[1]!.length === 3 && parts[0]!.length <= 3 && parts[0] !== '0');
    normalized = isThousands ? parts.join('') : parts.join('.');
  } else {
    normalized = s;
  }
  const n = Number(normalized);
  return Number.isFinite(n) ? n : undefined;
}

/** Parsed contents of every `<script type="application/ld+json">` block that is valid JSON. */
export function readJsonLd(html: string): unknown[] {
  const out: unknown[] = [];
  const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.slice(0, MAX_HTML).matchAll(re)) {
    try {
      out.push(JSON.parse(m[1]!.trim()));
    } catch {
      // a broken block is skipped, not fatal
    }
  }
  return out;
}

function walk(node: unknown, visit: (o: Record<string, unknown>) => void, depth = 0): void {
  if (depth > 12 || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) walk(n, visit, depth + 1);
    return;
  }
  const obj = node as Record<string, unknown>;
  visit(obj);
  for (const v of Object.values(obj)) walk(v, visit, depth + 1);
}

function asAmount(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string') return parseAmount(v);
  return undefined;
}

function offersFromJsonLd(html: string): { amount: number; currency?: string; availability?: string }[] {
  const found: { amount: number; currency?: string; availability?: string }[] = [];
  for (const block of readJsonLd(html)) {
    walk(block, (o) => {
      const type = String(o['@type'] ?? '');
      if (!/Offer/i.test(type)) return;
      const amount = asAmount(o.price) ?? asAmount(o.lowPrice);
      const availability = typeof o.availability === 'string' ? o.availability : undefined;
      if (amount === undefined) {
        if (availability) found.push({ amount: NaN, availability });
        return;
      }
      const currency = typeof o.priceCurrency === 'string' ? o.priceCurrency.toUpperCase() : undefined;
      found.push({ amount, currency, availability });
    });
  }
  return found;
}

function metaContent(html: string, names: string[]): string | undefined {
  const tag = /<meta\b[^>]*>/gi;
  for (const m of html.slice(0, MAX_HTML).matchAll(tag)) {
    const t = m[0];
    const key = /\b(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i.exec(t)?.[1]?.toLowerCase();
    if (!key || !names.includes(key)) continue;
    const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(t)?.[1];
    if (content !== undefined) return content;
  }
  return undefined;
}

/** The price a page declares, or undefined when it declares none we can trust. */
export function extractPrice(html: string, opts: { regex?: string } = {}): PriceReading | undefined {
  const text = html.slice(0, MAX_HTML);
  if (opts.regex) {
    const m = new RegExp(opts.regex, 'i').exec(text);
    const amount = m?.[1] !== undefined ? parseAmount(m[1]) : undefined;
    return amount === undefined ? undefined : { amount, via: 'regex' };
  }

  const offers = offersFromJsonLd(text).filter((o) => Number.isFinite(o.amount));
  if (offers.length > 0) {
    // Several offers (variants): the lowest is the "from" price; the user's regex pins a specific one.
    const best = offers.reduce((a, b) => (b.amount < a.amount ? b : a));
    return { amount: best.amount, currency: best.currency, via: 'json-ld' };
  }

  const metaAmount = asAmount(metaContent(text, ['product:price:amount', 'og:price:amount']));
  if (metaAmount !== undefined) {
    const currency = metaContent(text, ['product:price:currency', 'og:price:currency'])?.toUpperCase();
    return { amount: metaAmount, currency, via: 'meta' };
  }

  const prop = asAmount(metaContent(text, ['price']));
  if (prop !== undefined) {
    const currency = metaContent(text, ['pricecurrency'])?.toUpperCase();
    return { amount: prop, currency, via: 'itemprop' };
  }
  return undefined;
}

/** True/false when the page says whether it can be bought; undefined when it does not say. */
export function extractAvailability(html: string, opts: { regex?: string } = {}): boolean | undefined {
  const text = html.slice(0, MAX_HTML);
  if (opts.regex) return new RegExp(opts.regex, 'i').test(text);
  const states = offersFromJsonLd(text).map((o) => o.availability).filter((a): a is string => !!a);
  if (states.some((a) => /InStock|PreOrder|PreSale|LimitedAvailability|OnlineOnly|InStoreOnly/i.test(a))) return true;
  if (states.some((a) => /OutOfStock|SoldOut|Discontinued/i.test(a))) return false;
  return undefined;
}
