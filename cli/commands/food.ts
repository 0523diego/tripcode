// `tripcode food …`: the food guide of a trip (trips/<id>/food.json, see src/core/food-types.ts). The file is only ever
// changed through these commands (like idea.json), so the AI panel, the viewer and the user all go through the same checks.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { CliError, checkFileName, checkTripId, printJson } from '../context.ts';
import type { CliContext } from '../context.ts';
import { guideForTrip, nearForTrip, photoForPlace } from '../food-service.ts';
import { SafeFetchError } from '../safe-fetch.ts';
import { readFood, updateFood } from '../food-store.ts';
export { foodPath, readFood, updateFood, writeFood } from '../food-store.ts';
import { FoodError, addAttribution, putPlace, addEvidence, aiOnly, emptyFood, parseFood, putDish, rejectPlace, removeDish, setProfile, setTaste, visibleDishes, voteDish } from '../../src/core/food.ts';
import type { FoodFile } from '../../src/core/food-types.ts';
import type { Throttle } from '../osm.ts';

export const FOOD_USAGE = `用法：tripcode food <子指令>（預設輸出 JSON；加 --pretty 輸出易讀格式）

  show <tripId> [--city 羅馬] [--pretty]          這趟的菜、口味、投票、看過的店
  taste <tripId> [--avoid-tag pork,offal] [--like-tag pasta] [--avoid-dish id] [--diet no-pork,vegetarian] [--allergies 花生]
        [--budget low|mid|high] [--queue no|short|ok] [--kids true|false] [--walk 10]   記下口味（給的清單會取代舊的）
  vote <tripId> <dishId> want|no|clear              想吃 / 不要 / 清除
  guide <tripId> --city 羅馬 --page Rome [--save]    從英文 Wikivoyage 的 Eat 段讀這座城市的在地菜（只讀菜名，附頁面連結與版本）；沒有 --save 只列出來看
  near <tripId> --date 2026-11-24 --slot lunch|dinner [--anchor prev|next|hotel|<itemId>] [--dish id,id] [--radius 600] [--limit 8] [--save [--no-photos]]
        這一餐附近真的存在、那個時段有開、店名或菜系對得上這道菜的店（OpenStreetMap，沒有評分）；--save 把結果和證據記進 food.json，畫面左邊的餐廳區會即時顯示，並自動抓前幾家官網的照片（--no-photos 不抓）
  dish add <tripId> --json '<Dish>' | --file path   新增或取代一道菜（--file 相對於專案根目錄）；每道菜都要有來源，AI 自己的印象標 {"kind":"ai"}
  dish rm <tripId> <dishId>
  evidence add <tripId> --place <key> --kind map-osm|map-google|guide-wikivoyage|web|michelin|user-link|ai-memory
        --claim exists|open-at-slot|closed-at-slot|recommended|serves-dish|permanently-closed --source <https網址或 osm:node/…>
        --confidence live|recent|reference [--detail "一句話"]    web／michelin／guide-wikivoyage 一定要有 https 網址；沒有網址就不是證據
  profile <tripId> --place <key> --json '{"summary":"一句話：這是什麼店、為什麼值得走","order":["點什麼"],"price":"網頁寫的價位","watch":"要注意的","sources":["https://你讀過的網頁"]}'
        這家店是什麼樣子（自己的話，一定要附你讀過的網頁；不收評分、星等、分數）
  photo <tripId> --place <key> --page https://店家官網 [--image https://圖片網址]
        把店家網頁提供的分享圖片（og:image）存到 trips/<id>/attachments/，卡片用；只連到公開的 https 網站，不連本機或內部網路
  reject <tripId> --place <key> [--reason touristy|far|pricey|meh|closed|other]
`;

interface Args {
  pos: string[];
  flags: Record<string, string | true>;
}

const VALUE = new Set(['json', 'file', 'city', 'avoid-dish', 'avoid-tag', 'like-tag', 'diet', 'allergies', 'budget', 'queue', 'kids', 'walk', 'place', 'kind', 'claim', 'source', 'confidence', 'detail', 'reason', 'date', 'slot', 'anchor', 'dish', 'radius', 'provider', 'page', 'district', 'limit']);
const BOOL = new Set(['pretty', 'save', 'help']);

function parse(argv: string[]): Args {
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) {
      pos.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
    if (BOOL.has(name)) flags[name] = true;
    else if (VALUE.has(name)) {
      const v = eq === -1 ? argv[++i] : a.slice(eq + 1);
      if (v === undefined) throw new CliError(`--${name} 需要一個值`);
      flags[name] = v;
    } else throw new CliError(`未知的選項：--${name}`);
  }
  return { pos, flags };
}

