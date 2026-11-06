// App-shell service worker.
//
// Caching scope (audit F-8.5): only SAME-ORIGIN GET requests are ever
// cached — the app shell and its static assets. Data is never cached:
// cross-origin requests (Supabase REST at *.supabase.co, font CDNs, …)
// and this origin's own /api/ routes bypass the worker entirely and go
// straight to the network, as does anything non-GET.
//
// Strategy stays network-first for everything handled: a fresh response
// wins whenever the network answers; the cache is the offline fallback,
// and a navigation that misses both falls back to the cached shell.
//
// The cache name is VERSIONED — bump SW_VERSION whenever this file
// changes (or a deploy must not inherit a stale shell): activate deletes
// every older cache before claiming clients.
const SW_VERSION = "v2";
const CACHE = `afkari-${SW_VERSION}`;

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (e) =>
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  ),
);

const isCacheable = (request) => {
  if (request.method !== "GET") return false;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith("/api/")) return false;
  return true;
};

self.addEventListener("fetch", (e) => {
  if (!isCacheable(e.request)) return;
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        if (r.ok) {
          const copy = r.clone();
          caches.open(CACHE).then((cache) => cache.put(e.request, copy));
        }
        return r;
      })
      .catch(() =>
        caches
          .match(e.request)
          .then((r) => r || (e.request.mode === "navigate" ? caches.match("/") : undefined)),
      ),
  );
});
