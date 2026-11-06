// `tripcode service …`: keep the viewer's dev server running in the background (macOS launchd), so TripCode is simply
// there at http://localhost:5288 after you log in, with no terminal and nobody to ask. It has to be the dev server, not a
// build: editing, undo, the AI panel and the 訂票清單 buttons all live behind it.
//
// Safety: the server listens on localhost only (Vite's default) and the request guard refuses other hosts and
// cross-site requests. Do not add `--host`: this server can write your trip files and run the AI panel's tools.
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CliError } from '../context.ts';
import type { CliContext } from '../context.ts';

export const LABEL = 'com.tripcode.dev';
export const DEFAULT_PORT = 5288;

export const SERVICE_USAGE = `用法：tripcode service <install|uninstall|status|restart|logs> [--port 5288]
  install     登入電腦後自動在背景啟動 TripCode（macOS launchd），掛掉會自動重開；網址 http://localhost:5288
  uninstall   停止並移除
  status      有沒有在跑、網址能不能連上、程序編號
  restart     重新啟動（改了 .env 或升級套件之後）
  logs        看最近的紀錄
`;

export interface PlistOptions {
  node: string;
  root: string;
  port: number;
  home: string;
  logFile: string;
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** launchd starts with a bare PATH: give the dev server the places `node`, `claude` and `git` usually live. */
export function servicePath(node: string, home: string): string {
  return [path.dirname(node), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin', `${home}/.local/bin`, `${home}/.claude/local`, `${home}/.npm-global/bin`].join(':');
}

export function buildPlist(o: PlistOptions): string {
  const arg = (s: string) => `    <string>${xml(s)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${[o.node, path.join(o.root, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(o.port), '--strictPort'].map(arg).join('\n')}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(o.root)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(servicePath(o.node, o.home))}</string>
    <key>HOME</key>
    <string>${xml(o.home)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xml(o.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(o.logFile)}</string>
</dict>
</plist>
`;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Everything that touches the machine, injectable so the command can be tested without launchd. */
export interface ServiceDeps {
  platform: NodeJS.Platform;
  home: string;
  uid: number;
  node: string;
  exec: (cmd: string, args: string[]) => Promise<ExecResult>;
  reachable: (url: string) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
}

export function defaultDeps(): ServiceDeps {
  return {
    platform: process.platform,
    home: os.homedir(),
    uid: process.getuid?.() ?? 501,
    node: process.execPath,
    exec: (cmd, args) =>
      new Promise((resolve) => {
        execFile(cmd, args, { timeout: 30_000 }, (err, stdout, stderr) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) }));
      }),
    reachable: async (url) => {
      try {
        return (await fetch(url, { signal: AbortSignal.timeout(1500) })).ok;
      } catch {
        return false;
      }
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

export const plistPath = (home: string) => path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
export const logPath = (home: string) => path.join(home, 'Library', 'Logs', 'tripcode-dev.log');

function parsePort(argv: string[]): number {
  const i = argv.indexOf('--port');
  if (i === -1) return DEFAULT_PORT;
  const n = Number(argv[i + 1]);
  if (!Number.isInteger(n) || n < 1024 || n > 65535) throw new CliError('--port 必須是 1024 到 65535 之間的整數');
  return n;
}

export async function serviceCommand(ctx: CliContext, argv: string[], deps: ServiceDeps = defaultDeps()): Promise<number> {
  const sub = argv.find((a) => !a.startsWith('--') && !/^\d+$/.test(a));
  if (!sub || argv.includes('--help')) {
    ctx.stdout(SERVICE_USAGE);
    return sub || argv.includes('--help') ? 0 : 1;
  }
  if (!['install', 'uninstall', 'status', 'restart', 'logs'].includes(sub)) throw new CliError(`未知的子指令：service ${sub}\n\n${SERVICE_USAGE}`);
  if (deps.platform !== 'darwin') throw new CliError('目前只支援 macOS（用 launchd）。其他系統請自己用 systemd 或工作排程器執行 `npm run dev -- --port 5288 --strictPort`。');

  const port = parsePort(argv);
  const url = `http://localhost:${port}/`;
  const domain = `gui/${deps.uid}`;
  const target = `${domain}/${LABEL}`;
  const plist = plistPath(deps.home);
  const loaded = async () => (await deps.exec('launchctl', ['print', target])).code === 0;

  switch (sub) {
    case 'install': {
      try {
        await readFile(path.join(ctx.root, 'node_modules', 'vite', 'bin', 'vite.js'));
      } catch {
        throw new CliError('找不到 node_modules/vite：先在專案資料夾執行 npm install');
      }
      if (await loaded()) await deps.exec('launchctl', ['bootout', target]);
      else if (await deps.reachable(url)) throw new CliError(`${url} 已經有東西在跑（可能是你手動開的 npm run dev）。先把它關掉，再執行一次 install。`);
      await mkdir(path.dirname(plist), { recursive: true });
      await mkdir(path.dirname(logPath(deps.home)), { recursive: true });
      await writeFile(plist, buildPlist({ node: deps.node, root: ctx.root, port, home: deps.home, logFile: logPath(deps.home) }), { mode: 0o644 });
      let r = await deps.exec('launchctl', ['bootstrap', domain, plist]);
      if (r.code !== 0) {
        await deps.exec('launchctl', ['bootout', target]);
        r = await deps.exec('launchctl', ['bootstrap', domain, plist]);
      }
      if (r.code !== 0) throw new CliError(`launchctl 啟動失敗：${(r.stderr || r.stdout).trim()}`);
      let up = false;
      for (let i = 0; i < 30 && !up; i++) {
        up = await deps.reachable(url);
        if (!up) await deps.sleep(500);
      }
      ctx.stdout(up ? `TripCode 已經在背景執行：${url}\n之後開機登入就會自己啟動，不用再開。看紀錄：tripcode service logs\n` : `已安裝，但 15 秒內 ${url} 還沒有回應。看紀錄：tripcode service logs\n`);
      return up ? 0 : 1;
    }
    case 'uninstall': {
      await deps.exec('launchctl', ['bootout', target]);
      await rm(plist, { force: true });
      ctx.stdout('已停止並移除背景服務。\n');
      return 0;
    }
    case 'restart': {
      if (!(await loaded())) throw new CliError('還沒安裝。先執行：tripcode service install');
      const r = await deps.exec('launchctl', ['kickstart', '-k', target]);
      if (r.code !== 0) throw new CliError(`重新啟動失敗：${(r.stderr || r.stdout).trim()}`);
      ctx.stdout('已重新啟動。\n');
      return 0;
    }
    case 'status': {
      const printed = await deps.exec('launchctl', ['print', target]);
      const isLoaded = printed.code === 0;
      const pid = /\bpid = (\d+)/.exec(printed.stdout)?.[1];
      const up = await deps.reachable(url);
      ctx.stdout(`背景服務：${isLoaded ? '已安裝' : '沒有安裝'}${pid ? `（程序 ${pid}）` : ''}\n網址：${url}（${up ? '連得上' : '連不上'}）\n紀錄：${logPath(deps.home)}\n`);
      return isLoaded && up ? 0 : 1;
    }
    case 'logs': {
      try {
        const lines = (await readFile(logPath(deps.home), 'utf8')).split('\n').slice(-40);
        ctx.stdout(lines.join('\n') + '\n');
      } catch {
        ctx.stdout('還沒有紀錄。\n');
      }
      return 0;
    }
  }
  return 0;
}
