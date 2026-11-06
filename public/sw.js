// TripCode service worker: network-first for the app, cache-first for map tiles; falls back to cached copies offline.
// Registered only in production builds (see src/viewer/main.tsx).
const CACHE = 'tripcode-v1';
// Basemap tiles live in their own cache so the app-shell cache never evicts them (and they never evict it).
const TILE_CACHE = 'tripcode-tiles-v1';
const TILE_LIMIT = 300;
const SHELL = ['/', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== TILE_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** Cross-origin raster tile: .../{z}/{x}/{y}[@2x].png|jpg|webp, requested as an image. */
function isTileRequest(req, url) {
  return (
    req.destination === 'image' &&
    url.origin !== self.location.origin &&
    /\/\d{1,2}\/\d+\/\d+(@2x)?\.(png|jpe?g|webp)$/.test(url.pathname)
  );
}

/** Keeps at most TILE_LIMIT tiles; the oldest-inserted go first (Cache.keys() is in insertion order). */
async function trimTiles(cache) {
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - TILE_LIMIT)).map((k) => cache.delete(k)));
}

async function tileResponse(req) {
  const cache = await caches.open(TILE_CACHE);
  const hit = await cache.match(req, { ignoreVary: true });
  if (hit) return hit;
  try {
    // A CORS fetch yields a readable response (opaque ones are padded to several MB each in the storage quota).
    // Tile servers send Access-Control-Allow-Origin: *; one that does not is served straight from the network.
    const res = await fetch(req.url, { mode: 'cors', credentials: 'omit' });
    if (res.status === 200) {
      await cache.put(req, res.clone());
      await trimTiles(cache);
    }
    return res;
  } catch {
    try {
      return await fetch(req);
    } catch {
      return Response.error();
    }
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (isTileRequest(req, url)) {
    event.respondWith(tileResponse(req));
    return;
  }
  if (url.origin !== self.location.origin || url.pathname.startsWith('/__tripcode/')) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        // Only complete same-origin responses: cache.put() rejects 206 partials, and an error page
        // or redirect must never replace a good cached copy.
        if (res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches
            .open(CACHE)
            .then((cache) => cache.put(req, copy))
            .catch(() => {});
        }
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(req);
        if (hit) return hit;
        // Offline navigation to any route: serve the cached app shell.
        if (req.mode === 'navigate') {
          const shell = await caches.match('/');
          if (shell) return shell;
        }
        return Response.error();
      }),
  );
});