const flag = (a: Args, name: string): string | undefined => (typeof a.flags[name] === 'string' ? (a.flags[name] as string) : undefined);
const csv = (v: string): string[] => v.split(',').map((x) => x.trim()).filter(Boolean);

async function jsonArg(ctx: CliContext, a: Args): Promise<unknown> {
  const inline = flag(a, 'json');
  const file = flag(a, 'file');
  if ((inline === undefined) === (file === undefined)) throw new CliError('請給 --json \'<物件>\' 或 --file <路徑>（二選一）');
  let text = inline;
  if (file !== undefined) {
    const p = path.resolve(ctx.root, file);
    if (path.relative(ctx.root, p).startsWith('..')) throw new CliError('--file 必須在專案資料夾內');
    text = await readFile(p, 'utf8').catch(() => {
      throw new CliError(`讀不到 ${file}`);
    });
  }
  try {
    return JSON.parse(text!);
  } catch {
    throw new CliError('JSON 格式不正確');
  }
}

// ---------- commands ----------

function prettyShow(tripId: string, food: FoodFile, city?: string): string {
  const cities = city ? [city] : [...new Set(food.dishes.map((d) => d.city))];
  const lines = [`${tripId} 的吃什麼`, ''];
  const t = food.taste;
  const taste = [t.diet.length ? `飲食 ${t.diet.join('、')}` : '', t.avoidTags.length ? `不吃 ${t.avoidTags.join('、')}` : '', t.likeTags.length ? `想吃 ${t.likeTags.join('、')}` : '', t.budget ? `預算 ${t.budget}` : '', t.kids ? '有小孩' : '', t.allergies ? `過敏 ${t.allergies}` : ''].filter(Boolean);
  lines.push(`口味：${taste.length ? taste.join('；') : '還沒設定'}`, '');
  if (cities.length === 0) lines.push('還沒有任何菜。先 `tripcode food guide <tripId> --city …`（從 Wikivoyage 讀）或 `food dish add`。');
  for (const c of cities) {
    const v = visibleDishes(food, c);
    lines.push(`【${c}】${v.shown.length} 道${v.hidden.length ? `（另有 ${v.hidden.length} 道被你的口味隱藏）` : ''}`);
    for (const d of v.shown) {
      const mark = food.votes[d.id] === 'want' ? '★' : ' ';
      lines.push(` ${mark} ${d.id}  ${d.nameZh}（${d.nameLocal}）${aiOnly(d) ? ' ⟨AI 的印象，尚未查證⟩' : ''}`, `      ${d.why}`);
    }
    for (const h of v.hidden) lines.push(`   × ${h.dish.id}  ${h.dish.nameZh}：${h.why}`);
    lines.push('');
  }
  if (food.places.length) {
    lines.push(`看過的店：${food.places.length} 家，已拒絕 ${food.rejected.length} 家`);
    for (const p of food.places) lines.push(`  ${p.key}  ${p.name}（${p.dishes.join('、') || '沒指定菜'}）證據 ${p.evidence.length} 筆`);
  }
  if (food.attribution.length) lines.push('', `資料來源：${food.attribution.join('；')}`);
  return `${lines.join('\n')}\n`;
}

export async function foodCommand(ctx: CliContext, argv: string[]): Promise<number> {
  const a = parse(argv);
  const [cmd, sub] = a.pos;
  if (!cmd || a.flags.help) {
    ctx.stdout(FOOD_USAGE);
    return cmd || a.flags.help ? 0 : 1;
  }
  try {
    return await run(ctx, a, cmd, sub);
  } catch (e) {
    if (e instanceof FoodError) throw new CliError(e.message);
    throw e;
  }
}

/** What the network-facing operations need from the CLI context (tests may add a fast throttle as `foodThrottle`). */
// Photos come through the public-web guard (cli/safe-fetch.ts). When a test swaps the context's fetch for a fake, the photos go
// through that fake too (and the address check is skipped), so nothing leaves the test.
const deps = (ctx: CliContext) => ({ root: ctx.root, fetch: ctx.fetch, now: ctx.now, loadTrip: ctx.loadTrip, ...(ctx.fetch === globalThis.fetch ? {} : { safe: { fetch: ctx.fetch as never, lookup: async () => ['93.184.216.34'] } }), ...((ctx as { foodThrottle?: Throttle }).foodThrottle ? { throttle: (ctx as { foodThrottle?: Throttle }).foodThrottle } : {}) });

