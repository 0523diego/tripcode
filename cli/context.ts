// Shared CLI plumbing: argument parsing, I/O context, errors.
import type { FetchLike } from './google.ts';
import type { Trip } from '../src/core/types.ts';

/** The subset of src/core the CLI uses (injectable for tests). */
export interface Core {
  checkTrip(trip: Trip, opts?: { hoursFor?: (item: any) => any }): any[];
  dayMapsLinks(day: Trip['days'][number], opts?: Record<string, unknown>): string[];
  tripToIcs(trip: Trip): string;
}

export interface CliContext {
  /** Repo root: trips live in <root>/trips. */
  root: string;
  env: Record<string, string | undefined>;
  fetch: FetchLike;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  now: () => Date;
  loadCore: () => Promise<Core>;
  /** Imports a trip module by absolute path and returns its default export. */
  loadTrip: (file: string) => Promise<Trip>;
}

export class CliError extends Error {
  exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | true>;
}

const VALUE_FLAGS = new Set(['near', 'lang', 'mode', 'depart', 'file', 'day', 'keep', 'start', 'title', 'end', 'tz', 'adults', 'children', 'destination', 'style', 'provider', 'parent']);
const BOOL_FLAGS = new Set(['pretty', 'live', 'help', 'offline', 'dry-run']);

/**
 * Tiny parser: `--flag value`, `--flag=value`, boolean `--pretty`. Everything else is positional,
 * so negative coordinates such as `-33.8,151.2` work as positionals.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
      if (BOOL_FLAGS.has(name)) {
        if (eq !== -1) throw new CliError(`--${name} 不需要值`);
        flags[name] = true;
      } else if (VALUE_FLAGS.has(name)) {
        const v = eq === -1 ? argv[++i] : a.slice(eq + 1);
        if (v === undefined || v === '') throw new CliError(`--${name} 需要一個值`);
        flags[name] = v;
      } else {
        throw new CliError(`未知的選項：--${name}`);
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

export function flagStr(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags[name];
  return typeof v === 'string' ? v : undefined;
}

export function printJson(ctx: CliContext, data: unknown): void {
  ctx.stdout(JSON.stringify(data, null, 2) + '\n');
}

export function requireApiKey(ctx: CliContext): string {
  const key = ctx.env.GOOGLE_MAPS_API_KEY?.trim();
  if (!key) {
    throw new CliError(
      '找不到 GOOGLE_MAPS_API_KEY。請在專案根目錄建立 .env 檔，加入一行 GOOGLE_MAPS_API_KEY=你的金鑰' +
        '（需在 Google Cloud 啟用 Places API (New) 與 Routes API），再重新執行。',
    );
  }
  return key;
}

const TRIP_ID_RE = /^[a-z0-9-]+$/;
const FILE_RE = /^[a-z0-9-]+\.ts$/;

export function checkTripId(id: string | undefined): string {
  if (!id) throw new CliError('請提供 tripId，例如：check switzerland-2026');
  if (!TRIP_ID_RE.test(id)) throw new CliError(`無效的 tripId：${id}（只能使用小寫英數字與 -）`);
  return id;
}

export function checkFileName(file: string | undefined): string {
  const f = file ?? 'trip.ts';
  if (!FILE_RE.test(f)) throw new CliError(`無效的檔名：${f}（例如 trip.ts、variant-b.ts）`);
  return f;
}

export type PlacesProvider = 'google' | 'osm';

/** google if a key is set (unless --provider osm), otherwise osm (keyless). */
export function selectProvider(ctx: CliContext, args: ParsedArgs): PlacesProvider {
  const flag = flagStr(args, 'provider');
  const hasKey = !!ctx.env.GOOGLE_MAPS_API_KEY?.trim();
  if (flag !== undefined && flag !== 'google' && flag !== 'osm') throw new CliError(`--provider 必須是 google 或 osm：${flag}`);
  if (flag === 'google' && !hasKey) {
    throw new CliError('--provider google 需要 GOOGLE_MAPS_API_KEY（在 .env 加入一行 GOOGLE_MAPS_API_KEY=你的金鑰）；不指定 --provider 則會自動改用免金鑰的 OpenStreetMap。');
  }
  return flag ?? (hasKey ? 'google' : 'osm');
}
