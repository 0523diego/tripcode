// trips/<id>/food.json on disk: read (a missing file is an empty guide), write atomically, update through a pure function.
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { CliError, checkTripId } from './context.ts';
import { emptyFood, parseFood } from '../src/core/food.ts';
import type { FoodFile } from '../src/core/food-types.ts';

export const foodPath = (root: string, tripId: string) => path.join(root, 'trips', checkTripId(tripId), 'food.json');

export async function readFood(root: string, tripId: string): Promise<FoodFile> {
  let text: string;
  try {
    text = await readFile(foodPath(root, tripId), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return emptyFood();
    throw e;
  }
  try {
    return parseFood(JSON.parse(text));
  } catch (e) {
    throw new CliError(`trips/${tripId}/food.json 有問題：${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function writeFood(root: string, tripId: string, food: FoodFile): Promise<void> {
  const dir = path.join(root, 'trips', checkTripId(tripId));
  try {
    if (!(await stat(dir)).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new CliError(`找不到 trips/${tripId}/（先建立行程）`);
  }
  const file = foodPath(root, tripId);
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dir, { recursive: true });
  await writeFile(tmp, `${JSON.stringify(food, null, 2)}\n`);
  await rename(tmp, file);
}

/** One update at a time per trip file: two quick votes must both land (read-modify-write has no lock of its own). */
const queues = new Map<string, Promise<unknown>>();

export function updateFood(root: string, tripId: string, fn: (f: FoodFile) => FoodFile): Promise<FoodFile> {
  const key = foodPath(root, tripId);
  const run = (queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const next = fn(await readFood(root, tripId));
    await writeFood(root, tripId, next);
    return next;
  });
  queues.set(key, run);
  void run.finally(() => {
    if (queues.get(key) === run) queues.delete(key);
  }).catch(() => undefined);
  return run;
}
