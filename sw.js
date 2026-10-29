const CACHE_NAME = "lanthano-research-v6";

// Filled by the "Offline App" option on download.html (offline-app.js).
// It is NOT deleted on activate, so the saved copy survives updates.
const OFFLINE_CACHE = "lanthano-offline-app";

// Everything else on the site (pages, images, covers, PDFs, scripts, data)
// is kept here as it is used - only what someone actually opens or sees, never
// fetched ahead of time. Like the other two it survives updates.
const SITE_CACHE = "lanthano-site-files";

// Whole videos saved by video.html. They are only ever put in by that page,
// and played back through the fake address /__video/<file>.
const VIDEO_CACHE = "lanthano-saved-videos";
const VIDEO_PREFIX = "/__video/";

// Small on/off switches set from the Storage page ("keep pictures", "keep
// PDFs"). A worker can't read localStorage, so the page leaves a marker here.
// It is never deleted on activate.
const PREFS_CACHE = "lanthano-prefs";

async function prefOff(name) {
  try {
    const c = await caches.open(PREFS_CACHE);
    return !!(await c.match("/__pref/" + name + "-off"));
  } catch (e) {
    return false;
  }
}

// Which switch (if any) decides whether this kind of file is kept.
function prefFor(url) {
  const ext = extOf(url);
  if (/^(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/.test(ext)) return "images";
  if (ext === "pdf") return "pdfs";
  return "";
}

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
          .filter(key => ![CACHE_NAME, OFFLINE_CACHE, SITE_CACHE, VIDEO_CACHE, PREFS_CACHE].includes(key))
          .map(key => caches.delete(key))
      )
    )
  );

  // Take over open pages right away, then tell them a newer version is in
  // (site-tools.js shows a small "Refresh" message).
  event.waitUntil(
    self.clients.claim().then(() =>
      self.clients.matchAll({ type: "window" }).then(list =>
        list.forEach(c => { try { c.postMessage({ type: "lt-updated" }); } catch (e) {} })
      )
    )
  );
});

// A page can ask a waiting copy of this worker to take over now.
self.addEventListener("message", event => {
  if (event.data && event.data.type === "skip-waiting") self.skipWaiting();
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
async function rangeFromCache(request, cached, forcedType) {
  const header = request.headers.get("range");
  if (!header || !cached) return cached;

  const match = /bytes=(\d*)-(\d*)/.exec(header);
  if (!match) return cached;

  const blob = await cached.blob();
  const size = blob.size;

  let start = match[1] ? parseInt(match[1], 10) : 0;
  let end = match[2] ? parseInt(match[2], 10) : size - 1;

  if (!match[1] && match[2]) {
    start = Math.max(0, size - parseInt(match[2], 10));
    end = size - 1;
  }

  end = Math.min(end, size - 1);

  if (start > end || start >= size) {
    return new Response("", {
      status: 416,
      headers: { "Content-Range": "bytes */" + size }
    });
  }

  return new Response(blob.slice(start, end + 1), {
    status: 206,
    statusText: "Partial Content",
    headers: {
      "Content-Type": forcedType || cached.headers.get("Content-Type") || "application/octet-stream",
      "Content-Range": "bytes " + start + "-" + end + "/" + size,
      "Content-Length": String(end - start + 1),
      "Accept-Ranges": "bytes"
    }
  });
}

// Network first. If there is a saved copy and the network is dead or very
// slow (weak signal), use the saved copy instead of waiting forever.
//
// The request always asks the server whether the file changed ("no-cache"),
// so the browser's own short-lived cache can never hand back an old page or
// script after the site was updated. If the saved copy was used because the
// network was slow, the answer that arrives later still refreshes the saved
// copy for next time.
async function networkFirst(request, fallbackToOfflinePage) {
  const cached = await findCached(request);

  const fresh = fetch(request, { cache: "no-cache" }).then(response => {
    if (response && response.status === 200 && !request.headers.has("range") && looksRight(response, request.url)) {
      store(request.url, response.clone());
    }
    return response;
  });
  fresh.catch(() => {});

  try {
    return cached
      ? await Promise.race([
          fresh,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("slow")), NETWORK_TIMEOUT)
          )
        ])
      : await fresh;
  } catch (error) {
    if (cached) return rangeFromCache(request, cached);

    if (fallbackToOfflinePage) {
      const page = await caches.match(OFFLINE_URL);
      if (page) return page;
    }

    return Response.error();
  }
}

// ---------------------------------------------------------------------
// Big, rarely-changing files (images, PDFs, saved site videos).
// Served from the saved copy straight away, then checked in the background
// with a tiny "has this changed?" request. A changed file replaces the saved
// one; a saved file that doesn't look right (wrong type, an error page saved
// by mistake) is thrown away and fetched again.
// ---------------------------------------------------------------------

const FAST_EXT = /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp|pdf|mp4|webm|m4v|mov)$/i;
const CHECKED_AT = new Map();        // url -> last time it was checked
const CHECK_EVERY = 60 * 60 * 1000;  // at most once an hour per file

