// TripCode CLI. Run with: node --env-file-if-exists=.env cli/tripcode.ts <command>
// Node >=22.18 strips types, so imports use explicit .ts and only erasable syntax is used.
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { CliError, parseArgs } from './context.ts';
import type { CliContext } from './context.ts';
import { serviceCommand } from './commands/service.ts';
import { bookingsCommand, checkCommand, exportCommand, listCommand, readyCommand } from './commands/trips.ts';
import { placesCommand } from './commands/places.ts';
import { routesCommand } from './commands/routes.ts';
import { optimizeCommand } from './commands/optimize.ts';
import { notionCommand } from './commands/notion.ts';
import { NotionApiError } from './notion.ts';
import { newTripCommand } from './commands/new-trip.ts';
import { buyCommand } from './commands/buy.ts';
import { flightsCommand } from './commands/flights.ts';
import { foodCommand } from './commands/food.ts';
import { ideaCommand } from './commands/idea.ts';
import { photoCommand } from './commands/photo.ts';
import { GoogleApiError } from './google.ts';
import { OsmApiError } from './osm.ts';

export const USAGE = `用法：tripcode <command> [選項]（加 --pretty 輸出易讀格式，預設為 JSON）

  places search "<query>" [--near lat,lng] [--lang zh-TW] [--provider google|osm]   預設：有 Google 金鑰用 google，否則免金鑰的 osm
  places details <placeId> [--lang zh-TW]              osm:node/123 走 OpenStreetMap；其餘為 Google place id
  routes <from> <to> [--mode transit|walk|drive] [--depart ISO]   from/to: place_id:XXX 或 lat,lng；沒有金鑰時為直線估算
  check <tripId> [--file variant-b.ts] [--live]
  ready <tripId> [--file variant-b.ts]                出發準備度：還有什麼沒做（空殼日、必須預約沒買、沒住宿的夜晚、還沒決定的餐）
  bookings <tripId> [--file variant-b.ts]             訂票清單：要買的項目、開賣與截止日、官方與 Klook / Trip.com 的購買連結
  export ics <tripId>
  export links <tripId>
  export kml <tripId> [--file variant-b.ts]
  export notion <tripId> [--file variant-b.ts] [--parent <pageId>] [--dry-run]
                                                  同步到 Notion（手機看行程）；需要 NOTION_TOKEN 與 NOTION_PARENT_PAGE_ID
  optimize <tripId> --day N [--file variant-b.ts] [--mode transit|walk|drive] [--offline] [--keep id,id] [--start HH:MM]
                                                  只提出建議、不改檔；--offline 或沒有金鑰時用直線估算
  new <tripId> --title "<標題>" --start YYYY-MM-DD --end YYYY-MM-DD --tz <IANA> [--adults N] [--children 5,8] [--destination <id>] [--style <id>]
                                                  建立 trips/<tripId>/（trip.ts 空白行程、brief.md、inbox/）
  idea <new|show|answer|places|choose|reject|reject-round|dates|finish> <id> …
                                                  第 0 步「找方向」：不知道去哪的人，一題一題問到目的地和日期，再建立行程（tripcode idea --help）
  list
  service <install|uninstall|status|restart|logs>   讓 TripCode 常駐在背景（macOS）：登入就自動啟動，不用每次再開（tripcode service --help）
  food <show|taste|vote|dish|evidence|reject> …           這趟要吃什麼：必吃的菜、口味、看過的店與證據（tripcode food --help）
  photo <add|remove|list> …                             項目的照片：從官方網頁存一張照片並記下來源、拿掉、列出（tripcode photo --help）
  flights <quote|dates|trip|status> …                    機票報價（Google Flights 公開頁面，預設關閉，要在 .env 設 TRIPCODE_FLIGHTS=1；tripcode flights --help）
  buy <watch|scan|alerts|browser> …                      開賣日提醒、價格監控、在 TripCode 自己的 Chrome 讀頁面（不付款；tripcode buy --help）
`;

export async function run(argv: string[], ctx: CliContext): Promise<number> {
  try {
    // `buy` has its own sub-commands and flags (cli/commands/buy.ts), so it never goes through the generic parser.
    if (argv[0] === 'buy') return await buyCommand(ctx, argv.slice(1));
    // `idea` takes --json / --trip-id, which the generic parser does not know; it calls parseArgs itself for the rest.
    if (argv[0] === 'idea') return await ideaCommand(ctx, argv.slice(1));
    // `food` has its own sub-commands and flags (cli/commands/food.ts).
    if (argv[0] === 'food') return await foodCommand(ctx, argv.slice(1));
    // `photo` has its own sub-commands and flags (cli/commands/photo.ts).
    if (argv[0] === 'photo') return await photoCommand(ctx, argv.slice(1));
    // `flights` has its own sub-commands and flags (cli/commands/flights.ts).
    if (argv[0] === 'flights') return await flightsCommand(ctx, argv.slice(1));
    // `service` also has its own flags (--port) and never goes through the generic parser.
    if (argv[0] === 'service') return await serviceCommand(ctx, argv.slice(1));
    const args = parseArgs(argv);
    const cmd = args.positionals[0];
    if (!cmd || args.flags.help || cmd === 'help') {
      ctx.stdout(USAGE);
      return cmd || args.flags.help ? 0 : 1;
    }
    switch (cmd) {
      case 'places':
        await placesCommand(ctx, args);
        return 0;
      case 'routes':
        await routesCommand(ctx, args);
        return 0;
      case 'check':
        return await checkCommand(ctx, args);
      case 'ready':
        return await readyCommand(ctx, args);
      case 'bookings':
        return await bookingsCommand(ctx, args);
      case 'export':
        if (args.positionals[1] === 'notion') {
          await notionCommand(ctx, args);
          return 0;
        }
        await exportCommand(ctx, args);
        return 0;
      case 'optimize':
        await optimizeCommand(ctx, args);
        return 0;
      case 'new':
        await newTripCommand(ctx, args);
        return 0;
      case 'list':
        await listCommand(ctx, args);
        return 0;
      default:
        throw new CliError(`未知的指令：${cmd}\n\n${USAGE}`);
    }
  } catch (e) {
    if (e instanceof CliError || e instanceof GoogleApiError || e instanceof OsmApiError || e instanceof NotionApiError) {
      ctx.stderr(`錯誤：${e.message}\n`);
      return e instanceof CliError ? e.exitCode : 1;
    }
    ctx.stderr(`未預期的錯誤：${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    return 1;
  }
}

export function defaultContext(root: string): CliContext {
  return {
    root,
    env: process.env,
    fetch: (url, init) => fetch(url, init),
    stdout: (s) => void process.stdout.write(s),
    stderr: (s) => void process.stderr.write(s),
    now: () => new Date(),
    loadCore: async () => (await import('../src/core/index.ts')) as never,
    loadTrip: async (file) => {
      const mod = await import(pathToFileURL(file).href);
      if (!mod.default) throw new Error('檔案沒有 default export');
      return mod.default;
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  run(process.argv.slice(2), defaultContext(root)).then((code) => {
    process.exitCode = code;
  });
}
