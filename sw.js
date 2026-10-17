const CACHE_NAME = "lanthano-research-v4";

// Filled by the "Offline App" option on support.html (offline-app.js).
// It is NOT deleted on activate, so the saved copy survives updates.
const OFFLINE_CACHE = "lanthano-offline-app";

// The offline / not-found fallback page.
const OFFLINE_URL = "/404.html";

// How long to wait for the network before using the saved copy.
const NETWORK_TIMEOUT = 6000;

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
      // Add each one separately so one missing file cannot block the install.
      Promise.all(
        [...CACHED_IMAGES, OFFLINE_URL].map(url =>
          cache.add(url).catch(() => {})
        )
      )
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

// Look in the saved copy. ignoreSearch lets "category.html?category=x" match
// the saved "category.html", and "/" match "/index.html".
async function findCached(request) {
  const options = { ignoreSearch: true };

  const direct = await caches.match(request, options);
  if (direct) return direct;

  const url = new URL(request.url);
  if (url.pathname.endsWith("/")) {
    url.search = "";
    url.pathname += "index.html";
    return caches.match(url.href, options);
  }

  return undefined;
}

// Browsers request video/audio in byte ranges. A saved file is a plain
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

// Network first. If there is a saved copy and the network is dead or very
// slow (weak signal), use the saved copy instead of waiting forever.
async function networkFirst(request, fallbackToOfflinePage) {
  const cached = await findCached(request);

  try {
    const network = fetch(request);

    const response = cached
      ? await Promise.race([
          network,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("slow")), NETWORK_TIMEOUT)
          )
        ])
      : await network;

    // Keep the saved copy fresh for files that were saved earlier.
    if (cached && response && response.status === 200) {
      const copy = response.clone();
      caches.open(OFFLINE_CACHE).then(cache => cache.put(request.url, copy)).catch(() => {});
    }

    return response;
  } catch (error) {
    if (cached) return rangeFromCache(request, cached);

    if (fallbackToOfflinePage) {
      const page = await caches.match(OFFLINE_URL);
      if (page) return page;
    }

    return Response.error();
  }
}

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);

  // Ignore requests outside this site.
  if (url.origin !== self.location.origin) return;

  // Page navigations: live site first, then the saved copy, then 404.html
  // (whose own script detects navigator.onLine to show "no connection").
  if (event.request.mode === "navigate") {
    event.respondWith(networkFirst(event.request, true));
    return;
  }

  // Everything else (scripts, JSON, PDFs, images, video).
  event.respondWith(networkFirst(event.request, false));
});
