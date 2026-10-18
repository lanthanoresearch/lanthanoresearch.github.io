/**
 * Lanthano Research - private video gate (Cloudflare Worker)
 *
 * The R2 bucket stays PRIVATE. Videos are only reachable through this Worker,
 * and only with a short-lived "ticket" that the website asks for when a
 * visitor taps a video. Nothing is read from the bucket until then.
 *
 *   GET /ticket?f=Nukes/Ivy%20Mike.mp4   -> { t: "<ticket>", expires: <unix> }
 *   GET /play?t=<ticket>                 -> the video (supports Range / seeking)
 *
 * Safety nets (all counted in D1, all fail CLOSED - if the counter can't be
 * read, the video is refused rather than served for free):
 *   - Only files listed in descriptions.json (not hidden with "#$") can be
 *     requested, so the bucket can't be browsed or probed.
 *   - Tickets only work for the one file they were issued for and expire.
 *   - Per-visitor (IP) limits on tickets, on playback requests and on bucket
 *     reads, per hour (and per day for tickets).
 *   - A global daily and a global monthly cap on bucket reads. When a cap is
 *     reached, videos simply stop loading until the next day/month.
 *   - Whole videos are cached at Cloudflare's edge after the first read, so
 *     repeat views and seeking don't touch the bucket at all.
 */

const DEFAULTS = {
  SITE_ORIGINS: "https://lanthanoresearch.com,https://www.lanthanoresearch.com",
  DESCRIPTIONS_URL: "https://lanthanoresearch.com/descriptions.json",

  TICKET_TTL_SECONDS: 5400,         // a ticket works for 90 minutes
  TICKETS_PER_IP_HOUR: 20,
  TICKETS_PER_IP_DAY: 60,
  PLAY_REQUESTS_PER_IP_HOUR: 400,   // seeking makes several requests
  BUCKET_READS_PER_IP_HOUR: 30,     // only cache misses ever count here
  BUCKET_READS_PER_DAY: 60000,      // everybody together
  BUCKET_READS_PER_MONTH: 8000000,  // everybody together (free tier is 10M)

  MAX_CACHE_BYTES: 200 * 1024 * 1024,
};

const enc = new TextEncoder();
let schemaReady = false;

function cfg(env, name) {
  const v = env[name];
  if (v === undefined || v === null || v === "") return DEFAULTS[name];
  return typeof DEFAULTS[name] === "number" ? Number(v) : String(v);
}

function allowedOrigins(env) {
  return String(cfg(env, "SITE_ORIGINS"))
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

/* ------------------------------ small helpers ----------------------------- */

function b64url(bytes) {
  let s = "";
  new Uint8Array(bytes).forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(env, usage) {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(env.TICKET_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage]
  );
}

async function makeTicket(env, key, exp) {
  const payload = b64url(enc.encode(JSON.stringify({ k: key, e: exp })));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(env, "sign"), enc.encode(payload));
  return payload + "." + b64url(sig);
}

async function readTicket(env, token) {
  try {
    const [payload, sig] = String(token || "").split(".");
    if (!payload || !sig) return null;
    const ok = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(env, "verify"),
      b64urlDecode(sig),
      enc.encode(payload)
    );
    if (!ok) return null;
    const data = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
    if (!data || typeof data.k !== "string" || typeof data.e !== "number") return null;
    if (data.e < Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch (e) {
    return null;
  }
}

function json(body, status, extra) {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign(
      { "Content-Type": "application/json", "Cache-Control": "no-store" },
      extra || {}
    ),
  });
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  if (origin && allowedOrigins(env).includes(origin)) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    };
  }
  return { Vary: "Origin" };
}

/* ------------------------------- counters (D1) ---------------------------- */

async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS counters (k TEXT PRIMARY KEY, n INTEGER NOT NULL, exp INTEGER NOT NULL)"
  ).run();
  schemaReady = true;
}

