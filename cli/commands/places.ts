import { CliError, flagStr, printJson, requireApiKey, selectProvider } from '../context.ts';
import type { CliContext, ParsedArgs } from '../context.ts';
import { parseLatLng, placeDetails, searchPlaces } from '../google.ts';
import type { PlaceDetails, PlaceSearchResult } from '../google.ts';
import { isOsmId, placeDetailsOsm, searchPlacesOsm, userAgentFor } from '../osm.ts';
import type { OsmPlaceDetails } from '../osm.ts';

function prettySearch(r: PlaceSearchResult): string {
  if (r.results.length === 0) return '找不到符合的地點\n';
  return (
    r.results
      .map((p, i) => {
        const loc = p.loc ? ` (${p.loc.lat}, ${p.loc.lng})` : '';
        const rating = p.rating !== undefined ? ` ★${p.rating}` : '';
        return `${i + 1}. ${p.name}${rating}\n   ${p.address ?? ''}${loc}\n   placeId: ${p.placeId}`;
      })
      .join('\n') + `\n\n來源：${r.source}，${r.fetchedAt}\n` +
    (r.source === 'openstreetmap-nominatim' ? '資料 © OpenStreetMap contributors (ODbL)\n' : '')
  );
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

function prettyDetails(d: PlaceDetails | OsmPlaceDetails): string {
  const lines = [`${d.name}${d.rating !== undefined ? ` ★${d.rating}` : ''}`, d.address ?? ''];
  if (d.loc) lines.push(`(${d.loc.lat}, ${d.loc.lng})`);
  lines.push(`營業狀態：${d.businessStatus ?? '未知'}`);
  if (d.hours) {
    lines.push('營業時間：');
    for (const p of d.hours.value.periods) lines.push(`  週${WEEKDAYS[p.day]} ${p.open}–${p.close}`);
  } else if ('hoursRaw' in d && d.hoursRaw) {
    lines.push(`營業時間（OSM 原始字串，未解析）：${d.hoursRaw}`);
  } else {
    lines.push(`營業時間：${d.source === 'google-places' ? 'Google 未提供' : 'OpenStreetMap 未提供'}`);
  }
  lines.push(`placeId: ${d.placeId}`, `來源：${d.source}，${d.fetchedAt}`);
  return lines.join('\n') + '\n';
}

function inform(ctx: CliContext, msg: string): void {
  ctx.stderr(`注意：${msg}\n`);
}

export async function placesCommand(ctx: CliContext, args: ParsedArgs): Promise<void> {
  const [, sub, ...rest] = args.positionals;
  const client = () => ({ apiKey: requireApiKey(ctx), fetch: ctx.fetch, now: ctx.now });
  const osmClient = () => ({ fetch: ctx.fetch, now: ctx.now, userAgent: userAgentFor(ctx.root) });
  const lang = flagStr(args, 'lang');
  if (sub === 'search') {
    const query = rest.join(' ').trim();
    if (!query) throw new CliError('用法：places search "<query>" [--near lat,lng] [--lang zh-TW] [--provider google|osm]');
    const nearStr = flagStr(args, 'near');
    const near = nearStr ? parseLatLng(nearStr) : undefined;
    if (nearStr && !near) throw new CliError(`--near 格式錯誤：${nearStr}（應為 lat,lng）`);
    const provider = selectProvider(ctx, args);
    let r: PlaceSearchResult;
    if (provider === 'osm') {
      if (!args.flags.provider) inform(ctx, '未設定 GOOGLE_MAPS_API_KEY，改用免金鑰的 OpenStreetMap（Nominatim）。資料 © OpenStreetMap contributors。');
      r = await searchPlacesOsm(osmClient(), query, { near, lang });
    } else {
      r = await searchPlaces(client(), query, { near, lang });
    }
    if (args.flags.pretty) ctx.stdout(prettySearch(r));
    else printJson(ctx, r);
  } else if (sub === 'details') {
    const placeId = rest[0];
    if (!placeId) throw new CliError('用法：places details <placeId> [--lang zh-TW]（OSM 地點的 id 形如 osm:node/123）');
    let d: PlaceDetails | OsmPlaceDetails;
    if (isOsmId(placeId)) {
      d = await placeDetailsOsm(osmClient(), placeId, { lang });
    } else if (placeId.startsWith('osm:')) {
      throw new CliError(`無效的 OSM id：${placeId}（格式 osm:node/123、osm:way/123 或 osm:relation/123）`);
    } else {
      if (!ctx.env.GOOGLE_MAPS_API_KEY?.trim()) {
        throw new CliError('這是 Google place id，查詢需要 GOOGLE_MAPS_API_KEY；沒有金鑰時可用 `places search` 取得 osm: 開頭的 OpenStreetMap id。');
      }
      d = await placeDetails(client(), placeId, { lang });
    }
    if (args.flags.pretty) ctx.stdout(prettyDetails(d));
    else printJson(ctx, d);
  } else {
    throw new CliError('用法：places search "<query>" | places details <placeId>');
  }
}
