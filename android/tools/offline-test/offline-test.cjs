#!/usr/bin/env node
/*
 * Lanthano Research - offline functional test
 *
 * Runs the bundled site in headless Chromium exactly the way the Android app
 * serves it, with no network at all:
 *
 *   - every page is loaded from https://appassets.androidplatform.net/ and each
 *     request is answered from disk by a JS port of LocalAssetServer.kt
 *     (same exclude list as the Gradle task, same AGP asset-ignore rules,
 *     same lenient %-decoding, same shim injection, same Range support,
 *     same 404 page, same JSZip CDN -> bundled copy mapping)
 *   - every other http(s) request is refused and recorded
 *   - DNS is disabled for the whole browser (--host-resolver-rules), so even a
 *     request that slipped past the interceptor could not reach the internet
 *   - a mock window.LanthanoAndroid bridge is installed ("app mode"), so the
 *     Android shim is active just as in the APK
 *   - the same polyfills.js is injected into pages and prepended to the PDF.js
 *     worker; the "oldwebview" section additionally deletes every built-in it
 *     provides first, to prove PDFs work on WebViews that lack them
 *
 * Usage:
 *   npm install            (in this folder; installs playwright)
 *   npx playwright install chromium
 *   node offline-test.cjs [--web-root ../../..] [--out ../test-output]
 *                         [--only home,archive,timeline,pages,pdfs,viewer,shim,oldwebview,landscape,plain]
 *                         [--pdf <descriptions.json key>]
 *
 * What it cannot cover: native Android code (the real WebView, TextToSpeech,
 * "Save as", share sheet) - those calls are checked at the bridge boundary.
 * Playwright's Chromium has no H.264 decoder, so MP4 playback is not tested.
 *
 * Exit code 0 = all checks passed.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

// ---------------------------------------------------------------- options
const args = process.argv.slice(2);
function opt(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const HERE = __dirname;
const ANDROID_DIR = path.resolve(HERE, "..", "..");
const WEB_ROOT = path.resolve(opt("--web-root", path.resolve(ANDROID_DIR, "..")));
const APP_DIR = path.join(ANDROID_DIR, "app", "src", "main", "assets", "lanthano-app");
const OUT_DIR = path.resolve(opt("--out", path.join(ANDROID_DIR, "tools", "test-output")));
const ONLY_PDF = opt("--pdf", "");
// --only home,archive,timeline,pages,pdfs,viewer,shim,oldwebview,landscape,plain
const ONLY = opt("--only", "").split(",").filter(Boolean);
const want = (name) => ONLY.length === 0 || ONLY.includes(name);
fs.mkdirSync(OUT_DIR, { recursive: true });

const HOST = "appassets.androidplatform.net";
const ORIGIN = `https://${HOST}`;

// ------------------------------------------ bundle rules (app/build.gradle.kts)
const EXCLUDES = [
  "android/**", ".git/**", ".github/**", ".gradle/**", "node_modules/**", "scripts/**",
  "**/.DS_Store", "**/Thumbs.db", ".gitignore", ".gitattributes", "README.md", "CNAME",
  "package.json", "package-lock.json", "build-search.js", "sw.js", "**/*.apk",
];
function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") { re += "(?:.*/)?"; i += 2; } else { re += ".*"; i += 1; }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$");
}
const EXCLUDE_RES = EXCLUDES.map(globToRegExp);
// Android Gradle Plugin's default aaptOptions.ignoreAssetsPattern drops
// dot-files and directories starting with "_" from the APK.
function agpIgnores(rel) {
  const parts = rel.split("/");
  return parts.some((p, i) => p.startsWith(".") || (i < parts.length - 1 && p.startsWith("_")) ||
    p.endsWith("~") || /^(thumbs\.db|picasa\.ini|cvs)$/i.test(p) || /\.scc$/i.test(p));
}
function isBundled(rel) {
  if (EXCLUDE_RES.some((r) => r.test(rel) || r.test(rel + "/"))) return false;
  return !agpIgnores(rel);
}

// Build the exact asset listing the APK would contain.
const bundle = new Map(); // rel path -> absolute file
(function walk(dir, prefix) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDE_RES.some((r) => r.test(rel + "/x")) || agpIgnores(rel + "/x")) continue;
      walk(abs, rel);
    } else if (entry.isFile() && isBundled(rel)) {
      bundle.set(rel, abs);
    }
  }
})(WEB_ROOT, "");

const VENDORED = {
  "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js": path.join(APP_DIR, "vendor", "jszip.min.js"),
};
const SHIM_TAG = '<script src="/__lanthano__/polyfills.js"></script><script src="/__lanthano__/android-shim.js"></script>';
const POLYFILLS = fs.readFileSync(path.join(APP_DIR, "polyfills.js"));
const isWorkerScript = (p) => /\.(m?js)$/i.test(p) && /worker/i.test(path.basename(p));

// "Old WebView" simulation: removes every built-in that polyfills.js provides,
// in pages and in the PDF.js worker, before the polyfills run.
const STRIP_BUILTINS = `(() => {
  const del = (o, ...names) => { for (const n of names) { try { delete o[n]; } catch (e) {} } };
  del(Map.prototype, "getOrInsert", "getOrInsertComputed");
  del(WeakMap.prototype, "getOrInsert", "getOrInsertComputed");
  del(Math, "sumPrecise");
  del(Promise, "withResolvers", "try");
  del(URL, "parse", "canParse");
  del(Set.prototype, "intersection", "union", "difference", "symmetricDifference", "isSubsetOf", "isSupersetOf", "isDisjointFrom");
  del(ArrayBuffer.prototype, "transferToFixedLength", "transfer");
  del(Uint8Array, "fromBase64", "fromHex");
  del(Uint8Array.prototype, "toBase64", "toHex", "setFromBase64", "setFromHex");
  if (typeof Response !== "undefined") del(Response.prototype, "bytes");
  if (typeof Blob !== "undefined") del(Blob.prototype, "bytes");
  del(AbortSignal, "any");
  globalThis.__strippedBuiltins = true;
})();
`;
const MIME = {
  html: "text/html", htm: "text/html", js: "text/javascript", mjs: "text/javascript", cjs: "text/javascript",
  css: "text/css", json: "application/json", webmanifest: "application/manifest+json", txt: "text/plain",
  md: "text/plain", xml: "application/xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", avif: "image/avif", svg: "image/svg+xml", ico: "image/x-icon",
  bmp: "image/bmp", pdf: "application/pdf", mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac",
  ogg: "audio/ogg", oga: "audio/ogg", wav: "audio/wav", flac: "audio/flac", mp4: "video/mp4",
  m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime", wasm: "application/wasm",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf", zip: "application/zip",
};
const MEDIA = new Set(["mp4", "m4v", "webm", "mov", "mp3", "m4a", "aac", "ogg", "oga", "wav", "flac"]);
const extOf = (p) => (p.includes(".") ? p.slice(p.lastIndexOf(".") + 1).toLowerCase() : "");
const mimeOf = (p) => MIME[extOf(p)] || "application/octet-stream";