/** Adds 1 to a counter and returns its new value. */
async function bump(env, key, ttlSeconds) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const row = await env.DB.prepare(
    "INSERT INTO counters (k, n, exp) VALUES (?1, 1, ?2) " +
      "ON CONFLICT(k) DO UPDATE SET n = n + 1 RETURNING n"
  )
    .bind(key, exp)
    .first();
  return row ? row.n : Infinity;
}

function periods() {
  const d = new Date();
  const iso = d.toISOString(); // 2026-10-17T21:11:00.000Z
  return {
    hour: iso.slice(0, 13),
    day: iso.slice(0, 10),
    month: iso.slice(0, 7),
  };
}

async function cleanup(env) {
  if (Math.random() < 0.02) {
    await env.DB.prepare("DELETE FROM counters WHERE exp < ?1")
      .bind(Math.floor(Date.now() / 1000))
      .run();
  }
}

/** Returns a Response if a limit was hit, otherwise null. */
async function limit(env, key, max, ttl, message, status) {
  const n = await bump(env, key, ttl);
  if (n > max) {
    return json({ error: message }, status || 429, { "Retry-After": "600" });
  }
  return null;
}

/* ------------------------- which files may be served ---------------------- */

async function allowedFiles(env) {
  const res = await fetch(String(cfg(env, "DESCRIPTIONS_URL")), {
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  if (!res.ok) throw new Error("descriptions unavailable");
  const data = await res.json();
  const set = new Set();
  Object.values(data || {}).forEach((paper) => {
    (paper && Array.isArray(paper.videos) ? paper.videos : []).forEach((v) => {
      const file = typeof v === "string" ? v : v && v.file;
      if (typeof file === "string" && !file.trim().startsWith("#$")) set.add(file.trim());
    });
  });
  return set;
}

/* --------------------------------- routes --------------------------------- */

async function handleTicket(request, env, url) {
  const cors = corsHeaders(request, env);
  const origin = request.headers.get("Origin");

  if (!origin || !allowedOrigins(env).includes(origin)) {
    return json({ error: "Not allowed." }, 403, cors);
  }

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const p = periods();

  let blocked =
    (await limit(env, `tk:h:${ip}:${p.hour}`, cfg(env, "TICKETS_PER_IP_HOUR"), 7200,
      "Too many video requests. Please try again later.")) ||
    (await limit(env, `tk:d:${ip}:${p.day}`, cfg(env, "TICKETS_PER_IP_DAY"), 172800,
      "Too many video requests today. Please try again tomorrow."));
  if (blocked) {
    Object.entries(cors).forEach(([k, v]) => blocked.headers.set(k, v));
    return blocked;
  }

  const file = (url.searchParams.get("f") || "").trim();
  if (!file || file.length > 300 || file.includes("..")) {
    return json({ error: "Unknown video." }, 404, cors);
  }

  const files = await allowedFiles(env);
  if (!files.has(file)) return json({ error: "Unknown video." }, 404, cors);

  const exp = Math.floor(Date.now() / 1000) + Number(cfg(env, "TICKET_TTL_SECONDS"));
  return json({ t: await makeTicket(env, file, exp), expires: exp }, 200, cors);
}

function playHeaders(extra) {
  return Object.assign(
    {
      "Content-Type": "video/mp4",
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
    extra || {}
  );
}

async function handlePlay(request, env, ctx, url) {
  // Browsers send the page address as Referer for <video>. If it is there and
  // belongs to some other site, refuse (stops embedding on other sites).
  const referer = request.headers.get("Referer");
  if (referer) {
    let ok = false;
    try {
      ok = allowedOrigins(env).includes(new URL(referer).origin);
    } catch (e) {}
    if (!ok) return json({ error: "Not allowed." }, 403);
  }

  const ticket = await readTicket(env, url.searchParams.get("t"));
  if (!ticket) return json({ error: "This video link has expired." }, 403);

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const p = periods();

  const blocked = await limit(env, `rq:h:${ip}:${p.hour}`, cfg(env, "PLAY_REQUESTS_PER_IP_HOUR"), 7200,
    "Too many requests. Please try again later.");
  if (blocked) return blocked;

  const key = ticket.k;
  const cache = caches.default;
  const cacheUrl = "https://video-cache.invalid/" + encodeURIComponent(key);
  const range = request.headers.get("Range");

  const cacheReq = () =>
    new Request(cacheUrl, range ? { headers: { Range: range } } : undefined);

  // 1) Already cached at the edge? Serve it without touching the bucket.
  let hit = await cache.match(cacheReq());
  if (hit) return withPlayHeaders(hit);

  // 2) Not cached: this will read the bucket, so check the read limits first.
  const readBlocked =
    (await limit(env, `r2:ip:${ip}:${p.hour}`, cfg(env, "BUCKET_READS_PER_IP_HOUR"), 7200,
      "Too many requests. Please try again later.")) ||
    (await limit(env, `r2:d:${p.day}`, cfg(env, "BUCKET_READS_PER_DAY"), 172800,
      "Videos are temporarily unavailable. Please try again later.", 503)) ||
    (await limit(env, `r2:m:${p.month}`, cfg(env, "BUCKET_READS_PER_MONTH"), 3456000,
      "Videos are temporarily unavailable. Please try again later.", 503));
  if (readBlocked) return readBlocked;

  // Read the whole file once, keep it in the edge cache, and answer this
  // (and every later) request - including seeks - from there.
  const obj = await env.BUCKET.get(key);
  if (!obj) return json({ error: "Video not found." }, 404);

  if (obj.size <= Number(cfg(env, "MAX_CACHE_BYTES"))) {
    const stored = new Response(obj.body, {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(obj.size),
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=2592000",
        ETag: obj.httpEtag,
      },
    });
    await cache.put(new Request(cacheUrl), stored);

    hit = await cache.match(cacheReq());
    if (hit) return withPlayHeaders(hit);
  } else if (obj.body) {
    // Too big to cache: drop the stream we don't need.
    try { await obj.body.cancel(); } catch (e) {}
  }

  // Fallback (very large file, or the cache isn't available on this hostname):
  // read just the requested bytes. Counted again as a bucket read.
  const again = await limit(env, `r2:m:${p.month}`, cfg(env, "BUCKET_READS_PER_MONTH"), 3456000,
    "Videos are temporarily unavailable. Please try again later.", 503);
  if (again) return again;

  const part = await env.BUCKET.get(key, { range: request.headers });
  if (!part) return json({ error: "Video not found." }, 404);

  const total = part.size;
  if (part.range && range) {
    const start = part.range.offset;
    const length = part.range.length;
    return new Response(part.body, {
      status: 206,
      headers: playHeaders({
        "Content-Length": String(length),
        "Content-Range": `bytes ${start}-${start + length - 1}/${total}`,
      }),
    });
  }
  return new Response(part.body, {
    status: 200,
    headers: playHeaders({ "Content-Length": String(total) }),
  });
}

function withPlayHeaders(res) {
  const out = new Response(res.body, res);
  out.headers.set("Content-Type", "video/mp4");
  out.headers.set("Cache-Control", "private, max-age=3600");
  out.headers.set("X-Content-Type-Options", "nosniff");
  return out;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return json({ error: "Not allowed." }, 405);
    }
    const missing = [];
    if (!env.TICKET_SECRET) missing.push("TICKET_SECRET");
    if (!env.BUCKET) missing.push("BUCKET");
    if (!env.DB) missing.push("DB");
    if (missing.length) {
      return json({ error: "Videos are not set up yet.", missing }, 503);
    }

    try {
      await ensureSchema(env);
      ctx.waitUntil(cleanup(env).catch(() => {}));

      if (url.pathname === "/ticket") return await handleTicket(request, env, url);
      if (url.pathname === "/play") return await handlePlay(request, env, ctx, url);
      return json({ error: "Not found." }, 404);
    } catch (e) {
      // Fail closed: if anything (including the counters) breaks, refuse.
      return json({ error: "Videos are temporarily unavailable." }, 503, corsHeaders(request, env));
    }
  },
};