function extOf(url) {
  const m = /\.([a-z0-9]+)$/i.exec(new URL(url).pathname);
  return m ? m[1].toLowerCase() : "";
}

// Does this response look like the kind of file its address says it is?
function looksRight(res, url) {
  if (!res || res.status !== 200) return false;

  const type = (res.headers.get("content-type") || "").toLowerCase();
  const ext = extOf(url);

  if (/^(png|jpe?g|gif|webp|avif|bmp|ico)$/.test(ext)) return type.startsWith("image/");
  if (ext === "svg") return type.includes("svg");
  if (ext === "pdf") return type.includes("pdf");
  if (/^(mp4|webm|m4v|mov)$/.test(ext)) return type.startsWith("video/") || type.includes("octet-stream");
  if (ext === "json") return type.includes("json") || type.includes("text/plain");

  // Pages and scripts: just refuse an empty answer.
  const len = res.headers.get("content-length");
  return !(len !== null && Number(len) === 0);
}

// Save a copy in the site cache (pages without their ?query), and refresh the
// "Offline App" copy too when one exists so it can't go stale.
async function store(url, response, replacing) {
  try {
    // A new picture / PDF is only kept while its switch is on. A copy that is
    // already saved is still refreshed when the file changes.
    const pref = prefFor(url);
    if (!replacing && pref && await prefOff(pref)) return;

    const u = new URL(url);
    if (/\.html?$/i.test(u.pathname) || u.pathname.endsWith("/")) u.search = "";
    const key = u.href;

    await (await caches.open(SITE_CACHE)).put(key, response.clone());

    const offline = await caches.open(OFFLINE_CACHE);
    if (await offline.match(key)) await offline.put(key, response);
  } catch (e) {}
}

async function fastFile(event) {
  const request = event.request;
  const url = request.url;

  // The page asked for a fresh copy on purpose (saving a video to the device
  // itself): hand it straight through, and don't keep a second copy here.
  if (request.cache === "no-store" || request.cache === "reload") {
    try { return await fetch(request); } catch (error) { return Response.error(); }
  }
  const ranged = request.headers.has("range");

  let cached = await caches.match(url);

  if (cached && !looksRight(cached, url)) {
    // Saved copy is wrong: drop it and start over.
    for (const name of [SITE_CACHE, OFFLINE_CACHE]) {
      try { await (await caches.open(name)).delete(url); } catch (e) {}
    }
    cached = undefined;
  }

  if (cached) {
    const last = CHECKED_AT.get(url) || 0;

    if (Date.now() - last > CHECK_EVERY) {
      CHECKED_AT.set(url, Date.now());
      event.waitUntil(revalidate(url, cached));
    }

    return ranged ? rangeFromCache(request, cached) : cached;
  }

  // Not saved yet: fetch it, and save a copy if it's a whole, correct file.
  try {
    const response = await fetch(request);

    if (!ranged && response.status === 200 && looksRight(response, url)) {
      event.waitUntil(store(url, response.clone()));
    }

    return response;
  } catch (error) {
    return Response.error();
  }
}

// Ask the server "has it changed?" (a 304 costs almost nothing). Only a
// changed, correct file replaces the saved copy.
async function revalidate(url, cached) {
  try {
    const headers = {};
    const etag = cached.headers.get("etag");
    const modified = cached.headers.get("last-modified");
    if (etag) headers["If-None-Match"] = etag;
    if (modified) headers["If-Modified-Since"] = modified;

    const res = await fetch(url, { headers, cache: "no-cache" });

    if (res.status === 304) return;

    if (looksRight(res, url)) {
      await store(url, res, true);
    }
  } catch (e) {
    // Offline or a bad moment: keep the saved copy, try again later.
  }
}

// ---------------------------------------------------------------------
// Videos saved by video.html
// ---------------------------------------------------------------------

async function savedVideo(request) {
  const cache = await caches.open(VIDEO_CACHE);
  const cached = await cache.match(request.url, { ignoreSearch: true });

  if (!cached) return new Response("", { status: 404 });

  const type = cached.headers.get("Content-Type") || "video/mp4";

  if (!request.headers.has("range")) return cached;

  return rangeFromCache(request, cached, type);
}

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);

  // Ignore requests outside this site.
  if (url.origin !== self.location.origin) return;

  // Whole videos saved by video.html (played from the device).
  if (url.pathname.startsWith(VIDEO_PREFIX)) {
    event.respondWith(savedVideo(event.request));
    return;
  }

  // Page navigations: live site first, then the saved copy, then 404.html
  // (whose own script detects navigator.onLine to show "no connection").
  if (event.request.mode === "navigate") {
    event.respondWith(networkFirst(event.request, true));
    return;
  }

  // Images, PDFs and similar big files: saved copy first, checked in the
  // background, replaced if the file changed.
  if (FAST_EXT.test(url.pathname)) {
    event.respondWith(fastFile(event));
    return;
  }

  // Everything else (scripts, JSON, styles): live first, saved copy as backup.
  event.respondWith(networkFirst(event.request, false));
});