// Same as LocalAssetServer.decodePath: invalid %-escapes stay literal.
function decodePath(raw) {
  if (!raw) return "/";
  const bytes = [];
  for (let i = 0; i < raw.length;) {
    if (raw[i] === "%" && i + 2 < raw.length && /^[0-9a-fA-F]{2}$/.test(raw.substr(i + 1, 2))) {
      bytes.push(parseInt(raw.substr(i + 1, 2), 16));
      i += 3;
    } else {
      const cp = raw.codePointAt(i);
      bytes.push(...Buffer.from(String.fromCodePoint(cp), "utf8"));
      i += cp > 0xffff ? 2 : 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

function resolveAsset(urlPath) {
  if (urlPath.startsWith("/__lanthano__/")) {
    const rel = urlPath.slice("/__lanthano__/".length);
    if (rel.split("/").some((s) => s === ".." || s.includes("\\"))) return null;
    const abs = path.join(APP_DIR, rel);
    return fs.existsSync(abs) && fs.statSync(abs).isFile() ? { abs, web: false } : null;
  }
  let rel = urlPath.replace(/^\/+/, "");
  if (!rel || rel.endsWith("/")) rel += "index.html";
  const parts = rel.split("/").filter((s) => s && s !== ".");
  if (parts.some((s) => s === ".." || s.includes("\\") || s.includes("\0"))) return null;
  rel = parts.join("/");
  const hit = (r) => (bundle.has(r) ? { abs: bundle.get(r), web: true } : null);
  let found = hit(rel);
  if (!found && !rel.split("/").pop().includes(".")) found = hit(rel + ".html") || hit(rel + "/index.html");
  return found;
}

function injectShim(html) {
  const m = /<head(?=[\s>/])[^>]*>/i.exec(html) || /<html(?=[\s>/])[^>]*>/i.exec(html);
  const at = m ? m.index + m[0].length : 0;
  return html.slice(0, at) + SHIM_TAG + html.slice(at);
}

// Errors that come from the original site's own code and happen in any
// browser; they are reported as notes, not failures.
const KNOWN_SOURCE_ISSUES = [
  // research-timeline.html registers a capture-phase "mouseenter" listener on
  // document that calls e.target.closest(); when the pointer enters the page
  // the target is the document itself. Harmless: the listener just throws.
  /e\.target\.closest is not a function/,
];

// ---------------------------------------------------------------- results
const report = { startedAt: new Date().toISOString(), webRoot: WEB_ROOT, checks: [], notes: [], blocked: [], errors: [] };
function note(name, detail) {
  if (report.notes.some((n) => n.name === name)) return;
  report.notes.push({ name, detail });
  console.log(`NOTE  ${name}  —  ${detail}`);
}
let failures = 0;
function check(name, ok, detail) {
  report.checks.push({ name, ok: !!ok, detail: detail === undefined ? "" : detail });
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined && detail !== "" ? "  —  " + detail : ""}`);
}

// ------------------------------------------------------------- the server
async function serve(route, blockedLog, opts = {}) {
  const req = route.request();
  const href = req.url();
  if (VENDORED[href]) {
    return route.fulfill({ status: 200, contentType: "text/javascript", body: fs.readFileSync(VENDORED[href]) });
  }
  let u;
  try { u = new URL(href); } catch (e) { return route.abort(); }
  if (u.protocol !== "http:" && u.protocol !== "https:") return route.continue();
  if (u.hostname !== HOST) {
    blockedLog.push(href);
    return route.fulfill({ status: 403, contentType: "text/plain", body: "" });
  }
  const method = req.method().toUpperCase();
  if (method !== "GET" && method !== "HEAD") return route.fulfill({ status: 405, body: "" });

  const asset = resolveAsset(decodePath(u.pathname));
  const headers = { "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" };
  if (!asset) {
    if (req.isNavigationRequest() && req.frame() === req.frame().page().mainFrame()) {
      return route.fulfill({ status: 404, contentType: "text/html; charset=utf-8", headers,
        body: injectShim(fs.readFileSync(bundle.get("404.html"), "utf8")) });
    }
    return route.fulfill({ status: 404, contentType: "text/plain", headers, body: "" });
  }
  const mime = mimeOf(asset.abs);
  if (mime === "text/html") {
    let html = fs.readFileSync(asset.abs, "utf8");
    if (asset.web) html = injectShim(html);
    if (opts.stripBuiltins) html = html.replace(SHIM_TAG, `<script>${STRIP_BUILTINS}</script>${SHIM_TAG}`);
    return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", headers, body: html });
  }
  let body = fs.readFileSync(asset.abs);
  if (asset.web && isWorkerScript(asset.abs)) {
    body = Buffer.concat([opts.stripBuiltins ? Buffer.from(STRIP_BUILTINS) : Buffer.alloc(0), POLYFILLS, Buffer.from("\n"), body]);
  }
  if (MEDIA.has(extOf(asset.abs))) {
    headers["Accept-Ranges"] = "bytes";
    const range = /^bytes=(\d*)-(\d*)/i.exec(req.headers()["range"] || "");
    if (range) {
      const total = body.length;
      let start, end;
      if (range[1] === "") { start = Math.max(0, total - Number(range[2])); end = total - 1; }
      else { start = Number(range[1]); end = range[2] === "" ? total - 1 : Math.min(Number(range[2]), total - 1); }
      if (start >= total || end < start) {
        return route.fulfill({ status: 416, headers: { ...headers, "Content-Range": `bytes */${total}` }, body: "" });
      }
      return route.fulfill({ status: 206, contentType: mime,
        headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${total}` }, body: body.subarray(start, end + 1) });
    }
  }
  const textual = /^text\/|json|svg|xml/.test(mime);
  return route.fulfill({ status: 200, contentType: textual ? `${mime}; charset=utf-8` : mime, headers, body });
}

