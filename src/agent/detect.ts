// Finds the SDK package and the `claude` binary on this machine. The SDK is resolved from the
// project's own node_modules (never bundled), so it only exists after the user opts in.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const IS_WINDOWS = process.platform === 'win32';
const VERSION_TIMEOUT_MS = 5000;

export function findOnPath(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  const exts = IS_WINDOWS ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';') : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext.toLowerCase());
      try {
        if (statSync(candidate, { throwIfNoEntry: false })?.isFile()) return candidate;
      } catch {
        /* unreadable PATH entry */
      }
    }
  }
  return null;
}

/** The SDK spawns the binary directly, which on Windows only works for a real .exe (not a .cmd shim). */
export function findSpawnableCli(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const found = findOnPath(command, env);
  if (!found || !IS_WINDOWS) return found;
  return found.toLowerCase().endsWith('.exe') ? found : null;
}

export function parseVersion(output: string): string | null {
  const m = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(output);
  return m?.[1] ?? null;
}

export function commandVersion(file: string): Promise<string | null> {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(file, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], shell: IS_WINDOWS, windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, VERSION_TIMEOUT_MS);
    child.stdout?.on('data', (c: Buffer) => {
      out += c.toString('utf8');
    });
    child.stderr?.on('data', (c: Buffer) => {
      out += c.toString('utf8');
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(parseVersion(out));
    });
  });
}

interface PackageJson {
  version?: string;
  exports?: unknown;
  module?: string;
  main?: string;
}

function pickCondition(target: unknown): string | null {
  if (!target) return null;
  if (typeof target === 'string') return target;
  if (Array.isArray(target)) {
    for (const t of target) {
      const hit = pickCondition(t);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof target !== 'object') return null;
  const record = target as Record<string, unknown>;
  for (const key of ['import', 'node', 'default', 'require']) {
    if (key in record) {
      const hit = pickCondition(record[key]);
      if (hit) return hit;
    }
  }
  return null;
}

function entryFromPackageJson(pkg: PackageJson): string | null {
  const exp = pkg.exports;
  if (exp && typeof exp === 'object' && !Array.isArray(exp)) {
    const record = exp as Record<string, unknown>;
    const root = pickCondition(Object.keys(record).some((k) => k.startsWith('.')) ? record['.'] : exp);
    if (root) return root;
  } else if (exp) {
    const root = pickCondition(exp);
    if (root) return root;
  }
  return pkg.module ?? pkg.main ?? null;
}

export interface WorkspacePackage {
  dir: string;
  version: string;
  entry: string;
}

/** Walks up from `userCwd` like Node does, so a hoisted install in a parent workspace is found too. */
export function resolveWorkspacePackage(userCwd: string, name: string): WorkspacePackage | null {
  let dir = path.resolve(userCwd);
  for (;;) {
    const pkgJsonPath = path.join(dir, 'node_modules', name, 'package.json');
    if (existsSync(pkgJsonPath)) {
      let pkg: PackageJson;
      try {
        pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as PackageJson;
      } catch {
        return null;
      }
      const entry = entryFromPackageJson(pkg);
      if (!entry) return null;
      const pkgDir = path.dirname(pkgJsonPath);
      return { dir: pkgDir, version: pkg.version ?? '0.0.0', entry: path.resolve(pkgDir, entry) };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export async function importWorkspacePackage(userCwd: string, name: string): Promise<Record<string, unknown> | null> {
  const resolved = resolveWorkspacePackage(userCwd, name);
  if (!resolved) return null;
  return (await import(pathToFileURL(resolved.entry).href)) as Record<string, unknown>;
}
