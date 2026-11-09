// Dishes out of a Wikivoyage "Eat" section. Pure: the section's wikitext in, candidates out. Wikivoyage (CC BY-SA 4.0) is the
// best keyless source of "what is this city known for eating": its Eat sections name the local dishes, often with the local
// script. We keep only names, tags we derive from the wording, and a link to the page; the prose itself is never stored.
//
// Three layouts are understood, because that is what the pages use:
//   • a bullet list, optionally inside {{infobox|…}}:   *'''Carciofi alla giudia''' - Artichokes, Jewish style
//   • a bullet list of italics with the local script:   * ''Okonomiyaki'' (お好み焼き), fried cabbage cakes …
//   • bold names in the opening prose:                   Try the '''oyster omelette''' (蚵仔煎 kèzǎijiān) …
// Bold names in prose are only used when no list was found (they are noisier: places get bolded too).
import type { Dish } from './food-types.ts';

export interface DishCandidate {
  /** As the page writes it, e.g. "Bucatini all'amatriciana". */
  name: string;
  /** The local script or spelling when the page gives one: 蚵仔煎, お好み焼き. */
  local?: string;
  /** Tags we derived from the description (pork, seafood, …); the description itself is dropped. */
  tags: string[];
  how: 'list' | 'prose';
}

const CJK = /[぀-ヿ㐀-鿿]/;
const KANA = /[぀-ヿ]/;

/** Wiki markup → plain text. Links keep their label, templates and files go. */
function plain(text: string): string {
  return text
    .replace(/\[\[(?:File|Image):[^\]]*\]\]/gi, '')
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Removes {{…}} blocks (nested), keeping the body of {{infobox|title|body}} because that is where a "dishes" list lives. */
function dropTemplates(wikitext: string): string {
  let out = '';
  for (let i = 0; i < wikitext.length; ) {
    if (wikitext.startsWith('{{', i)) {
      let depth = 0;
      let j = i;
      for (; j < wikitext.length; j++) {
        if (wikitext.startsWith('{{', j)) {
          depth++;
          j++;
        } else if (wikitext.startsWith('}}', j)) {
          depth--;
          j++;
          if (depth === 0) break;
        }
      }
      const block = wikitext.slice(i, j + 1);
      const infobox = /^\{\{infobox\|[^|\n]*\|([\s\S]*)\}\}$/i.exec(block);
      if (infobox) out += `\n${dropTemplates(infobox[1]!)}\n`;
      i = j + 1;
    } else {
      out += wikitext[i];
      i++;
    }
  }
  return out;
}

const TAG_RULES: [string, RegExp][] = [
  ['pork', /\b(pork|guanciale|bacon|ham|prosciutto|pancetta|pig|sausage)\b/i],
  ['beef', /\b(beef|oxtail|veal|steak|tendon)\b/i],
  ['offal', /\b(tripe|offal|tendon|oxtail|liver|intestine|gizzard)\b/i],
  ['seafood', /\b(fish|seafood|octopus|squid|shrimp|prawn|oyster|mackerel|cod|salmon|eel|crab|clam|mussel|sushi|anchov\w*)\b/i],
  ['raw', /\b(raw|sashimi)\b/i],
  ['pasta', /\b(pasta|spaghetti|bucatini|rigatoni|tagliatelle|gnocchi)\b/i],
  ['noodle', /\b(noodles?|ramen|udon|soba)\b/i],
  ['street-food', /\b(street|snack|by the slice|take-?away|stall|vendor|fried)\b/i],
  ['dessert', /\b(dessert|sweet|gelato|pastry|cake|ice cream|pudding|cannoli|tiramisu)\b/i],
  ['spicy', /\b(spicy|chil[il]|hot pot)\b/i],
];
const MEATY = /\b(intestines?|meat\w*|ragu|ragù|chashu|calf|clams?|mussels?|vongole|lamb|pork|guanciale|bacon|ham|beef|oxtail|veal|lamb|chicken|duck|sausage|meat|tripe|fish|seafood|octopus|squid|shrimp|oyster|mackerel|cod|eel|crab|anchov\w*|sushi|prosciutto|pancetta|tendon)\b/i;
const VEGGIE = /\b(artichokes?|chicory|salad|vegetables?|zucchini|cheese|bread|pizza|tomato|mushrooms?|rice|fruit)\b/i;

