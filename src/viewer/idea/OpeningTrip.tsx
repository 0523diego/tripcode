// Shown for #/trip/<id> when <id> is not in the loaded trips. Normally that is just a wrong link (Home is shown), but
// right after step 0 created the trip, Vite may not have picked up its files yet: then wait, reload once, and only
// then give up. Without this the user would land on Home or the bundled sample.
import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { clearLanding, markReloaded, readLanding } from './landing.ts';

const WAIT_MS = 1500;

export function OpeningTrip({ id, fallback }: { id: string; fallback: ReactNode }) {
  const landing = readLanding();
  const waiting = !!landing && landing.tripId === id && !landing.reloaded;
  useEffect(() => {
    if (!waiting) return;
    const t = setTimeout(() => {
      markReloaded();
      window.location.reload();
    }, WAIT_MS);
    return () => clearTimeout(t);
  }, [waiting]);
  useEffect(() => {
    // Reloaded and still unknown: stop waiting so the next visit is a normal one.
    if (landing && landing.tripId === id && landing.reloaded) clearLanding();
  }, [landing, id]);
  if (!waiting) return <>{fallback}</>;
  return (
    <main className="idea-opening" role="status">
      正在打開行程…
    </main>
  );
}
