const CACHE_NAME = "lanthano-research-v3";

// Filled by the "Offline App" feature on support.html. It is NOT deleted
// on activate, so a full offline copy survives service worker updates.
const OFFLINE_CACHE = "lanthano-offline-app";

// The offline / not-found fallback page.
const OFFLINE_URL = "/404.html";

// Hero images already cached by this service worker.
const CACHED_IMAGES = [
  "/file_0000000007f472099da6ef16a4a6ed95.png",
  "/file_00000000ecb4722f9273c2a87dca3a4c.png",
  // Site icon shown on 404.html - precached so it's already available
  // (no network round trip) the moment that page opens.
  "/file_000000000c40722f92b1fe6758cb4855.png"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll([...CACHED_IMAGES, OFFLINE_URL])
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME && key !== OFFLINE_CACHE)
          .map(key => caches.delete(key))
      )
    )
  );

  self.clients.claim();
});

// Look in the offline copy first, then the regular cache.
// ignoreSearch lets "category.html?category=x" match the saved "category.html".
async function findCached(request) {
  const options = { ignoreSearch: true };
  return (
    (await caches.match(request, options)) ||
    undefined
  );
}

// Browsers request video/audio in byte ranges. A cached file is a plain
// 200 response, so slice it into a proper 206 when a range is asked for.
async function rangeFromCache(request, cached) {
  const header = request.headers.get("range");
  if (!header || !cached) return cached;

  const match = /bytes=(\d*)-(\d*)/.exec(header);
  if (!match) return cached;

  const buffer = await cached.arrayBuffer();
  const size = buffer.byteLength;

  let start = match[1] ? parseInt(match[1], 10) : 0;
  let end = match[2] ? parseInt(match[2], 10) : size - 1;

  if (!match[1] && match[2]) {
    start = Math.max(0, size - parseInt(match[2], 10));
    end = size - 1;
  }

  end = Math.min(end, size - 1);

  return new Response(buffer.slice(start, end + 1), {
    status: 206,
    statusText: "Partial Content",
    headers: {
      "Content-Type": cached.headers.get("Content-Type") || "application/octet-stream",
      "Content-Range": "bytes " + start + "-" + end + "/" + size,
      "Content-Length": String(end - start + 1),
      "Accept-Ranges": "bytes"
    }
  });
}

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);

  // Ignore requests outside this site.
  if (url.origin !== self.location.origin) return;

  // Page navigations: network first (so the live site is always current),
  // then the offline copy, then the cached 404.html as a last resort.
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request).catch(async () => {
        const cached = await findCached(event.request);
        if (cached) return cached;
        return caches.match(OFFLINE_URL);
      })
    );
    return;
  }

  // Everything else (scripts, JSON, PDFs, images, video):
  // network first, fall back to the offline copy when there is no connection.
  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Keep the precached hero images fresh (existing behavior).
        if (
          CACHED_IMAGES.includes(url.pathname) &&
          response &&
          response.status === 200
        ) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      })
      .catch(async () => {
        const cached = await findCached(event.request);
        if (cached) return rangeFromCache(event.request, cached);
        return Response.error();
      })
  );
});
