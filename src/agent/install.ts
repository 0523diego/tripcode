// The panel's "連接 Claude Code" button installs the Claude Agent SDK into this workspace. The SDK is
// not a regular dependency (CLAUDE.md: opt-in only), so the install has to follow the project's
// supply-chain rules itself: an exact version, never one published in the last 7 days.
import { spawn } from 'node:child_process';

export const MIN_AGE_DAYS = 7;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const VIEW_TIMEOUT_MS = 30 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const STABLE_RE = /^\d+\.\d+\.\d+$/;

/** Numeric semver compare for plain x.y.z versions. */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Newest stable version that has been on the registry for at least `minAgeDays`, from the
 * `time` map of `npm view <pkg> time --json`. Prereleases and the `created`/`modified` keys are skipped.
 */
export function pickVersion(times: Record<string, string>, now: Date, minAgeDays = MIN_AGE_DAYS): string | null {
  const cutoff = now.getTime() - minAgeDays * DAY_MS;
  let best: string | null = null;
  for (const [version, published] of Object.entries(times)) {
    if (!STABLE_RE.test(version)) continue;
    const at = Date.parse(published);
    if (!Number.isFinite(at) || at > cutoff) continue;
    if (best === null || compareVersions(version, best) > 0) best = version;
  }
  return best;
}

function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = '';
    let child;
    try {
      child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32', windowsHide: true });
    } catch (err) {
      reject(err);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${cmd} ${args.join(' ')} 逾時`));
    }, timeoutMs);
    child.stdout?.on('data', (c: Buffer) => {
      out += c.toString('utf8');
    });
    child.stderr?.on('data', (c: Buffer) => {
      out += c.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} ${args.join(' ')} 失敗（結束碼 ${code}）\n${out.slice(-1500)}`));
    });
  });
}

/** Installs the newest vetted version as an exact-pinned devDependency; returns that version. */
export async function installSdk(pkg: string, cwd: string, now: () => Date = () => new Date()): Promise<string> {
  const raw = await run('npm', ['view', pkg, 'time', '--json'], cwd, VIEW_TIMEOUT_MS);
  let times: Record<string, string>;
  try {
    times = JSON.parse(raw) as Record<string, string>;
  } catch {
    throw new Error(`無法解析 ${pkg} 的發布時間`);
  }
  const version = pickVersion(times, now());
  if (!version) throw new Error(`${pkg} 找不到發布超過 ${MIN_AGE_DAYS} 天的穩定版本`);
  await run('npm', ['install', '--save-dev', '--save-exact', `${pkg}@${version}`], cwd, INSTALL_TIMEOUT_MS);
  return version;
}
