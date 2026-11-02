// Lockdown and Update for the installed apps (the computer app and the Android app).
//
// The app holds the whole website and works with no internet. In Settings:
//
//   Lockdown (ON by default)  Nothing goes in and nothing comes out: the app
//       never connects to the website, and nothing can change its files. Keep it
//       on to keep this version exactly as it is, forever.
//   Update (only shown when Lockdown is off)  "Check" compares every file of the
//       app (pages, scripts, pictures, PDFs, data) with the website and says how
//       many are in sync. If some are not, the button becomes "Update", and the
//       app is made to match the website exactly (files the website no longer
//       has are removed too).
//
// Nothing happens by itself: the website is contacted only when "Check" is
// pressed with Lockdown off. The website, and the website installed as a PWA,
// never load this.
//
// Where the newer files are kept:
//   computer app  the app keeps them in its own folder (main.js, /__patch/...),
//                 and main.js refuses every change while Lockdown is on
//   Android app   they are kept in the app's cache and given to pages by sw.js
//                 (registered as sw.js?overlay=1)
// A newer installer always starts again from its own files.

(function () {
  "use strict";

  var LIVE = "https://lanthanoresearch.com/";
  var T = window.AppTransform;

  function platform() {
    if (window.LT_APP_PLATFORM) return window.LT_APP_PLATFORM;          // set by tests only
    if (location.protocol === "lanthano:") return "desktop";
    try {
      if (window.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform()) return "android";
    } catch (e) {}
    return "";
  }

  var PLAT = platform();
  if (!PLAT || !T) return;

  var enc = function (rel) { return rel.split("/").map(encodeURIComponent).join("/"); };

  var MIME = {
    html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8",
    css: "text/css; charset=utf-8", json: "application/json; charset=utf-8", xml: "application/xml; charset=utf-8",
    txt: "text/plain; charset=utf-8", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    gif: "image/gif", webp: "image/webp", ico: "image/x-icon", pdf: "application/pdf", mp4: "video/mp4",
    webm: "video/webm", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", vtt: "text/vtt"
  };
  function mimeOf(rel) {
    var m = /\.([a-z0-9]+)$/i.exec(rel);
    return (m && MIME[m[1].toLowerCase()]) || "application/octet-stream";
  }

  function b64ToBytes(s) {
    var bin = atob(s), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  var VIDEO_API = "https://videos.lanthanoresearch.com";

  // Why a video could not be brought in: lockdown, busy (the video server asked
  // to wait), space (not enough room), refused, incomplete, cancelled, network.
  function videoError(code) { var e = new Error("video: " + code); e.code = code; return e; }

  function mb(n) {
    return n >= 1e9 ? (n / 1e9).toFixed(2) + " GB" : Math.max(1, Math.round(n / 1e6)) + " MB";
  }

  /* ------------------------------------------------------------ lockdown */

  // ON unless the person turned it off. The computer app keeps the answer in
  // main.js (which also enforces it); the Android app keeps it on the phone.
  async function isLocked() {
    if (PLAT === "desktop") {
      try {
        var r = await fetch("/__patch/lockdown", { cache: "no-store" });
        return !!(await r.json()).locked;
      } catch (e) { return true; }
    }
    try { return localStorage.getItem("lt_lockdown") !== "off"; } catch (e) { return true; }
  }

  async function setLocked(on) {
    if (PLAT === "desktop") {
      await fetch("/__patch/lockdown?p=" + (on ? "on" : "off"), { method: "POST" });
    } else {
      try { localStorage.setItem("lt_lockdown", on ? "on" : "off"); } catch (e) {}
    }
  }

  /* ------------------------------------------------ the website's files */

  // The phone's network code hands a file back in different forms: binary files as
  // base64 text, but JSON already read into an object and text files as plain text.
  // This turns whichever it is into the file's bytes.
  function httpBytes(r) {
    var d = r.data;
    if (d === null || d === undefined) return null;
    if (typeof d === "string") {
      var head = r.headers || {};
      var type = String(head["Content-Type"] || head["content-type"] || "").toLowerCase();
      var textual = /^text\/|json|javascript|xml|svg/.test(type);
      var flat = d.replace(/\s/g, "");
      var base64 = /^[A-Za-z0-9+\/]*={0,2}$/.test(flat) && flat.length % 4 === 0;
      if (!textual || base64) { try { return b64ToBytes(flat); } catch (e) {} }
      return new TextEncoder().encode(d);
    }
    if (d instanceof ArrayBuffer) return new Uint8Array(d);
    if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
    if (typeof d === "object") return new TextEncoder().encode(JSON.stringify(d));
    return null;
  }

  // Remembers each file's fingerprint from the website's list, so a file is never
  // answered from an old saved copy.
  var LIVE_HASH = {};

  async function liveBytes(rel, bust) {
    if (await isLocked()) throw new Error("lockdown");
    var v = bust ? (LIVE_HASH[rel] || "") + "-" + Date.now() : (LIVE_HASH[rel] || Date.now());

    if (PLAT === "android") {
      // A normal request to lanthanoresearch.com would be answered by the app
      // itself, so the phone's own network code is used.
      var C = window.Capacitor;
      var Http = (C.Plugins && C.Plugins.CapacitorHttp) || (C.registerPlugin && C.registerPlugin("CapacitorHttp"));
      if (!Http || !Http.request) throw new Error("the phone's network code is not available");
      var url = LIVE + enc(rel) + "?v=" + v, r, lastErr;
      var kinds = ["blob", "arraybuffer", "text"];
      for (var i = 0; i < kinds.length; i++) {
        try {
          r = await Http.request({ url: url, method: "GET", responseType: kinds[i] });
          if (r && r.status === 200) {
            var got = httpBytes(r);
            if (got) return got;
            lastErr = new Error("the website's answer could not be read");
          } else {
            lastErr = new Error("the website answered " + (r && r.status));
          }
        } catch (e) { lastErr = e; }
      }
      throw lastErr || new Error("no answer");
    }

    // Computer app: main.js gets the file from the website.
    var res = await fetch("/__patch/live?p=" + encodeURIComponent(rel) + "&v=" + encodeURIComponent(v));
    if (!res.ok) throw new Error(res.status === 403 ? "lockdown" : "the website answered " + res.status);
    return new Uint8Array(await res.arrayBuffer());
  }

  // The website's list fingerprints each file with the first 16 letters of its SHA-1.
  // Every downloaded file is checked against that, so an old copy that a network
  // cache still holds can never be saved as if it were the newest.
  function sha1Bytes(bytes) {
    var h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
    var n = bytes.length, total = ((n + 9 + 63) >> 6) << 6;
    var m = new Uint8Array(total);
    m.set(bytes); m[n] = 0x80;
    var bits = n * 8, hi = Math.floor(bits / 4294967296), lo = bits >>> 0;
    for (var q = 0; q < 4; q++) { m[total - 8 + q] = (hi >>> (24 - 8 * q)) & 255; m[total - 4 + q] = (lo >>> (24 - 8 * q)) & 255; }
    var w = new Int32Array(80);
    function rol(x, c) { return (x << c) | (x >>> (32 - c)); }
    for (var off = 0; off < total; off += 64) {
      var i;
      for (i = 0; i < 16; i++) w[i] = (m[off + i * 4] << 24) | (m[off + i * 4 + 1] << 16) | (m[off + i * 4 + 2] << 8) | m[off + i * 4 + 3];
      for (i = 16; i < 80; i++) w[i] = rol(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
      var a = h0, bb = h1, c = h2, d = h3, e = h4;
      for (i = 0; i < 80; i++) {
        var f, kk;
        if (i < 20) { f = (bb & c) | (~bb & d); kk = 0x5A827999; }
        else if (i < 40) { f = bb ^ c ^ d; kk = 0x6ED9EBA1; }
        else if (i < 60) { f = (bb & c) | (bb & d) | (c & d); kk = 0x8F1BBCDC; }
        else { f = bb ^ c ^ d; kk = 0xCA62C1D6; }
        var t = (rol(a, 5) + f + e + kk + w[i]) | 0;
        e = d; d = c; c = rol(bb, 30); bb = a; a = t;
      }
      h0 = (h0 + a) | 0; h1 = (h1 + bb) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
    }
    return [h0, h1, h2, h3, h4].map(function (x) { return ("00000000" + (x >>> 0).toString(16)).slice(-8); }).join("");
  }

  async function fingerprint(bytes) {
    try {
      if (window.crypto && crypto.subtle && crypto.subtle.digest) {
        var d = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
        return Array.prototype.map.call(d, function (x) { return ("0" + x.toString(16)).slice(-2); }).join("").slice(0, 16);
      }
    } catch (e) {}
    return sha1Bytes(bytes).slice(0, 16);
  }

  async function liveText(rel) {
    return new TextDecoder().decode(await liveBytes(rel));
  }

  /* --------------------------------------------- where the files are kept */

  var store;

  if (PLAT === "desktop") {
    var post = function (action, rel, body) {
      return fetch("/__patch/" + action + (rel ? "?p=" + encodeURIComponent(rel) : ""), { method: "POST", body: body })
        .then(function (r) { if (!r.ok) throw new Error("store " + r.status); });
    };
    store = {
      // A new video: main.js downloads it straight into the app's folder.
      video: async function (rel, onBytes, ctl) {
        var timer = setInterval(async function () {
          try {
            var r = await fetch("/__patch/videoprogress", { cache: "no-store" });
            var j = await r.json();
            if (j.active && onBytes) onBytes(j.got, j.total);
          } catch (e) {}
        }, 500);
        var stopper = setInterval(function () {
          if (ctl && ctl.cancelled) fetch("/__patch/videocancel", { method: "POST" }).catch(function () {});
        }, 300);
        try {
          var res = await fetch("/__patch/video?p=" + encodeURIComponent(rel), { method: "POST" });
          var j2 = {};
          try { j2 = await res.json(); } catch (e) {}
          if (res.ok) return j2.bytes || 0;
          throw videoError(res.status === 403 ? "lockdown" : (j2.error || "network"));
        } catch (e) {
          if (e && e.code) throw e;
          throw videoError("network");
        } finally {
          clearInterval(timer); clearInterval(stopper);
        }
      },
      put: function (rel, bytes) { return post("put", rel, bytes); },
      remove: function (rel) { return post("remove", rel); },
      finish: function () { return Promise.resolve(true); },
      reset: function () { return post("reset"); }
    };
  } else {
    var CACHE = "lanthano-app-update";
    var removed = null;
    var keyOf = function (rel) { return new URL("/" + rel, location.origin).href; };
    var loadRemoved = async function () {
      if (removed) return removed;
      var c = await caches.open(CACHE), r = await c.match("/__update/removed.json");
      try { removed = new Set(r ? await r.json() : []); } catch (e) { removed = new Set(); }
      return removed;
    };
    store = {
      // A new video: asked for from the video server (ticket first, then the video)
      // and streamed straight into the app's storage, never held whole in memory.
      video: async function (rel, onBytes, ctl) {
        if (await isLocked()) throw videoError("lockdown");
        var f = window.LT_REAL_FETCH || window.fetch.bind(window);
        var ac = new AbortController();
        var watch = setInterval(function () { if (ctl && ctl.cancelled) ac.abort(); }, 300);
        try {
          var tk = await f(VIDEO_API + "/ticket?f=" + encodeURIComponent(rel), { cache: "no-store", signal: ac.signal });
          if (tk.status === 429 || tk.status === 503) throw videoError("busy");
          if (!tk.ok) throw videoError("refused");
          var ticket = (await tk.json()).t;
          var res = await f(VIDEO_API + "/play?t=" + encodeURIComponent(ticket), { signal: ac.signal });
          if (res.status === 429 || res.status === 503) throw videoError("busy");
          if (res.status !== 200 || !res.body) throw videoError("refused");
          var type = String(res.headers.get("content-type") || "").toLowerCase();
          if (type && type.indexOf("video/") !== 0 && type.indexOf("octet-stream") < 0) throw videoError("refused");
          var len = Number(res.headers.get("content-length")) || 0;

          try {
            var est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
            if (est && est.quota && len && est.quota - (est.usage || 0) < len + 200 * 1024 * 1024) throw videoError("space");
          } catch (e) { if (e && e.code === "space") throw e; }

          var got = 0, reader = res.body.getReader();
          var stream = new ReadableStream({
            pull: async function (c) {
              var r = await reader.read();
              if (r.done) { c.close(); return; }
              got += r.value.length;
              if (onBytes) onBytes(got, len);
              c.enqueue(r.value);
            },
            cancel: function (why) { return reader.cancel(why); }
          });
          var c = await caches.open(CACHE), key = keyOf(rel);
          var headers = { "Content-Type": mimeOf(rel) };
          if (len) headers["Content-Length"] = String(len);
          try {
            await c.put(key, new Response(stream, { headers: headers }));
          } catch (e) {
            try { await c.delete(key); } catch (x) {}
            if (ac.signal.aborted) throw videoError("cancelled");
            throw videoError(e && e.name === "QuotaExceededError" ? "space" : "network");
          }
          var stored = await c.match(key), blob = stored ? await stored.blob() : null;
          if (!blob || blob.size < 1024 || (len && blob.size !== len)) {
            await c.delete(key);
            throw videoError("incomplete");
          }
          (await loadRemoved()).delete(rel);
          return blob.size;
        } catch (e) {
          if (ac.signal.aborted) throw videoError("cancelled");
          if (e && e.code) throw e;
          throw videoError("network");
        } finally {
          clearInterval(watch);
        }
      },
      put: async function (rel, bytes) {
        if (await isLocked()) throw new Error("lockdown");
        var c = await caches.open(CACHE);
        await c.put(keyOf(rel), new Response(bytes, { headers: { "Content-Type": mimeOf(rel) } }));
        (await loadRemoved()).delete(rel);
      },
      remove: async function (rel) {
        if (await isLocked()) throw new Error("lockdown");
        var c = await caches.open(CACHE);
        await c.delete(keyOf(rel));
        (await loadRemoved()).add(rel);
      },
      // Saves the list of removed files, then makes sure the worker that hands
      // the new files to pages is running and able to read the app's own files.
      finish: async function () {
        var c = await caches.open(CACHE);
        await c.put("/__update/removed.json", new Response(JSON.stringify([].concat(Array.from(await loadRemoved()))), { headers: { "Content-Type": "application/json" } }));
        try { localStorage.setItem("lt_overlay", "1"); } catch (e) {}
        var r = await store.probe();
        store.lastWhy = r.why || "";
        return r.ok;
      },
      lastWhy: "",
      // Can this phone's worker hand the app's saved updates to its pages? An app installed
      // from an older build has a worker that cannot (it never answers), and Update cannot
      // replace that file. Asked before anything is downloaded, and again at the end.
      probe: async function () {
        if (!("serviceWorker" in navigator)) return { ok: false, why: "this phone's browser engine has no service worker" };
        try {
          var reg = await navigator.serviceWorker.register("sw.js?overlay=1");
          var ready = await Promise.race([
            navigator.serviceWorker.ready,
            new Promise(function (_, no) { setTimeout(function () { no(new Error("slow")); }, 15000); })
          ]);
          var worker = reg.active || (ready && ready.active);
          if (!worker) return { ok: false, why: "the app's worker did not start" };
          worker.postMessage({ type: "lt-overlay-changed" });
          for (var tries = 0; tries < 2; tries++) {
            var answer = await new Promise(function (resolve) {
              var ch = new MessageChannel(), t = setTimeout(function () { resolve(null); }, 8000);
              ch.port1.onmessage = function (e) { clearTimeout(t); resolve(!!(e.data && e.data.ok)); };
              worker.postMessage({ type: "lt-health" }, [ch.port2]);
            });
            if (answer === true) return { ok: true };
            if (answer === false) return { ok: false, why: "the app's worker could not read the app's own files" };
          }
          return { ok: false, why: "the app's worker is from an older build and does not answer" };
        } catch (e) {
          return { ok: false, why: "the app's worker could not be started (" + (e && e.message ? e.message : "no reason") + ")" };
        }
      },
      reset: async function () {
        try { localStorage.removeItem("lt_overlay"); } catch (e) {}
        removed = null;
        await caches.delete(CACHE);
        if ("serviceWorker" in navigator) {
          var regs = await navigator.serviceWorker.getRegistrations();
          for (var i = 0; i < regs.length; i++) await regs[i].unregister();
        }
      }
    };
  }

  /* ------------------------------------------------------------- compare */

  async function localJson(rel, fallback) {
    try {
      var r = await fetch(rel, { cache: "no-store" });
      if (!r.ok) throw 0;
      return await r.json();
    } catch (e) { return fallback; }
  }

  function byPath(list) {
    var m = {};
    (list || []).forEach(function (f) { m[f.path] = f; });
    return m;
  }

  function r2Videos(descriptionsText) {
    var out = new Set();
    (function walk(o) {
      if (Array.isArray(o)) o.forEach(walk);
      else if (o && typeof o === "object") {
        if (typeof o.file === "string" && o.file && o.source !== "site") out.add(o.file);
        Object.keys(o).forEach(function (k) { walk(o[k]); });
      }
    })(JSON.parse(descriptionsText));
    return out;
  }

  // The size of each video the website lists (when it says), by file.
  function r2Sizes(descriptionsText) {
    var out = {};
    (function walk(o) {
      if (Array.isArray(o)) o.forEach(walk);
      else if (o && typeof o === "object") {
        if (typeof o.file === "string" && o.file && o.source !== "site" && typeof o.size === "number") out[o.file] = o.size;
        Object.keys(o).forEach(function (k) { walk(o[k]); });
      }
    })(JSON.parse(descriptionsText));
    return out;
  }

  // What is new, changed or gone on the website compared with this app.
  async function check() {
    var mine = await localJson("site-files.json", { files: [] });
    var live = JSON.parse(await liveText("site-files.json"));
    LIVE_HASH = {};
    (live.files || []).forEach(function (f) { LIVE_HASH[f.path] = f.hash; });
    var keep = new Set(T.KEEP);
    var have = byPath(mine.files), now = byPath(live.files);
    var plan = { added: [], changed: [], removed: [], newVideos: [], goneVideos: [], live: live, mine: mine };

    Object.keys(now).forEach(function (p) {
      if (keep.has(p)) return;
      if (!have[p]) plan.added.push(p);
      else if (have[p].hash !== now[p].hash) plan.changed.push(p);
    });
    Object.keys(have).forEach(function (p) {
      if (!keep.has(p) && !now[p]) plan.removed.push(p);
    });

    // Videos come from the video server; the app holds the ones it was built with.
    var inApp = await localJson("app-videos.json", []);
    plan.inApp = inApp;
    if (now["descriptions.json"]) {
      var liveDesc = await liveText("descriptions.json");
      var liveVideos = r2Videos(liveDesc);
      var sizes = r2Sizes(liveDesc);
      plan.newVideos = Array.from(liveVideos).filter(function (f) { return inApp.indexOf(f) < 0; });
      plan.newVideoBytes = plan.newVideos.reduce(function (n, f) { return n + (sizes[f] || 0); }, 0);
      plan.newVideoSized = plan.newVideos.every(function (f) { return !!sizes[f]; });
      plan.goneVideos = inApp.filter(function (f) { return !liveVideos.has(f); });
    }

    [plan.added, plan.changed, plan.removed, plan.newVideos, plan.goneVideos].forEach(function (a) { a.sort(); });
    plan.removedAll = plan.removed.concat(plan.goneVideos);
    plan.total = Object.keys(now).filter(function (p) { return !keep.has(p); }).length;
    plan.inSync = plan.total - plan.added.length - plan.changed.length;
    plan.same = !plan.added.length && !plan.changed.length && !plan.removedAll.length && !plan.newVideos.length;
    return plan;
  }

  /* --------------------------------------------------------------- apply */

  // Makes the app match the website exactly: new and changed files are fetched,
  // files the website no longer has are removed, and videos that are new on the
  // website are downloaded into the app (one at a time, the biggest job).
  async function apply(plan, progress, ctl) {
    ctl = ctl || {};
    var android = PLAT === "android";
    var removeNow = plan.removedAll;
    var inApp = (plan.inApp || []).filter(function (f) { return removeNow.indexOf(f) < 0; });
    var inAppSet = new Set(inApp);
    var newVideos = (plan.newVideos || []).slice();
    var work = plan.added.concat(plan.changed);
    var total = work.length + removeNow.length + newVideos.length + 1;
    var done = 0, wrote = 0;
    var failedVideos = [], videoWhy = "", videosAdded = 0, mismatched = {};

    function step(name) { done++; if (progress) progress(done, total, name); }
    function saveVideoList() {
      return store.put("app-videos.json", new TextEncoder().encode(JSON.stringify(inApp.slice().sort())));
    }

    // 1. Files the website no longer has.
    for (var j = 0; j < removeNow.length && !ctl.cancelled; j++) {
      await store.remove(removeNow[j]);
      step(removeNow[j]);
    }

    // 2. New videos, one at a time. The list of the app's videos is written after
    //    each one, so a stop part way never loses what already came in.
    for (var v = 0; v < newVideos.length && !ctl.cancelled; v++) {
      var file = newVideos[v];
      var label = file.split("/").pop().replace(/\.[^.]+$/, "");
      if (videoWhy === "busy" || videoWhy === "space") { failedVideos.push(file); step(file); continue; }
      try {
        await store.video(file, function (got, len) {
          if (progress) progress(done + (len ? Math.min(got / len, 0.99) : 0), total,
            "video " + (v + 1) + " of " + newVideos.length + " · " + mb(got) + (len ? " of " + mb(len) : "") + " · " + label);
        }, ctl);
        inApp.push(file); inAppSet.add(file); videosAdded++;
        await saveVideoList();
      } catch (e) {
        if (ctl.cancelled || (e && e.code === "cancelled")) break;
        if (e && e.code === "lockdown") throw e;
        failedVideos.push(file);
        videoWhy = (e && e.code) || "network";
      }
      step(file);
    }

    if (ctl.cancelled) {
      if (videosAdded) { await saveVideoList(); await store.finish(); }
      return { cancelled: true, wrote: wrote, removed: 0, videosAdded: videosAdded };
    }

    // 3. Everything else: new and changed files.
    var queue = work.slice();
    async function worker() {
      while (queue.length && !ctl.cancelled) {
        var rel = queue.shift();
        var bytes = await liveBytes(rel);
        var want = LIVE_HASH[rel];
        // The phone hands text and data files over already decoded, so only their
        // meaning (not their exact bytes) can be compared; those are not checked.
        if (PLAT === "android" && /\.(html?|xml|json|js|mjs|css|txt|svg|webmanifest)$/i.test(rel)) want = "";
        if (want) {
          var got = await fingerprint(bytes);
          if (got !== want) {                      // an old copy from a network cache: ask again, past it
            bytes = await liveBytes(rel, true);
            got = await fingerprint(bytes);
          }
          if (got !== want) { mismatched[rel] = got; }
        }

        if (/\.(html|xml)$/i.test(rel) || rel === "descriptions.json") {
          var out = T.file(rel, new TextDecoder().decode(bytes), {
            android: android,
            hasVideo: function (f) { return inAppSet.has(f); }
          });
          if (out === null) { step(rel); continue; }        // not part of the app
          bytes = new TextEncoder().encode(out);
        }
        await store.put(rel, bytes);
        wrote++;
        step(rel);
      }
    }
    var pool = [];
    for (var i = 0; i < 4; i++) pool.push(worker());
    await Promise.all(pool);

    if (ctl.cancelled) {
      if (wrote || videosAdded) { await saveVideoList(); await store.finish(); }
      return { cancelled: true, wrote: wrote, removed: 0, videosAdded: videosAdded };
    }

    // The app's own lists: the files it now has, and the videos inside it.
    var files = plan.live.files.filter(function (f) { return T.KEEP.indexOf(f.path) < 0; }).map(function (f) {
      return mismatched[f.path] ? { path: f.path, size: f.size, hash: mismatched[f.path] } : f;   // flagged again by the next Check
    });
    files.sort(function (a, b) { return a.path < b.path ? -1 : 1; });
    var list = { count: files.length, totalBytes: files.reduce(function (n, f) { return n + (f.size || 0); }, 0), files: files };
    if (plan.live.desktop) list.desktop = plan.live.desktop;
    await store.put("site-files.json", new TextEncoder().encode(JSON.stringify(list, null, 1)));
    await saveVideoList();
    step("site-files.json");

    var ok = await store.finish();
    try { localStorage.setItem("lt_app_updated", new Date().toISOString()); } catch (e) {}
    return { cancelled: false, wrote: wrote, removed: removeNow.length, serviceOk: ok,
             videosAdded: videosAdded, failedVideos: failedVideos, videoWhy: videoWhy,
             notYet: Object.keys(mismatched) };
  }

  async function reset() { await store.reset(); try { localStorage.removeItem("lt_app_updated"); } catch (e) {} }

  window.AppUpdate = { check: check, apply: apply, reset: reset, platform: PLAT, isLocked: isLocked, setLocked: setLocked };

  /* ------------------------------------------------------ Settings cards */

  function ui() {
    var section = document.querySelector("section");
    if (!section || document.getElementById("appLockCard")) return;
    var first = section.querySelector(".card");

    var css = document.createElement("style");
    css.textContent =
      "#appUpdateCard .auWarn{margin-top:14px;padding:12px 14px;background:#211515;border:1px solid #5a2525;border-radius:8px;color:#ccc;font-size:.9em;line-height:1.45}" +
      "#appUpdateCard .auWarn strong{color:#ff5555}" +
      "#appUpdateCard details{margin-top:12px;font-size:.9em;color:#bbb}" +
      "#appUpdateCard summary{cursor:pointer;padding:6px 0}" +
      "#appUpdateCard #auList b{display:block;margin:10px 0 4px;color:#ddd}" +
      "#appUpdateCard #auList div.row{padding:2px 0;word-break:break-word}" +
      "#appUpdateCard [hidden],#appLockCard [hidden]{display:none}" +
      "#appUpdateCard .btn.cancelMode{background:transparent;color:#ff8080;border:1px solid #5a2c2c}" +
      "#appUpdateCard .btn.cancelMode:hover{background:#301a1a;border-color:#7a3a3a}";
    document.head.appendChild(css);

    var lock = document.createElement("div");
    lock.className = "card";
    lock.id = "appLockCard";
    lock.innerHTML =
      '<h2 class="hd"><span class="pv-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="10.5" width="14" height="10" rx="2.2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/></svg></span>Lockdown</h2>' +
      '<div class="rows"><div class="row"><span>Lockdown</span>' +
      '<button type="button" class="toggleSwitch active" id="auLockToggle" role="switch" aria-checked="true" aria-label="Lockdown"><span class="toggleKnob"></span></button></div></div>' +
      '<p class="note" id="auLockNote"></p>';

    var up = document.createElement("div");
    up.className = "card";
    up.id = "appUpdateCard";
    up.hidden = true;
    up.innerHTML =
      '<h2 class="hd"><span class="pv-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.5-3.5L4 9"/><path d="M4 4v5h5"/><path d="M4 13a8 8 0 0 0 14.5 3.5L20 15"/><path d="M20 20v-5h-5"/></svg></span>Update</h2>' +
      '<p class="note">Check goes through every file of this app (pages, scripts, pictures, PDFs and data) and compares it with the website. Update then makes this app match the website exactly, and saves any videos that are new on the website inside the app. It needs internet. Your favorites, bookmarks and settings are kept.</p>' +
      '<div class="verBox" id="auBox" data-state="current"><span class="verDot"></span><div class="verTxt"><b id="auTitle">Not checked yet</b><span id="auSub"></span></div></div>' +
      '<details id="auDetails" hidden><summary id="auSummary"></summary><div id="auList"></div></details>' +
      '<div class="verBarWrap" id="auBarWrap" hidden><i id="auBar"></i></div>' +
      '<div class="auWarn" id="auDont" hidden><strong>DO NOT CLOSE OR LEAVE THIS PAGE</strong><br><br>The app is being updated. Leaving this page may interrupt the process.<span id="auDontMore" hidden><br><br>New videos are large, so this can take a while. Stay on Wi-Fi if you can.</span></div>' +
      '<div class="actions" id="auActions"></div>' +
      '<p class="note" id="auNote"></p>';

    if (first && first.nextSibling) { section.insertBefore(lock, first.nextSibling); section.insertBefore(up, lock.nextSibling); }
    else { section.appendChild(lock); section.appendChild(up); }

    var $ = function (id) { return document.getElementById(id); };
    var working = false, ctl = null, plan = null, locked = true;

    // Names what Check found, so nothing is a mystery.
    function showDetails(p) {
      var d = $("auDetails"), box = $("auList");
      box.innerHTML = "";
      if (!p) { d.hidden = true; return; }
      var groups = [["New on the website", p.added], ["Changed on the website", p.changed],
                    ["No longer on the website", p.removedAll], ["New videos to save inside the app", p.newVideos]];
      var count = 0;
      groups.forEach(function (g) {
        if (!g[1].length) return;
        count += g[1].length;
        var h = document.createElement("b");
        h.textContent = g[0] + " (" + g[1].length + ")";
        box.appendChild(h);
        g[1].slice(0, 80).forEach(function (name) {
          var r = document.createElement("div"); r.className = "row"; r.textContent = name; box.appendChild(r);
        });
        if (g[1].length > 80) {
          var more = document.createElement("div"); more.className = "row"; more.textContent = "…and " + (g[1].length - 80) + " more"; box.appendChild(more);
        }
      });
      $("auSummary").textContent = "See exactly what will change (" + count + ")";
      d.hidden = !count;
    }

    // Every page, picture and paper again, whatever the lists say.
    function everything(p) {
      var q = {};
      Object.keys(p).forEach(function (k) { q[k] = p[k]; });
      q.added = [];
      q.changed = p.live.files.map(function (f) { return f.path; }).filter(function (x) { return T.KEEP.indexOf(x) < 0; }).sort();
      q.refreshAll = true;
      return q;
    }
    function refreshAction() {
      return { text: "Refresh everything", run: function () {
        if (working || !plan) return;
        plan = everything(plan);
        showDetails(null);
        doUpdate();
      } };
    }

    function state(kind, title, sub) {
      $("auBox").setAttribute("data-state", kind);
      $("auTitle").textContent = title;
      $("auSub").textContent = sub || "";
    }
    function actions(list) {
      var box = $("auActions");
      box.innerHTML = "";
      list.forEach(function (a) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "btn" + (a.cls ? " " + a.cls : "");
        b.textContent = a.text;
        b.addEventListener("click", a.run);
        box.appendChild(b);
      });
    }

    function paintLock() {
      $("auLockToggle").setAttribute("aria-checked", locked ? "true" : "false");
      $("auLockToggle").classList.toggle("active", locked);
      $("auLockNote").textContent = locked
        ? "On: nothing goes in and nothing comes out. This app never connects to the website and nothing can change its files, so this version stays exactly as it is. Turn it off only if you want to update the app."
        : "Off: the Update card below can connect to the website and bring this app up to date. Turn Lockdown back on to freeze this version.";
      up.hidden = locked;
    }

    function idle() {
      working = false; ctl = null; plan = null;
      $("auBarWrap").hidden = true; $("auDont").hidden = true;
      var when = "";
      try { when = localStorage.getItem("lt_app_updated") || ""; } catch (e) {}
      state("current", "Not checked yet", "");
      showDetails(null);
      $("auNote").textContent = when ? "Last updated " + new Date(when).toLocaleString() + "." : "";
      actions([{ text: "Check", cls: "primary", run: doCheck }]);
    }

    async function doCheck() {
      if (working) return;
      working = true; ctl = { cancelled: false };
      var mine = ctl;
      state("checking", "Checking every file…", "");
      $("auNote").textContent = "";
      actions([{ text: "Cancel", cls: "primary cancelMode", run: function () { mine.cancelled = true; idle(); } }]);
      try {
        plan = await check();
      } catch (e) {
        if (mine.cancelled) return;
        working = false;
        state("error", "Could not reach the website", "Check your internet connection and try again. (" + (e && e.message ? e.message : "no answer") + ")");
        actions([{ text: "Check", cls: "primary", run: doCheck }]);
        return;
      }
      if (mine.cancelled) return;
      if (PLAT === "android" && store.probe && !plan.same) {
        state("checking", "Checking that this phone can take the update…", "");
        var pr = await store.probe();
        if (mine.cancelled) return;
        if (!pr.ok) {
          working = false;
          showDetails(null);
          state("error", "This app is too old to be updated here",
            "It was installed from an older build, which cannot take updates. Nothing on this phone was changed. Install the newest app once from lanthanoresearch.com (its Install page), and Update will work from then on. (" + pr.why + ")");
          actions([{ text: "Check", cls: "primary", run: doCheck }]);
          return;
        }
      }
      working = false;
      var nv = plan.newVideos.length;
      var n = plan.added.length + plan.changed.length + plan.removedAll.length + nv;
      var videoText = nv
        ? " · includes " + nv + (nv === 1 ? " new video" : " new videos") + (plan.newVideoSized && plan.newVideoBytes ? " (about " + mb(plan.newVideoBytes) + ")" : "")
        : "";
      if (!n) {
        state("current", "Everything is in sync", plan.total + " of " + plan.total + " files match the website.");
        $("auNote").textContent = "Checked " + new Date().toLocaleString() + ". If a paper or page still looks old, press Refresh everything: it downloads every page and paper again.";
        showDetails(null);
        actions([{ text: "Check", cls: "primary", run: doCheck }, refreshAction()]);
        return;
      }
      state("outdated", "An update is available", plan.inSync + " files are in sync · " + n + " need updating" + videoText);
      $("auNote").textContent = nv ? (nv === 1 ? "The new video is saved inside the app, so it needs room on this device and plays with no internet afterwards." : "The new videos are saved inside the app, so they need room on this device and play with no internet afterwards.") : "";
      showDetails(plan);
      actions([{ text: "Update", cls: "primary", run: doUpdate }, refreshAction()]);
    }

    async function doUpdate() {
      if (working) return;
      working = true; ctl = { cancelled: false };
      var mine = ctl, p = plan;
      $("auDont").hidden = false; $("auBarWrap").hidden = false; $("auBar").style.width = "0";
      $("auDontMore").hidden = !(p.newVideos && p.newVideos.length);
      $("auDetails").hidden = true;
      $("auNote").textContent = "";
      state("updating", "Updating…", "");
      actions([{ text: "Cancel", cls: "primary cancelMode", run: function () { mine.cancelled = true; $("auTitle").textContent = "Stopping…"; } }]);
      $("auLockToggle").disabled = true;
      var leave = function (e) { e.preventDefault(); e.returnValue = ""; };
      window.addEventListener("beforeunload", leave);
      var res;
      try {
        res = await apply(p, function (d, t, name) {
          $("auBar").style.width = Math.round(d / t * 100) + "%";
          $("auSub").textContent = Math.round(d / t * 100) + "% · " + name;
        }, mine);
      } catch (e) {
        window.removeEventListener("beforeunload", leave);
        $("auLockToggle").disabled = false;
        working = false;
        $("auDont").hidden = true; $("auBarWrap").hidden = true;
        state("error", "The update could not finish", "Some files may be updated already. Press Check to see what is left.");
        actions([{ text: "Check", cls: "primary", run: doCheck }]);
        return;
      }
      window.removeEventListener("beforeunload", leave);
      $("auLockToggle").disabled = false;
      $("auDont").hidden = true; $("auBarWrap").hidden = true;
      working = false;
      if (res.cancelled) {
        state("outdated", "Stopped", "Some files may be updated already. Press Check to see what is left.");
        actions([{ text: "Check", cls: "primary", run: doCheck }]);
        return;
      }
      if (PLAT === "android" && res.serviceOk === false) {
        try { await window.AppUpdate.reset(); } catch (e) {}
        state("error", "This phone could not use the update", "The app keeps working with the files it came with. (" + (store.lastWhy || "no reason given") + ")");
        actions([{ text: "Check", cls: "primary", run: doCheck }]);
        return;
      }
      var late = (res.notYet || []).length;
      var bad = (res.failedVideos || []).length;
      if (late && !bad) {
        state("outdated", "Updated, but " + late + (late === 1 ? " file was" : " files were") + " not the newest yet",
          "The website is still publishing " + (late === 1 ? "it" : "them") + ". Wait a few minutes, then press Check and Update. (" + res.notYet.slice(0, 3).join(", ") + (late > 3 ? ", …" : "") + ")");
        actions([{ text: "Check", cls: "primary", run: doCheck }]);
        showVideoCount();
        return;
      }
      if (bad) {
        var why = res.videoWhy === "busy" ? "The video server is busy right now. Press Check, then Update, to try again later."
          : res.videoWhy === "space" ? "There is not enough room on this device for them. Free some space, then press Check and Update."
          : "Press Check, then Update, to try again. Make sure you are online.";
        state("outdated", "Updated, but " + bad + (bad === 1 ? " video" : " videos") + " could not be saved", why);
        actions([{ text: "Check", cls: "primary", run: doCheck }]);
        showVideoCount();
        return;
      }
      state("current", "Updated", "The app now matches the website. Reloading…");
      actions([]);
      setTimeout(function () { location.reload(); }, 1200);
    }

    // The small line at the bottom of Settings counts the videos inside the app.
    async function showVideoCount() {
      try {
        var line = document.getElementById("appBuild");
        var have = await localJson("app-videos.json", []);
        var data = await localJson("descriptions.json", {});
        var all = new Set(have);
        (function walk(o) {
          if (Array.isArray(o)) o.forEach(walk);
          else if (o && typeof o === "object") {
            if (typeof o.file === "string" && o.file && o.source !== "site") all.add(o.file);
            Object.keys(o).forEach(function (k) { walk(o[k]); });
          }
        })(data);
        var counts = "videos inside: " + have.length + " of " + all.size;
        if (!line) {
          // Update swaps in the website's Settings page, which has no build line, so draw it again.
          var b = await localJson("app-build.json", null);
          if (!b || !b.run) return;
          line = document.createElement("p");
          line.className = "note"; line.id = "appBuild";
          line.style.cssText = "text-align:center;margin:30px 0 0";
          line.textContent = "Lanthano Research Offline \u00b7 build " + b.run + (b.sha ? " (" + b.sha + ")" : "") + " \u00b7 " + b.when + " \u00b7 " + counts;
          var secs = document.querySelectorAll("section");
          if (secs.length) secs[secs.length - 1].parentNode.insertBefore(line, secs[secs.length - 1].nextSibling);
          else document.body.appendChild(line);
          return;
        }
        if (!/videos inside:/.test(line.textContent)) return;
        line.textContent = line.textContent.replace(/videos inside: .*$/, counts);
      } catch (e) {}
    }
    showVideoCount();

    $("auLockToggle").addEventListener("click", async function () {
      if (working) return;
      var want = !locked;
      try { await setLocked(want); } catch (e) { return; }
      locked = await isLocked();
      paintLock();
      if (!locked) idle();
    });

    isLocked().then(function (l) {
      locked = l;
      paintLock();
      if (!locked) idle();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ui);
  else ui();
})();
