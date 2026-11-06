// Remembers "an idea just became trip X" across the page reload Vite does when it picks up the new trip.ts, so the
// user lands on the trip instead of on Home or the sample trip. Stored in sessionStorage; every access is guarded.
const KEY = 'tripcode.idea.landing';

export interface Landing {
  ideaId: string;
  tripId: string;
  /** We already reloaded once to make Vite's glob see the new trip. */
  reloaded?: boolean;
}

export function readLanding(): Landing | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as Landing | null;
    return v && typeof v.ideaId === 'string' && typeof v.tripId === 'string' ? v : null;
  } catch {
    return null;
  }
}

function write(l: Landing | null): void {
  try {
    if (l) sessionStorage.setItem(KEY, JSON.stringify(l));
    else sessionStorage.removeItem(KEY);
  } catch {
    /* private mode: the fallback just does not apply */
  }
}

export const markLanding = (ideaId: string, tripId: string): void => write({ ideaId, tripId });
export const clearLanding = (): void => write(null);
export function markReloaded(): void {
  const l = readLanding();
  if (l) write({ ...l, reloaded: true });
}
