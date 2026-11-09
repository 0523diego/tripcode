// Client side of the food guide: reads trips/<id>/food.json through the dev server and keeps it fresh. Like idea.json it is NOT
// imported through a Vite glob (that would reload the page on every vote); the server watches the file and sends a
// `tripcode:food` event, and we refetch. Our own writes use the answer directly.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FoodFile } from '../../core/food-types.ts';
import { post } from '../api.ts';
import type { ApiResult } from '../api.ts';

export const FOOD_EVENT = 'tripcode:food';
export type FoodResult = ApiResult & { food?: FoodFile };

function onFoodChanged(fn: (tripId: string) => void): () => void {
  const hot = import.meta.hot;
  if (!hot) return () => {};
  const cb = (data: { tripId?: string }) => {
    if (typeof data?.tripId === 'string') fn(data.tripId);
  };
  hot.on(FOOD_EVENT, cb);
  return () => hot.off?.(FOOD_EVENT, cb);
}

export interface FoodHandle {
  food: FoodFile | null;
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  /** Sends a `food` op (vote, taste, reject, guide); the answer replaces the state. */
  run: (body: Record<string, unknown>) => Promise<FoodResult>;
}

export function useFood(tripId: string): FoodHandle {
  const [food, setFood] = useState<FoodFile | null>(null);
  const [status, setStatus] = useState<FoodHandle['status']>('loading');
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const load = useCallback(async () => {
    const r = (await post('food', { tripId, op: 'get' })) as FoodResult;
    if (!alive.current) return;
    if (r.ok && r.food) {
      setFood(r.food);
      setStatus('ready');
      setError(null);
    } else {
      setStatus('error');
      setError(r.error ?? '讀不到這趟的吃什麼');
    }
  }, [tripId]);

  useEffect(() => {
    alive.current = true;
    void load();
    const off = onFoodChanged((id) => {
      if (id === tripId) void load();
    });
    return () => {
      alive.current = false;
      off();
    };
  }, [tripId, load]);

  const run = useCallback(
    async (body: Record<string, unknown>): Promise<FoodResult> => {
      const r = (await post('food', { tripId, ...body })) as FoodResult;
      if (r.ok && r.food && alive.current) setFood(r.food);
      else if (r.ok && body.op === 'guide') void load();
      return r;
    },
    [tripId, load],
  );

  return { food, status, error, run };
}