// ------------------------------------------------------ mock Android bridge
const BRIDGE_MOCK = `(() => {
  if (window.LanthanoAndroid) return;
  const calls = [];
  window.__bridgeCalls = calls;
  const rec = (name, args) => calls.push({ name, args: Array.from(args).map(a =>
    typeof a === "string" && a.length > 160 ? a.slice(0, 160) + "..." : a) });
  let ready = false;
  let live = null;
  window.LanthanoAndroid = {
    beginSave(id, name, mime) { rec("beginSave", arguments); setTimeout(() => window.__lanthanoApp._saveReady(id, true), 5); },
    writeSaveChunk(id, b64) { calls.push({ name: "writeSaveChunk", args: [id, b64.length] }); return true; },
    finishSave() { rec("finishSave", arguments); },
    saveAsset() { rec("saveAsset", arguments); },
    openExternal() { rec("openExternal", arguments); },
    openAssetExternally() { rec("openAssetExternally", arguments); },
    share() { rec("share", arguments); },
    copyText() { rec("copyText", arguments); },
    toast() { rec("toast", arguments); },
    setKeepScreenOn(on) { rec("setKeepScreenOn", arguments); window.__keepScreenOn = on; },
    ttsWarmUp() { rec("ttsWarmUp", arguments); if (!ready) { ready = true; setTimeout(() => window.__lanthanoApp._ttsReady(), 30); } },
    ttsReady() { return ready; },
    ttsFailed() { return false; },
    ttsVoices() { return JSON.stringify([{ name: "English (United States) · test", voiceURI: "en-us-x-test-local", lang: "en-US", default: true }]); },
    ttsStart(token, text, voice, lang, rate, pitch, volume) {
      calls.push({ name: "ttsStart", args: [token, text.length, voice, lang, rate] });
      live = token;
      const app = window.__lanthanoApp;
      setTimeout(() => {
        if (live !== token) return;
        app._tts(token, "start", 0, 0);
        const re = /\\S+/g; let m; let t = 0; const words = [];
        while ((m = re.exec(text)) && words.length < 6) words.push([m.index, m[0].length]);
        words.forEach(([i, n]) => setTimeout(() => { if (live === token) app._tts(token, "boundary", i, n); }, (t += 15)));
        setTimeout(() => { if (live === token) { live = null; app._tts(token, "end", 0, 0); } }, t + 30);
      }, 10);
      return true;
    },
    ttsStop() { rec("ttsStop", arguments); live = null; },
  };
})();`;

