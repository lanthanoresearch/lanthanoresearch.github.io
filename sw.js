const CACHE_NAME = "lanthano-research-v2";

// The offline / not-found fallback page, and the assets it needs
// to render correctly even with zero connection.
const OFFLINE_URL = "/404.html";
const OFFLINE_ASSETS = [
  OFFLINE_URL,
  "/file_000000000c40722f92b1fe6758cb4855.png"
];

// Hero images already cached by this service worker.
const CACHED_IMAGES = [
  "/file_0000000007f472099da6ef16a4a6ed95.png",
  "/file_00000000ecb4722f9273c2a87dca3a4c.png"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll([...CACHED_IMAGES, ...OFFLINE_ASSETS])
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    )
  );

  self.clients.claim();
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);

  // Ignore requests outside this site.
  if (url.origin !== self.location.origin) return;

  // Page navigations (clicking a link, typing a URL, refreshing a page):
  // try the network first, and if that fails outright (no connection),
  // fall back to the cached 404.html. Because it's cached, the page
  // itself is available even fully offline, and its own script detects
  // navigator.onLine to show the "no connection" state instead of the
  // "not found" state.
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request).catch(() =>
        caches.match(OFFLINE_URL)
      )
    );
    return;
  }

  // Only intercept the hero images (existing behavior).
  if (!CACHED_IMAGES.includes(url.pathname)) return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) {
        return cached;
      }

      return fetch(event.request).then(response => {
        if (!response || response.status !== 200) {
          return response;
        }

        const responseClone = response.clone();

        caches.open(CACHE_NAME).then(cache => {
          cache.put(event.request, responseClone);
        });

        return response;
      });
    })
  );
});
