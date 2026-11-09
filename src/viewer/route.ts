// Tiny hash router: "#/" is the home page, "#/trip/<id>" opens a trip, "#/trip/<id>/office" its 訂票清單, "#/trip/<id>/print?..." its print page, "#/idea/<id>" step 0 (找方向). Hash routes work with the
// dev server, `vite build` output and file:// alike, and the browser back button returns home.
import { useEffect, useState } from 'react';

export type Route = { name: 'home' } | { name: 'trip'; id: string } | { name: 'office'; id: string } | { name: 'print'; id: string; query: string } | { name: 'idea'; id: string };

export function parseRoute(hash: string): Route {
  const print = /^#\/trip\/([a-z0-9-]+)\/print\/?(?:\?(.*))?$/.exec(hash);
  if (print) return { name: 'print', id: print[1]!, query: print[2] ?? '' };
  const office = /^#\/trip\/([a-z0-9-]+)\/office\/?$/.exec(hash);
  if (office) return { name: 'office', id: office[1]! };
  const idea = /^#\/idea\/([a-z0-9-]+)\/?$/.exec(hash);
  if (idea) return { name: 'idea', id: idea[1]! };
  const m = /^#\/trip\/([a-z0-9-]+)\/?$/.exec(hash);
  return m ? { name: 'trip', id: m[1]! } : { name: 'home' };
}

export function go(path: '/' | `/trip/${string}` | `/trip/${string}/office` | `/idea/${string}`): void {
  window.location.hash = path;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}