/** Tags from the wording near a dish. Conservative: a tag is only given when a keyword is there. */
export function inferTags(description: string): string[] {
  const tags = TAG_RULES.filter(([, re]) => re.test(description)).map(([t]) => t);
  if (!MEATY.test(description) && VEGGIE.test(description)) tags.push('vegetarian-ok');
  return [...new Set(tags)];
}

const stripEmphasis = (s: string): string => s.replace(/'{2,}/g, '').trim();

/** The dish name at the start of a bullet: its bold and italic leading parts, joined; the rest is the description. */
function leadingName(line: string): { name: string; local?: string; rest: string } | null {
  let rest = line.trim();
  const parts: string[] = [];
  let local: string | undefined;
  for (;;) {
    const bold = /^'''(.+?)'''\s*/.exec(rest);
    const italic = /^''(?!')(.+?)''\s*/.exec(rest);
    const m = bold ?? italic;
    if (!m) break;
    const text = stripEmphasis(m[1]!);
    rest = rest.slice(m[0].length);
    // "''(or Rigatoni)''" is an aside, not part of the name.
    if (!/^\(.*\)$/.test(text)) parts.push(text);
    const paren = /^\(([^)]*)\)\s*/.exec(rest);
    if (paren && CJK.test(paren[1]!)) {
      local = paren[1]!.trim();
      rest = rest.slice(paren[0].length);
    }
  }
  if (parts.length === 0) return null;
  return { name: plain(parts.join(' ')), ...(local ? { local } : {}), rest: plain(rest) };
}

const placeWords = /\b(area|district|street|station|market|road|neighbou?rhood|temple|park|castle)\b/i;

/** Dish candidates in the text of an Eat section (or the part of it up to the first sub-section and any "specialties" ones). */
export function parseEatDishes(eatWikitext: string): DishCandidate[] {
  const sections = eatWikitext.split(/\n(?==== ?[^=])/);
  const wanted = sections.filter((s, i) => i === 0 || /^===\s*[^=\n]*(special|local|dish|regional|cuisine|food|try)[^=\n]*===/i.test(s));
  const text = dropTemplates(wanted.join('\n'));
  const found: DishCandidate[] = [];
  const seen = new Set<string>();
  const add = (c: DishCandidate) => {
    const key = c.name.toLowerCase();
    if (c.name.length < 2 || c.name.length > 40 || seen.has(key)) return;
    seen.add(key);
    found.push(c);
  };

  for (const line of text.split('\n')) {
    const bullet = /^\*+\s*(.*)$/.exec(line);
    if (!bullet) continue;
    const lead = leadingName(bullet[1]!);
    if (!lead) continue;
    // "Osaka style (お好み焼き)": a CJK aside inside the description also names the dish in its own script.
    const aside = lead.local ?? /\(([^)]*[\u3040-\u30ff\u3400-\u9fff][^)]*)\)/.exec(lead.rest)?.[1]?.trim();
    // Only the leading run of CJK characters is the local name (a parenthesis may go on in English).
    const local = aside ? /^[\u3040-\u30ff\u3400-\u9fff]+/.exec(aside)?.[0] : undefined;
    add({ name: lead.name, ...(local ? { local } : {}), tags: inferTags(`${lead.name} ${lead.rest}`), how: 'list' });
  }
  if (found.length > 0) return found;

  // No list: the bold names in the prose, minus the ones that are places.
  for (const para of text.split(/\n+/)) {
    if (/^[=*{|]/.test(para.trim())) continue;
    for (const m of para.matchAll(/'''(.+?)'''(?:\s*\(([^)]*)\))?/g)) {
      const name = plain(stripEmphasis(m[1]!));
      const aside = m[2]?.trim();
      const context = para.slice(Math.max(0, (m.index ?? 0) - 90), (m.index ?? 0) + m[0].length + 90);
      if (placeWords.test(context) && !/\b(try|dish|eat|food|specialt)/i.test(context)) continue;
      // "(蚵仔煎 kèzǎijiān / o-a chen)": the leading run of CJK characters is the local name; the romanisations after it are dropped.
      const local = aside ? /^[\u3040-\u30ff\u3400-\u9fff]+/.exec(aside.trim())?.[0] : undefined;
      add({ name, ...(local ? { local } : {}), tags: inferTags(`${name} ${para}`), how: 'prose' });
    }
  }
  return found;
}