async function run(ctx: CliContext, a: Args, cmd: string, sub: string | undefined): Promise<number> {
  const now = () => ctx.now().toISOString().replace(/\.\d+Z$/, 'Z');
  switch (cmd) {
    case 'show': {
      const tripId = checkTripId(a.pos[1]);
      const food = await readFood(ctx.root, tripId);
      const city = flag(a, 'city');
      if (a.flags.pretty) ctx.stdout(prettyShow(tripId, food, city));
      else printJson(ctx, city ? { ...food, dishes: food.dishes.filter((d) => d.city === city) } : food);
      return 0;
    }
    case 'taste': {
      const tripId = checkTripId(a.pos[1]);
      const patch: Record<string, unknown> = {};
      for (const [flagName, key] of [['avoid-tag', 'avoidTags'], ['like-tag', 'likeTags'], ['avoid-dish', 'avoidDishes'], ['diet', 'diet']] as const) {
        const v = flag(a, flagName);
        if (v !== undefined) patch[key] = csv(v);
      }
      const allergies = flag(a, 'allergies');
      if (allergies !== undefined) patch.allergies = allergies;
      for (const key of ['budget', 'queue'] as const) {
        const v = flag(a, key);
        if (v !== undefined) patch[key] = v;
      }
      const kids = flag(a, 'kids');
      if (kids !== undefined) {
        if (kids !== 'true' && kids !== 'false') throw new CliError('--kids 要是 true 或 false');
        patch.kids = kids === 'true';
      }
      const walk = flag(a, 'walk');
      if (walk !== undefined) patch.maxWalkMin = Number(walk);
      if (Object.keys(patch).length === 0) throw new CliError('沒有要記的口味：請給 --avoid-tag、--diet、--budget … 之一');
      const food = await updateFood(ctx.root, tripId, (f) => setTaste(f, patch));
      printJson(ctx, food.taste);
      return 0;
    }
    case 'vote': {
      const tripId = checkTripId(a.pos[1]);
      const [, , dishId, vote] = a.pos;
      if (!dishId || (vote !== 'want' && vote !== 'no' && vote !== 'clear')) throw new CliError('用法：food vote <tripId> <dishId> want|no|clear');
      const food = await updateFood(ctx.root, tripId, (f) => voteDish(f, dishId, vote));
      printJson(ctx, { votes: food.votes });
      return 0;
    }
    case 'dish': {
      const tripId = checkTripId(a.pos[2]);
      if (sub === 'add') {
        const dish = await jsonArg(ctx, a);
        const food = await updateFood(ctx.root, tripId, (f) => putDish(f, dish));
        printJson(ctx, { dishes: food.dishes.length });
        return 0;
      }
      if (sub === 'rm') {
        const id = a.pos[3];
        if (!id) throw new CliError('用法：food dish rm <tripId> <dishId>');
        const food = await updateFood(ctx.root, tripId, (f) => removeDish(f, id));
        printJson(ctx, { dishes: food.dishes.length });
        return 0;
      }
      throw new CliError('用法：food dish add|rm <tripId> …');
    }
    case 'evidence': {
      if (sub !== 'add') throw new CliError('用法：food evidence add <tripId> --place <key> --kind … --claim … --source … --confidence …');
      const tripId = checkTripId(a.pos[2]);
      const place = flag(a, 'place');
      if (!place) throw new CliError('請給 --place <key>');
      const evidence = { kind: flag(a, 'kind'), claim: flag(a, 'claim'), source: flag(a, 'source'), confidence: flag(a, 'confidence'), fetchedAt: now(), ...(flag(a, 'detail') ? { detail: flag(a, 'detail') } : {}) };
      const food = await updateFood(ctx.root, tripId, (f) => addEvidence(f, place, evidence));
      printJson(ctx, { place: food.places.find((p) => p.key === place) });
      return 0;
    }
    case 'profile': {
      // What the place is like, from pages you read: food profile <tripId> --place <key> --json '{"summary":"…","order":["…"],"price":"…","watch":"…","sources":["https://…"]}'
      const tripId = checkTripId(a.pos[1]);
      const place = flag(a, 'place');
      if (!place) throw new CliError('請給 --place <key>');
      const raw = (await jsonArg(ctx, a)) as Record<string, unknown>;
      const food = await updateFood(ctx.root, tripId, (f) => setProfile(f, place, { ...raw, fetchedAt: now() }));
      printJson(ctx, { place: food.places.find((p) => p.key === place) });
      return 0;
    }
    case 'photo': {
      const tripId = checkTripId(a.pos[1]);
      const place = flag(a, 'place');
      const page = flag(a, 'page');
      if (!place || !page) throw new CliError('用法：food photo <tripId> --place <key> --page https://店家官網 [--image https://圖片網址]');
      try {
        printJson(ctx, await photoForPlace({ root: ctx.root, now: () => ctx.now() }, tripId, { place, pageUrl: page, ...(flag(a, 'image') ? { imageUrl: flag(a, 'image')! } : {}) }));
      } catch (e) {
        if (e instanceof SafeFetchError) throw new CliError(`抓不到照片：${e.message}`);
        throw e;
      }
      return 0;
    }
    case 'reject': {
      const tripId = checkTripId(a.pos[1]);
      const place = flag(a, 'place');
      if (!place) throw new CliError('請給 --place <key>');
      const reason = flag(a, 'reason');
      const food = await updateFood(ctx.root, tripId, (f) => rejectPlace(f, place, reason as never, now()));
      printJson(ctx, { rejected: food.rejected });
      return 0;
    }
    case 'guide': {
      const tripId = checkTripId(a.pos[1]);
      const city = flag(a, 'city');
      const page = flag(a, 'page');
      if (!city || !page) throw new CliError('用法：food guide <tripId> --city 羅馬 --page Rome [--save]');
      const result = await guideForTrip(deps(ctx), tripId, { city, page, save: a.flags.save === true });
      if (a.flags.pretty) {
        ctx.stdout(`${result.page}（版本 ${result.revision}）找到 ${result.found} 道菜、${result.listings} 家編輯推薦的店：\n${result.dishes.map((d) => `  ${d.id}  ${d.name}${d.label !== d.name ? `（${d.label}）` : ''}  ${d.tags.join(',')}`).join('\n')}\n${result.saved ? `已存入 ${result.added.length} 道（原本就有的不覆蓋）。` : '還沒存：加 --save 存進 food.json。'}\n`);
      } else printJson(ctx, result);
      return 0;
    }
    case 'near': {
      const tripId = checkTripId(a.pos[1]);
      const date = flag(a, 'date');
      const slot = flag(a, 'slot');
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || (slot !== 'lunch' && slot !== 'dinner')) throw new CliError('用法：food near <tripId> --date YYYY-MM-DD --slot lunch|dinner');
      const dishArg = flag(a, 'dish');
      const radius = flag(a, 'radius');
      const out = await nearForTrip(deps(ctx), tripId, { file: flag(a, 'file') ? checkFileName(flag(a, 'file')) : undefined, date, slot, anchor: flag(a, 'anchor'), dishes: dishArg ? csv(dishArg) : undefined, radius: radius ? Number(radius) : undefined, limit: Number(flag(a, 'limit') ?? 8), save: a.flags.save === true, photos: a.flags['no-photos'] === true ? 'none' : 'wait' });
      if (a.flags.pretty) {
        const tierLabel = { safe: '可以放心', likely: '大致可以', check: '要自己確認' } as const;
        const lines = [`${date} ${slot === 'lunch' ? '午餐' : '晚餐'}（${out.window.from}–${out.window.to}）在「${out.anchor.title}」附近，走路 ${out.maxWalkMin} 分鐘內`, `菜：${out.dishes.length ? out.dishes.join('、') : '沒有指定（food.json 裡還沒有這座城市的菜）'}`];
        if (out.generalMode) lines.push('沒有任何一家店的店名或菜系對得上這些菜（在義大利很常見）：下面是附近營業中的店，無法確認有沒有這道菜。');
        lines.push('');
        out.results.forEach((r, i) => lines.push(`${String(i + 1).padStart(2)}. ${r.name}  ${r.distanceM} m · 走 ${r.walkMin} 分  [${tierLabel[r.tier]}]`, `    ${r.why.join('；') || '—'}${r.hours ? `；營業時間 ${r.hours}` : ''}`, `    ${r.mapsUrl}`));
        if (out.results.length === 0) lines.push('（沒有符合的店。可以加大 --radius，或換一道菜。）');
        lines.push('', `略過：${out.dropped.closed} 家那個時段沒開、${out.dropped.far} 家太遠、${out.dropped.rejected} 家你拒絕過、${out.dropped.noMatch} 家對不上菜`, out.note, '資料：© OpenStreetMap contributors (ODbL)');
        ctx.stdout(`${lines.join('\n')}\n`);
      } else printJson(ctx, out);
      return 0;
    }
    case 'attribute': {
      // Internal: used by guide/near to record the credits a source requires.
      const tripId = checkTripId(a.pos[1]);
      await updateFood(ctx.root, tripId, (f) => addAttribution(f, ...a.pos.slice(2)));
      return 0;
    }
    default:
      throw new CliError(`未知的子指令：food ${cmd}\n\n${FOOD_USAGE}`);
  }
}