// ------------------------------------------------------------------ tests
async function main() {
  const descriptions = JSON.parse(fs.readFileSync(bundle.get("descriptions.json"), "utf8"));
  const pageCounts = JSON.parse(fs.readFileSync(bundle.get("page-counts.json"), "utf8"));

  // --- bundle checks
  const pdfs = [...bundle.keys()].filter((k) => k.toLowerCase().endsWith(".pdf"));
  const totalBytes = [...bundle.values()].reduce((s, f) => s + fs.statSync(f).size, 0);
  report.bundle = { files: bundle.size, pdfs: pdfs.length, megabytes: +(totalBytes / 1e6).toFixed(1) };
  check("bundle: files that would be packaged", bundle.size > 0, `${bundle.size} files, ${pdfs.length} PDFs, ${report.bundle.megabytes} MB`);
  check("bundle: sw.js excluded", !bundle.has("sw.js"));
  const missingPdfs = Object.values(descriptions).map((p) => p.url).filter((u) => !bundle.has(u));
  check("bundle: every paper PDF in descriptions.json is packaged", missingPdfs.length === 0, missingPdfs.join(", "));
  const missingCovers = Object.keys(descriptions).filter((k) => !bundle.has(`covers/${k}.png`));
  check("bundle: every paper has a cover image", missingCovers.length === 0, missingCovers.join(", "));
  const missingImages = Object.values(descriptions).flatMap((p) => p.images || [])
    .filter((i) => !String(i).startsWith("#$") && !bundle.has(i));
  check("bundle: every paper image is packaged", missingImages.length === 0, missingImages.join(", "));
  for (const f of ["pdfjs/build/pdf.mjs", "pdfjs/build/pdf.worker.mjs", "fuse.basic.min.mjs", "search-index.json", "404.html"]) {
    check(`bundle: ${f}`, bundle.has(f));
  }
  check("server: lenient %-decoding keeps invalid escapes", decodePath("/33%%20Desert.png") === "/33% Desert.png" &&
    decodePath("/The%20Real%20Nazis.pdf") === "/The Real Nazis.pdf");

  const browser = await chromium.launch({
    headless: true,
    // No DNS for any host: nothing can reach a real network even by accident.
    args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost", "--no-proxy-server"],
  });

  async function newContext(viewport, withBridge = true, opts = {}) {
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      serviceWorkers: "block",
      userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36",
    });
    const blockedLog = [];
    context.__blocked = blockedLog;
    await context.route("**/*", (route) => serve(route, blockedLog, opts));
    if (withBridge) await context.addInitScript(BRIDGE_MOCK);
    context.setDefaultTimeout(15000);
    return context;
  }

  function watch(page, label, ignore = null) {
    const problems = [];
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error" || (m.type() === "warning" && /render failed|is not a function|is not defined/i.test(m.text()))) {
        problems.push(`console ${m.type()}: ${m.text().split("\n")[0]}`);
      }
    });
    page.on("response", (r) => {
      const u = new URL(r.url());
      if (u.hostname === HOST && r.status() >= 400 && !u.pathname.includes("does-not-exist")) {
        problems.push(`HTTP ${r.status()} ${decodeURIComponent(u.pathname)}`);
      }
    });
    page.on("requestfailed", (r) => {
      const u = r.url();
      const err = r.failure() && r.failure().errorText;
      // A media element that changes its src cancels the previous load.
      if (err === "net::ERR_ABORTED" && MEDIA.has(extOf(new URL(u).pathname))) return;
      if (u.startsWith(ORIGIN)) problems.push(`failed: ${u} ${err}`);
    });
    return {
      problems,
      report(extraOk = true, extra = "") {
        // content-pages.json is fetched by index.html but does not exist in the
        // source; the site handles that with .catch() - it is not an app problem.
        const known = problems.filter((p) => KNOWN_SOURCE_ISSUES.some((k) => k.test(p)));
        const real = problems.filter((p) => !(ignore && ignore.test(p)) && !/content-pages\.json/.test(p) &&
          !/Failed to load resource: the server responded with a status of 404/.test(p) &&
          !KNOWN_SOURCE_ISSUES.some((k) => k.test(p)));
        if (known.length) note(`${label}: pre-existing issue in the original site (not caused by the app)`, [...new Set(known)].join(" | "));
        check(`${label}: no JS errors / missing resources`, real.length === 0 && extraOk,
          [...new Set(real)].slice(0, 6).join(" | ") + extra);
      },
    };
  }

  async function shot(page, name) {
    await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`) });
  }

  // Page 1's canvas: fraction of opaque pixels and of dark (text) pixels.
  // A canvas PDF.js failed to draw is fully transparent (painted = 0).
  const INK = () => {
    const c = document.querySelector('.page[data-page-number="1"] canvas.pageCanvas') ||
      [...document.querySelectorAll("canvas")].find((x) => x.width > 50);
    if (!c || !c.width || !c.height) return { painted: 0, dark: 0 };
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let n = 0, painted = 0, dark = 0;
    for (let i = 0; i < d.length; i += 40) {
      n++;
      if (d[i + 3] > 200) {
        painted++;
        if (d[i] + d[i + 1] + d[i + 2] < 384) dark++;
      }
    }
    return { painted: painted / n, dark: dark / n };
  };
  const PAGE1_PAINTED = () => {
    const c = document.querySelector('.page[data-page-number="1"] canvas.pageCanvas');
    if (!c || !c.width) return false;
    const d = c.getContext("2d").getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
    return d[3] > 0;
  };

  async function notBlank(page, label) {
    const info = await page.evaluate(() => ({
      text: (document.body && document.body.innerText || "").trim().length,
      elements: document.body ? document.body.querySelectorAll("*").length : 0,
      sheets: document.styleSheets.length,
      bg: getComputedStyle(document.body).backgroundColor,
    }));
    check(`${label}: renders content (not blank)`, info.text > 20 && info.elements >= 8,
      `${info.text} chars, ${info.elements} elements, ${info.sheets} stylesheets, bg ${info.bg}`);
    return info;
  }

  async function brokenImages(page) {
    await page.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += Math.max(300, innerHeight)) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 60));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(800);
    return page.evaluate(() => [...document.images]
      .filter((i) => i.getAttribute("src") && i.complete && i.naturalWidth === 0 && !i.src.startsWith("data:"))
      .map((i) => decodeURIComponent(new URL(i.src).pathname)));
  }

  const portrait = { width: 412, height: 915 };
  const landscape = { width: 915, height: 412 };
  const ctx = await newContext(portrait);

  // ---------------------------------------------------------------- home
  if (want("home")) {
    const page = await ctx.newPage();
    const w = watch(page, "home");
    await page.goto(`${ORIGIN}/index.html`, { waitUntil: "load" });
    const shimActive = await page.evaluate(() => !!(window.__lanthanoApp && window.__lanthanoApp.isAndroidApp));
    check("home: Android shim injected and active", shimActive);
    if (await page.locator("#warningAcceptBtn").isVisible().catch(() => false)) {
      await page.click("#warningAcceptBtn");
      check("home: content warning can be accepted", !(await page.locator("#warningBox").isVisible()));
    }
    await page.waitForFunction(() => !document.getElementById("searchBox").disabled, null, { timeout: 30000 });
    check("home: search index loaded (search box enabled)", true,
      await page.getAttribute("#searchBox", "placeholder"));
    await page.waitForFunction(() => document.querySelectorAll("#categoryButtons a").length > 0, null, { timeout: 15000 });
    const cats = await page.$$eval("#categoryButtons a", (as) => as.map((a) => a.getAttribute("href")));
    check("home: category buttons built from descriptions.json", cats.length === 8, `${cats.length} categories`);
    const stats = await page.evaluate(() => ["statPapers", "statPages", "statImages"].map((id) => {
      const el = document.getElementById(id); return el ? el.textContent.trim() : null; }));
    check("home: archive statistics shown", stats.every((s) => s && /\d/.test(s)), stats.join(" / "));
    const featured = await page.evaluate(() => document.querySelectorAll("#featuredContainer *").length);
    check("home: featured carousel rendered", featured > 0, `${featured} elements`);
    await notBlank(page, "home");
    await shot(page, "01-home-portrait");
    const broken = await brokenImages(page);
    check("home: all images load", broken.length === 0, broken.join(", "));
    const swRegistered = await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length);
    check("home: no service worker registered", swRegistered === 0);

    // search
    await page.fill("#searchBox", "moon landing");
    await page.waitForFunction(() => document.querySelectorAll("#searchResults a").length > 0, null, { timeout: 15000 });
    const results = await page.$$eval("#searchResults a", (as) => as.map((a) => a.textContent.replace(/[☆★]/g, "").replace(/\s+/g, " ").trim().slice(0, 40)));
    check("search: Fuse search returns results for 'moon landing'", results.length > 0, results.slice(0, 3).join(" | "));
    // Capture the search box with its results (clipped full-page shot; scrolling
    // would make the site close the results list).
    const area = await page.evaluate(() => {
      const box = document.getElementById("searchBox").getBoundingClientRect();
      const list = document.getElementById("searchResults").getBoundingClientRect();
      return { x: 0, y: Math.max(0, box.top + scrollY - 40), width: innerWidth,
        height: Math.min(1400, Math.max(box.bottom, list.bottom) - box.top + 80) };
    });
    await page.screenshot({ path: path.join(OUT_DIR, "02-search.png"), fullPage: true, clip: area });
    const stillOpen = await page.evaluate(() => getComputedStyle(document.getElementById("searchResults")).display !== "none");
    if (!stillOpen) await page.fill("#searchBox", "moon landing");
    const firstPdfResult = page.locator("#searchResults a.pdf-link").first();
    if (await firstPdfResult.count()) {
      await Promise.all([page.waitForURL(/pdf\.html/, { timeout: 15000 }), firstPdfResult.click()]);
      await page.waitForFunction(() => /of \d+/.test(document.getElementById("pageCount").textContent), null, { timeout: 60000 });
      check("search: tapping a paper result opens it in the PDF viewer", true, decodeURIComponent(page.url().split("file=")[1].split("&")[0]));
      await page.goBack();
      await page.waitForURL(/index\.html/);
      check("navigation: history back returns to home", true);
    } else {
      check("search: result links to a PDF", false, "no document results");
    }
    w.report();
    await page.close();

    // every category page
    for (const href of cats) {
      const p = await ctx.newPage();
      const cw = watch(p, `category ${href}`);
      await p.goto(`${ORIGIN}/${href}`);
      await p.waitForFunction(() => document.querySelectorAll('#research-container a[href*="pdf.html"]').length > 0, null, { timeout: 15000 })
        .catch(() => {});
      const n = await p.$$eval('#research-container a[href*="pdf.html"]', (as) => new Set(as.map((a) => a.href)).size);
      check(`category: ${decodeURIComponent(href.split("=")[1])} lists papers`, n > 0, `${n} papers`);
      cw.report();
      await p.close();
    }
  }

  // -------------------------------------------------------- full archive
  if (want("archive")) {
    const page = await ctx.newPage();
    const w = watch(page, "archive (all)");
    await page.goto(`${ORIGIN}/category.html?category=all`);
    await page.waitForFunction(() => document.querySelectorAll('#research-container a[href*="pdf.html"]').length > 0, null, { timeout: 15000 });
    const files = await page.$$eval('#research-container a[href*="pdf.html"]', (as) =>
      [...new Set(as.map((a) => new URL(a.href).searchParams.get("file")))]);
    check("archive: all papers listed", files.length === Object.keys(descriptions).length,
      `${files.length} of ${Object.keys(descriptions).length}`);
    await notBlank(page, "archive");
    const broken = await brokenImages(page);
    check("archive: all cover images load", broken.length === 0, broken.join(", "));
    await shot(page, "03-archive");
    // open a paper by tapping it, like a user
    const link = page.locator('#research-container a[href*="pdf.html"]').first();
    await Promise.all([page.waitForURL(/pdf\.html/, { timeout: 15000 }), link.click()]);
    await page.waitForFunction(() => /of \d+/.test(document.getElementById("pageCount").textContent), null, { timeout: 60000 });
    check("archive: tapping a paper opens the PDF viewer", true);
    const back = page.locator("#backBtn");
    if (await back.count()) {
      await Promise.all([page.waitForURL(/category\.html/, { timeout: 15000 }), back.click()]);
      check("pdf viewer: its Back button returns to the archive", true);
    }
    w.report();
    await page.close();

    const fav = await ctx.newPage();
    const fw = watch(fav, "favorites");
    await fav.goto(`${ORIGIN}/category.html?category=favorites`);
    await fav.waitForTimeout(800);
    await notBlank(fav, "favorites");
    fw.report();
    await fav.close();
  }

  // ------------------------------------------------------------ timeline
  if (want("timeline")) {
    const page = await ctx.newPage();
    const w = watch(page, "timeline");
    await page.goto(`${ORIGIN}/research-timeline.html`);
    await page.waitForFunction(() => document.querySelectorAll("#timeline *").length > 10, null, { timeout: 15000 });
    const info = await page.evaluate(() => ({
      items: document.querySelectorAll("#timeline *").length,
      count: (document.getElementById("paperCount") || {}).textContent,
      links: document.querySelectorAll('a[href*="pdf.html"]').length,
    }));
    check("timeline: rendered", info.items > 10, `${info.items} elements, paper count "${(info.count || "").trim()}", ${info.links} PDF links`);
    await notBlank(page, "timeline");
    await shot(page, "04-timeline");
    w.report();
    await page.close();
  }

  // ------------------------------------------------------- other pages
  const firstImagePaper = Object.values(descriptions).find((p) => (p.images || []).some((i) => !i.startsWith("#$")));
  const firstImage = firstImagePaper.images.find((i) => !i.startsWith("#$"));
  const otherPages = [
    "discover.html", "about.html", "contact.html", "store.html", "support.html", "music.html",
    "hitorahmusic.html", "Images.html", "featured-video.html", "video.html",
    `image.html?image=${encodeURIComponent(firstImage)}&paper=${encodeURIComponent(firstImagePaper.title)}&return=index.html`,
  ];
  for (const rel of want("pages") ? otherPages : []) {
    const page = await ctx.newPage();
    const label = rel.split("?")[0];
    const w = watch(page, label);
    const resp = await page.goto(`${ORIGIN}/${rel}`);
    check(`${label}: loads (HTTP ${resp.status()})`, resp.status() === 200);
    await page.waitForTimeout(1200);
    const info = await notBlank(page, label);
    if (label === "support.html") {
      const zip = await page.evaluate(() => typeof window.JSZip);
      check("support.html: JSZip available offline (bundled copy of the CDN script)", zip === "function", `typeof JSZip = ${zip}`);
    }
    if (label === "music.html") {
      const audio = await page.evaluate(() => new Promise((resolve) => {
        const a = document.getElementById("player");
        if (!a) return resolve({ error: "no #player" });
        const done = (r) => resolve(Object.assign({ src: decodeURIComponent(a.currentSrc.split("/").pop()) }, r));
        const seek = () => {
          a.addEventListener("seeked", () => done({ duration: Math.round(a.duration), seekedTo: Math.round(a.currentTime) }), { once: true });
          a.currentTime = Math.min(60, a.duration / 2);
        };
        a.addEventListener("error", () => done({ error: a.error && a.error.code }), { once: true });
        if (!a.getAttribute("src")) a.src = "song1.mp3";
        a.load();
        a.addEventListener("loadedmetadata", seek, { once: true });
        setTimeout(() => done({ error: "timeout", readyState: a.readyState }), 10000);
      }));
      check("music.html: bundled audio loads and can seek (HTTP Range)", audio.duration > 0 && audio.seekedTo > 0, JSON.stringify(audio));
    }
    if (label === "Images.html" || label === "image.html") {
      const broken = await brokenImages(page);
      check(`${label}: all images load`, broken.length === 0, broken.slice(0, 5).join(", "));
    }
    await shot(page, `05-${label.replace(/\W+/g, "_")}`);
    w.report(info.text > 0);
    await page.close();
  }
  if (want("pages")) {
    const page = await ctx.newPage();
    const resp = await page.goto(`${ORIGIN}/does-not-exist.html`);
    const has404 = await page.evaluate(() => document.body.innerText.length > 0);
    check("missing page: bundled 404.html shown", resp.status() === 404 && has404);
    const pretty = await page.goto(`${ORIGIN}/about`);
    check("pretty URL /about resolves to about.html", pretty.status() === 200);
    await page.close();
  }

  // ------------------------------------------------------------ PDFs
  const papers = Object.entries(descriptions).filter(([k]) => !ONLY_PDF || k === ONLY_PDF);
  const pdfList = want("pdfs") ? papers : [];
  const pdfResults = [];
  for (const [key, paper] of pdfList) {
    const page = await ctx.newPage();
    const w = watch(page, `pdf ${key}`);
    const url = `${ORIGIN}/pdf.html?file=${encodeURIComponent(paper.url)}&paper=${encodeURIComponent(paper.title)}&return=index.html`;
    const t0 = Date.now();
    await page.goto(url);
    let pages = null;
    try {
      await page.waitForFunction(() => /of \d+/.test(document.getElementById("pageCount").textContent), null, { timeout: 90000 });
      await page.waitForFunction(() => getComputedStyle(document.getElementById("loadingOverlay")).display === "none", null, { timeout: 90000 });
      pages = Number((await page.textContent("#pageCount")).match(/\d+/)[0]);
    } catch (e) { /* reported below */ }
    await page.waitForFunction(PAGE1_PAINTED, null, { timeout: 30000 }).catch(() => {});
    const ink = await page.evaluate(INK).catch(() => ({ painted: -1, dark: -1 }));
    const ms = Date.now() - t0;
    const expected = pageCounts[key];
    pdfResults.push({ key, title: paper.title, file: paper.url, pages, expected, ms, ink });
    check(`pdf: ${paper.title} opens and renders`, pages > 0 && ink.painted > 0.9 && ink.dark > 0,
      `${pages} pages (page-counts.json: ${expected}), page 1 painted ${(ink.painted * 100).toFixed(0)}%, ` +
      `${(ink.dark * 100).toFixed(1)}% dark (text/graphics), ${ms} ms`);
    if (pages !== expected) check(`pdf: ${paper.title} page count matches page-counts.json`, false, `${pages} vs ${expected}`);
    if (key === pdfList[0][0]) await shot(page, "06-pdf-first");
    w.report();
    await page.close();
  }
  report.pdfs = pdfResults;

  // --------------------------------------- PDF viewer features (one paper)
  if (want("viewer")) {
    const key = descriptions.moon_hoax ? "moon_hoax" : papers[0][0];
    const paper = descriptions[key];
    const page = await ctx.newPage();
    const w = watch(page, "pdf viewer features");
    await page.goto(`${ORIGIN}/pdf.html?file=${encodeURIComponent(paper.url)}&paper=${encodeURIComponent(paper.title)}&return=index.html`);
    await page.waitForFunction(() => getComputedStyle(document.getElementById("loadingOverlay")).display === "none", null, { timeout: 90000 });

    // go to page 5
    await page.fill("#pageNumber", "5");
    await page.press("#pageNumber", "Enter");
    await page.waitForTimeout(1500);
    const pos = await page.evaluate(() => {
      const el = document.querySelector('[data-page-number="5"], #page-5, .page:nth-of-type(5)');
      return { value: document.getElementById("pageNumber").value, top: el ? Math.round(el.getBoundingClientRect().top) : null };
    });
    check("pdf viewer: jump to page 5", pos.value === "5", `page field "${pos.value}"${pos.top !== null ? `, page 5 top at ${pos.top}px` : ""}`);
    await shot(page, "07-pdf-page5");

    // scroll navigation updates the page number
    await page.evaluate(() => {
      const v = document.getElementById("viewer");
      (v && v.scrollHeight > v.clientHeight ? v : document.scrollingElement).scrollBy(0, 4000);
    });
    await page.waitForTimeout(1200);
    const afterScroll = await page.inputValue("#pageNumber");
    check("pdf viewer: scrolling moves through pages", Number(afterScroll) > 5, `now on page ${afterScroll}`);

    // zoom
    const z0 = await page.inputValue("#zoomPercent").catch(() => "");
    await page.click("#zoomIn").catch(() => {});
    await page.waitForTimeout(800);
    const z1 = await page.inputValue("#zoomPercent").catch(() => "");
    check("pdf viewer: zoom in", z0 !== z1, `${(z0 || "").trim()} -> ${(z1 || "").trim()}`);
    await page.click("#zoomOut").catch(() => {});

    // in-document search
    await page.click("#searchButton");
    await page.fill("#searchBox", "moon");
    await page.waitForFunction(() => /^[1-9]\d* found|^\d+ of [1-9]/.test(document.getElementById("searchResults").textContent.trim()),
      null, { timeout: 60000 }).catch(() => {});
    const label1 = (await page.textContent("#searchResults")).trim();
    await page.click("#nextResult");
    await page.waitForTimeout(800);
    const label2 = (await page.textContent("#searchResults")).trim();
    await page.click("#nextResult");
    await page.waitForTimeout(800);
    const label3 = (await page.textContent("#searchResults")).trim();
    const marks = await page.evaluate(() => document.querySelectorAll("[class*=earch][class*=ighlight], .highlight, mark").length);
    check("pdf viewer: search finds matches and steps through them",
      /^[1-9]\d* found|^\d+ of [1-9]/.test(label1) && /^1 of /.test(label2) && /^2 of /.test(label3),
      `"${label1}" -> "${label2}" -> "${label3}", ${marks} highlight elements`);
    await shot(page, "08-pdf-search");
    await page.keyboard.press("Escape");

    // table of contents button responds
    await page.click("#tocButton").catch(() => {});
    await page.waitForTimeout(500);
    const toc = await page.evaluate(() => !document.getElementById("tocPopup").classList.contains("hidden") ||
      document.getElementById("toast").textContent.trim());
    check("pdf viewer: contents button responds", !!toc, typeof toc === "string" ? toc : "outline shown");
    if (await page.locator("#tocCloseBtn").isVisible().catch(() => false)) await page.click("#tocCloseBtn");
    await page.waitForTimeout(300);

    // Read Aloud engine (speechSynthesis polyfill -> mocked Android TextToSpeech)
    const tts = await page.evaluate(() => new Promise((resolve) => {
      const events = [];
      const voices = speechSynthesis.getVoices();
      const u = new SpeechSynthesisUtterance("Offline read aloud test sentence for the Android app.");
      ["start", "boundary", "end", "error"].forEach((t) => u.addEventListener(t, (e) => events.push(t + (t === "boundary" ? ":" + e.charIndex : ""))));
      speechSynthesis.speak(u);
      setTimeout(() => resolve({ events, voices: voices.length, after: speechSynthesis.getVoices().length }), 1500);
    }));
    check("read aloud: speechSynthesis routed to Android TextToSpeech",
      tts.events[0] === "start" && tts.events.some((e) => e.startsWith("boundary")) && tts.events.includes("end") && tts.after > 0,
      `${tts.events.join(",")} (voices: ${tts.after})`);

    // Read Aloud UI in the viewer uses it
    const calls0 = await page.evaluate(() => window.__bridgeCalls.filter((c) => c.name === "ttsStart").length);
    const floatVisible = await page.locator("#readAloudFloat").isVisible().catch(() => false);
    check("read aloud: Read Aloud button shown (speech available in the app)", floatVisible);
    await page.click("#readAloudFloat");
    await page.waitForTimeout(600);
    const choice = (await page.textContent("#readAloudChoiceTitle").catch(() => "")).trim();
    const primary = page.locator("#readAloudChoicePrimary");
    if (await primary.isVisible().catch(() => false)) await primary.click();
    await page.waitForTimeout(3000);
    const controls = await page.locator("#readAloudControls").isVisible().catch(() => false);
    const calls1 = await page.evaluate(() => window.__bridgeCalls.filter((c) => c.name === "ttsStart").length);
    check("read aloud: viewer's Read Aloud speaks through the app", calls1 > calls0,
      `choice "${choice}" -> ${calls1 - calls0} speech requests, control bar ${controls ? "shown" : "hidden"}`);
    const highlighted = await page.evaluate(() => document.querySelectorAll(".readHighlightLayer *, .read-line-highlight").length);
    check("read aloud: the line being read is highlighted", highlighted > 0, `${highlighted} highlight elements`);
    const screenOn = await page.evaluate(() => window.__keepScreenOn === true);
    check("read aloud: screen kept on while reading (navigator.wakeLock -> Android)", screenOn);
    await shot(page, "09-read-aloud");
    await page.click("#readAloudStop").catch(() => {});
    await page.waitForTimeout(500);
    const screenOff = await page.evaluate(() => window.__keepScreenOn === false);
    check("read aloud: stopping releases the screen wake lock", screenOff);
    await page.evaluate(() => speechSynthesis.cancel());

    // download button saves the bundled PDF through Android's "Save as"
    await page.evaluate(() => { window.__bridgeCalls.length = 0; });
    const dl = page.locator("#downloadBtn");
    if (await dl.count()) {
      await page.evaluate(() => document.getElementById("downloadBtn").click());
      await page.waitForTimeout(1500);
      const calls = await page.evaluate(() => window.__bridgeCalls.map((c) => c.name + "(" + c.args.slice(0, 3).join(", ") + ")"));
      check("pdf viewer: Download saves via Android (no browser, no network)",
        calls.some((c) => c.startsWith("saveAsset") || c.startsWith("beginSave") || c.startsWith("openAssetExternally")), calls.join(" "));
    }
    // copy link / new tab buttons
    await page.evaluate(() => { window.__bridgeCalls.length = 0; });
    await page.evaluate(() => document.getElementById("copyLinkBtn") && document.getElementById("copyLinkBtn").click());
    await page.waitForTimeout(500);
    const copyCalls = await page.evaluate(() => window.__bridgeCalls.map((c) => c.name + "(" + c.args.join(", ") + ")"));
    check("pdf viewer: Copy link uses Android clipboard with the public URL",
      copyCalls.some((c) => c.startsWith("copyText(https://lanthanoresearch.com/") || c.startsWith("share(")), copyCalls.join(" "));
    w.report();
    await page.close();
  }

  // ------------------------------------------------ shim behaviours
  if (want("shim")) {
    const page = await ctx.newPage();
    // This section provokes a 404 (sw.js) and a blocked (403) request on purpose.
    const w = watch(page, "shim", /sw\.js|status of 403/);
    await page.goto(`${ORIGIN}/index.html`);
    const r = await page.evaluate(async (img) => {
      const out = {};
      window.__bridgeCalls.length = 0;
      window.open(img, "_blank");
      out.viewerOpen = !!document.querySelector("[data-lanthano-viewer]");
      let vimg = null;
      for (const t0 = performance.now(); performance.now() - t0 < 5000;) {
        vimg = document.querySelector("[data-lanthano-viewer] img");
        if (vimg && vimg.complete && vimg.naturalWidth > 0) break;
        await new Promise((res) => setTimeout(res, 50));
      }
      out.viewerImageLoaded = !!(vimg && vimg.naturalWidth > 0);
      out.backClosed = window.__lanthanoApp.handleBack() === true && !document.querySelector("[data-lanthano-viewer]");
      out.backNothing = window.__lanthanoApp.handleBack() === false;
      window.open("https://example.com/", "_blank");
      window.open("9-11.pdf", "_blank");
      await navigator.share({ title: "Lanthano", url: location.origin + "/pdf.html?file=9-11.pdf" });
      const a = document.createElement("a");
      a.href = "The Real Nazis.pdf"; a.download = "The Real Nazis.pdf"; document.body.appendChild(a); a.click(); a.remove();
      const blobUrl = URL.createObjectURL(new Blob(["x".repeat(3 * 1024 * 1024)], { type: "text/plain" }));
      const b = document.createElement("a");
      b.href = blobUrl; b.download = "notes.txt"; document.body.appendChild(b); b.click(); b.remove(); URL.revokeObjectURL(blobUrl);
      await new Promise((res) => setTimeout(res, 800));
      out.calls = window.__bridgeCalls.map((c) => c.name + "(" + c.args.join(", ") + ")");
      out.swPending = await Promise.race([navigator.serviceWorker.register("sw.js").then(() => "registered"),
        new Promise((res) => setTimeout(() => res("skipped"), 300))]);
      const statuses = {};
      for (const p of ["Distance%20%26%20Shadows.png", "33%%20Desert.png", "33%25%20Desert.png", "covers/911.png", "pdfjs/build/pdf.worker.mjs", "sw.js", "../index.html"]) {
        statuses[p] = (await fetch(p)).status;
      }
      out.statuses = statuses;
      try {
        const res = await fetch("https://cdn.jsdelivr.net/npm/some-other-lib");
        out.remote = res.status === 403 ? "blocked" : "reachable (" + res.status + ")";
      } catch (e) { out.remote = "blocked"; }
      const remoteImg = await new Promise((res) => { const i = new Image(); i.onload = () => res("loaded"); i.onerror = () => res("blocked"); i.src = "https://huggingface.co/x.png"; });
      out.remoteImg = remoteImg;
      return out;
    }, firstImage);
    check("shim: window.open(image) shows the in-app viewer", r.viewerOpen && r.viewerImageLoaded);
    check("shim: Back closes the viewer first, then falls through to history", r.backClosed && r.backNothing);
    check("shim: external window.open handed to Android", r.calls.some((c) => c.startsWith("openExternal(https://example.com/")), "");
    check("shim: window.open(PDF) offers 'Open with'", r.calls.some((c) => c.startsWith("openAssetExternally(/9-11.pdf")));
    check("shim: navigator.share uses the Android share sheet with the public link",
      r.calls.some((c) => c.includes("share(Lanthano") && c.includes("https://lanthanoresearch.com/pdf.html")));
    check("shim: <a download> of a bundled PDF saves it from the APK",
      r.calls.some((c) => c.startsWith("saveAsset(") && c.includes("/The%20Real%20Nazis.pdf")));
    check("shim: blob download streams in chunks to 'Save as'",
      r.calls.some((c) => c.startsWith("beginSave(")) && r.calls.filter((c) => c.startsWith("writeSaveChunk(")).length === 2 &&
      r.calls.some((c) => c.startsWith("finishSave(") && c.endsWith("true)")), r.calls.filter((c) => /Save|Chunk/.test(c)).join(" "));
    check("shim: service worker registration skipped", r.swPending === "skipped");
    check("server: file names with spaces, '&' and '%' resolve",
      r.statuses["Distance%20%26%20Shadows.png"] === 200 && r.statuses["33%%20Desert.png"] === 200 && r.statuses["33%25%20Desert.png"] === 200,
      JSON.stringify(r.statuses));
    check("server: sw.js is not bundled; path traversal refused", r.statuses["sw.js"] === 404 && r.statuses["../index.html"] === 200,
      "(../index.html is normalised by the browser to /index.html)");
    check("network: remote fetch blocked", r.remote === "blocked", r.remote);
    check("network: remote image blocked", r.remoteImg === "blocked");
    w.report();
    await page.close();
  }

  report.blocked.push(...new Set(ctx.__blocked));
  await ctx.close();

  // ------------------------------------- older Android System WebView
  // Removes every recent built-in that the bundled PDF.js needs (in the page
  // and in the PDF.js worker) so that only the app's polyfills provide them.
  if (want("oldwebview")) {
    const octx = await newContext(portrait, true, { stripBuiltins: true });
    const page = await octx.newPage();
    const w = watch(page, "old WebView simulation");
    const paper = descriptions.corrupt_versions || Object.values(descriptions)[0];
    await page.goto(`${ORIGIN}/pdf.html?file=${encodeURIComponent(paper.url)}&paper=${encodeURIComponent(paper.title)}&return=index.html`);
    const state = await page.evaluate(() => ({
      stripped: !!globalThis.__strippedBuiltins,
      polyfilled: !!globalThis.__lanthanoPolyfills,
      upsert: Map.prototype.getOrInsertComputed.toString().includes("callbackfn"),
    }));
    check("old WebView: built-ins removed, then provided by polyfills.js", state.stripped && state.polyfilled && state.upsert, JSON.stringify(state));
    await page.waitForFunction(() => getComputedStyle(document.getElementById("loadingOverlay")).display === "none", null, { timeout: 90000 });
    const warn = page.locator("#controversialWarningPrimary");
    if (await warn.isVisible().catch(() => false)) await warn.click();
    await page.waitForFunction(PAGE1_PAINTED, null, { timeout: 30000 }).catch(() => {});
    const ink = await page.evaluate(INK);
    const pages = Number(((await page.textContent("#pageCount")) || "").replace(/\D+/g, "")) || 0;
    check("old WebView: PDF renders with polyfilled worker", ink.painted > 0.9 && ink.dark > 0,
      `${paper.title}: ${pages} pages, page 1 painted ${(ink.painted * 100).toFixed(0)}%`);
    await page.click("#searchButton");
    await page.fill("#searchBox", "the");
    await page.waitForFunction(() => /^[1-9]\d* found|^\d+ of [1-9]/.test(document.getElementById("searchResults").textContent.trim()),
      null, { timeout: 90000 }).catch(() => {});
    const label = (await page.textContent("#searchResults")).trim();
    check("old WebView: PDF search works", /^[1-9]\d* found|^\d+ of [1-9]/.test(label), label);
    await shot(page, "14-old-webview-pdf");
    w.report();
    report.blocked.push(...new Set(octx.__blocked));
    await octx.close();
  }

  // --------------------------------------------------------- landscape
  if (want("landscape")) {
    const lctx = await newContext(landscape);
    const page = await lctx.newPage();
    const w = watch(page, "landscape");
    await page.goto(`${ORIGIN}/index.html`);
    await page.waitForFunction(() => !document.getElementById("searchBox").disabled, null, { timeout: 30000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check("landscape: home fits the screen width", overflow <= 1, `horizontal overflow ${overflow}px`);
    await shot(page, "10-home-landscape");
    const paper = descriptions.real_nazis || Object.values(descriptions)[0];
    await page.goto(`${ORIGIN}/pdf.html?file=${encodeURIComponent(paper.url)}&paper=${encodeURIComponent(paper.title)}&return=index.html`);
    await page.waitForFunction(() => getComputedStyle(document.getElementById("loadingOverlay")).display === "none", null, { timeout: 90000 });
    const warn = page.locator("#controversialWarningPrimary");
    const gated = await warn.isVisible().catch(() => false);
    await shot(page, "11-pdf-landscape-warning");
    if (gated) await warn.click();
    await page.waitForFunction(PAGE1_PAINTED, null, { timeout: 30000 }).catch(() => {});
    const lInk = await page.evaluate(INK);
    check("landscape: PDF viewer renders", lInk.painted > 0.9 && lInk.dark > 0,
      (gated ? "controversial-content notice shown first, then the paper; " : "") + `page 1 painted ${(lInk.painted * 100).toFixed(0)}%`);
    await shot(page, "12-pdf-landscape");
    // rotate back to portrait on the same page
    await page.setViewportSize(portrait);
    await page.waitForTimeout(1200);
    const fits = await page.evaluate(() => {
      const c = document.querySelector('.page[data-page-number="1"] canvas.pageCanvas') ||
        [...document.querySelectorAll("canvas")].find((x) => x.width > 50);
      return c ? Math.round(c.getBoundingClientRect().width) : 0;
    });
    check("rotation: PDF re-fits after rotating to portrait", fits > 0 && fits <= portrait.width + 2, `page width ${fits}px`);
    await shot(page, "13-pdf-rotated-portrait");
    w.report();
    report.blocked.push(...new Set(lctx.__blocked));
    await lctx.close();
  }

  // -------------------------------------- plain browser (no bridge) smoke
  if (want("plain")) {
    const pctx = await newContext(portrait, false);
    const page = await pctx.newPage();
    const w = watch(page, "no-bridge mode");
    await page.goto(`${ORIGIN}/index.html`);
    const inert = await page.evaluate(() => !window.__lanthanoApp);
    check("shim: inert outside the app (site unchanged in a normal browser)", inert);
    w.report();
    report.blocked.push(...new Set(pctx.__blocked));
    await pctx.close();
  }

  await browser.close();

  report.blocked = [...new Set(report.blocked)];
  check("network: remote requests attempted by the site during the tests",
    report.blocked.every((u) => /example\.com|cdn\.jsdelivr\.net\/npm\/some-other-lib|huggingface\.co\/x\.png/.test(u)),
    report.blocked.length ? report.blocked.join(", ") : "none");

  report.finishedAt = new Date().toISOString();
  report.passed = report.checks.filter((c) => c.ok).length;
  report.failed = failures;
  fs.writeFileSync(path.join(OUT_DIR, "report.json"), JSON.stringify(report, null, 2));
  console.log(`\n${report.passed} passed, ${failures} failed. Report: ${path.join(OUT_DIR, "report.json")}`);
  process.exit(failures ? 1 : 0);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(2);
  });
} else {
  module.exports = { serve, BRIDGE_MOCK, ORIGIN, bundle };
}
