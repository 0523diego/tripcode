// What the buying "staff" are doing right now, as a short log the office page reads (~/.tripcode/activity.jsonl).
// Lines are short human sentences: a host name, a button label, an amount. Never a card number, never what was
// typed into a field, never a full URL (no query strings). Logging is best effort and never fails a command.
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type Actor = 'scout' | 'browser';
export type Level = 'info' | 'ok' | 'warn' | 'err';

export interface Activity {
  at: string;
  actor: Actor;
  text: string;
  level: Level;
  tripId?: string;
}

const MAX_BYTES = 200 * 1024;
const KEEP_LINES = 300;

export const activityPath = (home: string) => path.join(home, 'activity.jsonl');

/** Host name only: query strings and paths can carry tokens. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export async function logActivity(home: string, entry: Omit<Activity, 'level'> & { level?: Level }): Promise<void> {
  try {
    await mkdir(home, { recursive: true, mode: 0o700 });
    const file = activityPath(home);
    const line = JSON.stringify({ level: 'info', ...entry, text: entry.text.slice(0, 160) });
    try {
      if ((await stat(file)).size > MAX_BYTES) {
        const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean).slice(-KEEP_LINES);
        await writeFile(file, lines.join('\n') + '\n', { mode: 0o600 });
      }
    } catch {
      // no file yet
    }
    await appendFile(file, line + '\n', { mode: 0o600 });
  } catch {
    // the log is a convenience
  }
}

export async function readActivity(home: string, limit = 60): Promise<Activity[]> {
  try {
    const lines = (await readFile(activityPath(home), 'utf8')).split('\n').filter(Boolean).slice(-limit);
    const out: Activity[] = [];
    for (const l of lines) {
      try {
        const a = JSON.parse(l) as Activity;
        if (typeof a.at === 'string' && typeof a.text === 'string') out.push(a);
      } catch {
        // skip a torn line
      }
    }
    return out;
  } catch {
    return [];
  }
}