// ---------- candidates → dishes ----------

const slug = (s: string): string =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');

/**
 * Seeds for dishes: enough to be valid, honest about where they came from. The reason is a plain statement that the guide lists the
 * dish; the AI (or the user) can replace it with a better one. Names are not translated: a Japanese dish gets its Japanese
 * spelling as the local name and the English name from the page as the Chinese-side label until someone writes a Chinese one.
 */
export function dishSeeds(candidates: DishCandidate[], city: string, source: { url: string; title: string; revision?: string; fetchedAt: string }): Dish[] {
  const used = new Set<string>();
  const out: Dish[] = [];
  for (const c of candidates) {
    const base = slug(c.name) || slug(c.local ?? '') || 'dish';
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base.slice(0, 36)}-${n}`;
    used.add(id);
    const kana = c.local !== undefined && KANA.test(c.local);
    const chinese = c.local !== undefined && CJK.test(c.local) && !kana;
    out.push({
      id,
      city,
      nameZh: (chinese ? c.local! : c.name).slice(0, 40),
      nameLocal: (c.local ?? c.name).slice(0, 80),
      ...(c.local ? { romanized: c.name.slice(0, 80) } : {}),
      why: `${city}的 Wikivoyage 指南把它列為值得吃的在地料理`,
      tags: c.tags.slice(0, 12),
      match: { names: [...new Set([c.name, ...(c.local ? [c.local] : [])].map((n) => n.slice(0, 40)))].slice(0, 10) },
      sources: [{ kind: 'wikivoyage', url: source.url, title: source.title, ...(source.revision ? { revision: source.revision } : {}), fetchedAt: source.fetchedAt }],
    });
  }
  return out;
}


// ---------- the editors' picks: {{eat}} listings ----------

export interface Listing {
  name: string;
  /** The local-script name some entries carry. */
  alt?: string;
  lat: number;
  lng: number;
  /** YYYY-MM-DD: when a Wikivoyage editor last touched the entry. Old entries are a lead, not a promise. */
  lastedit?: string;
}

/** `{{eat | name=… | lat=… | long=… …}}` entries of a Wikivoyage page. Only name, alt, coordinates and the edit date are read; entries without coordinates are skipped. */
export function parseEatListings(wikitext: string): Listing[] {
  const out: Listing[] = [];
  for (let i = wikitext.search(/\{\{\s*eat\b/i); i !== -1 && i < wikitext.length; ) {
    let depth = 0;
    let j = i;
    for (; j < wikitext.length; j++) {
      if (wikitext.startsWith('{{', j)) {
        depth++;
        j++;
      } else if (wikitext.startsWith('}}', j)) {
        depth--;
        j++;
        if (depth === 0) break;
      }
    }
    const block = wikitext.slice(i, j + 1);
    const field = (key: string) => new RegExp(`\\|\\s*${key}\\s*=([^|}]*)`, 'i').exec(block)?.[1]?.trim() ?? '';
    const name = plain(field('name'));
    const lat = Number(field('lat'));
    const lng = Number(field('long'));
    const alt = plain(field('alt'));
    const lastedit = /^\d{4}-\d{2}-\d{2}$/.test(field('lastedit')) ? field('lastedit') : undefined;
    if (name && field('lat') !== '' && field('long') !== '' && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      out.push({ name: name.slice(0, 120), ...(alt ? { alt: alt.slice(0, 120) } : {}), lat, lng, ...(lastedit ? { lastedit } : {}) });
    }
    const next = wikitext.slice(j + 1).search(/\{\{\s*eat\b/i);
    i = next === -1 ? -1 : j + 1 + next;
  }
  return out;
}
