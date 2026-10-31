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

  async function liveBytes(rel) {
    if (await isLocked()) throw new Error("lockdown");
    var url = LIVE + enc(rel) + (rel === "site-files.json" || rel === "descriptions.json" ? "?t=" + Date.now() : "");
    if (PLAT === "android") {
      // A normal request to lanthanoresearch.com would be answered by the app
      // itself, so the phone's own network code is used.
      var C = window.Capacitor;
      var Http = (C.Plugins && C.Plugins.CapacitorHttp) || (C.registerPlugin && C.registerPlugin("CapacitorHttp"));
      var r = await Http.request({ url: url, method: "GET", responseType: "blob", headers: { "Cache-Control": "no-cache" } });
      if (!r || r.status !== 200) throw new Error("http " + (r && r.status));
      return typeof r.data === "string" ? b64ToBytes(r.data) : new Uint8Array(0);
    }
    var res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error("http " + res.status);
    return new Uint8Array(await res.arrayBuffer());
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
        if (!("serviceWorker" in navigator)) return false;
        var reg = await navigator.serviceWorker.register("sw.js?overlay=1");
        var ready = await Promise.race([
          navigator.serviceWorker.ready,
          new Promise(function (_, no) { setTimeout(function () { no(new Error("slow")); }, 15000); })
        ]);
        var worker = reg.active || (ready && ready.active);
        if (!worker) return false;
        worker.postMessage({ type: "lt-overlay-changed" });
        return await new Promise(function (resolve) {
          var ch = new MessageChannel(), t = setTimeout(function () { resolve(false); }, 8000);
          ch.port1.onmessage = function (e) { clearTimeout(t); resolve(!!(e.data && e.data.ok)); };
          worker.postMessage({ type: "lt-health" }, [ch.port2]);
        });
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

  // What is new, changed or gone on the website compared with this app.
  async function check() {
    var mine = await localJson("site-files.json", { files: [] });
    var live = JSON.parse(await liveText("site-files.json"));
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
      var liveVideos = r2Videos(await liveText("descriptions.json"));
      plan.newVideos = Array.from(liveVideos).filter(function (f) { return inApp.indexOf(f) < 0; });
      plan.goneVideos = inApp.filter(function (f) { return !liveVideos.has(f); });
    }

    [plan.added, plan.changed, plan.removed, plan.newVideos, plan.goneVideos].forEach(function (a) { a.sort(); });
    plan.removedAll = plan.removed.concat(plan.goneVideos);
    plan.total = Object.keys(now).filter(function (p) { return !keep.has(p); }).length;
    plan.inSync = plan.total - plan.added.length - plan.changed.length;
    // New videos alone are not an update: they are not inside the app and play online.
    plan.same = !plan.added.length && !plan.changed.length && !plan.removedAll.length;
    return plan;
  }

  /* --------------------------------------------------------------- apply */

  // Makes the app match the website exactly: new and changed files are fetched,
  // files the website no longer has are removed.
  async function apply(plan, progress, ctl) {
    ctl = ctl || {};
    var android = PLAT === "android";
    var removeNow = plan.removedAll;
    var inApp = (plan.inApp || []).filter(function (f) { return removeNow.indexOf(f) < 0; });
    var inAppSet = new Set(inApp);
    var work = plan.added.concat(plan.changed);
    var total = work.length + removeNow.length + 1;
    var done = 0, wrote = 0;

    function step(name) { done++; if (progress) progress(done, total, name); }

    var queue = work.slice();
    async function worker() {
      while (queue.length && !ctl.cancelled) {
        var rel = queue.shift();
        var bytes = await liveBytes(rel);

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
      if (wrote) await store.finish();
      return { cancelled: true, wrote: wrote, removed: 0 };
    }

    for (var j = 0; j < removeNow.length && !ctl.cancelled; j++) {
      await store.remove(removeNow[j]);
      step(removeNow[j]);
    }

    if (ctl.cancelled) {
      await store.finish();
      return { cancelled: true, wrote: wrote, removed: 0 };
    }

    // The app's own lists: the files it now has, and the videos inside it.
    var files = plan.live.files.filter(function (f) { return T.KEEP.indexOf(f.path) < 0; });
    files.sort(function (a, b) { return a.path < b.path ? -1 : 1; });
    var list = { count: files.length, totalBytes: files.reduce(function (n, f) { return n + (f.size || 0); }, 0), files: files };
    if (plan.live.desktop) list.desktop = plan.live.desktop;
    await store.put("site-files.json", new TextEncoder().encode(JSON.stringify(list, null, 1)));
    await store.put("app-videos.json", new TextEncoder().encode(JSON.stringify(inApp)));
    step("site-files.json");

    var ok = await store.finish();
    try { localStorage.setItem("lt_app_updated", new Date().toISOString()); } catch (e) {}
    return { cancelled: false, wrote: wrote, removed: removeNow.length, serviceOk: ok };
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
      '<button type="button" class="toggleSwitch" id="auLockToggle" role="switch" aria-checked="true" aria-label="Lockdown"><span class="toggleKnob"></span></button></div></div>' +
      '<p class="note" id="auLockNote"></p>';

    var up = document.createElement("div");
    up.className = "card";
    up.id = "appUpdateCard";
    up.hidden = true;
    up.innerHTML =
      '<h2 class="hd"><span class="pv-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.5-3.5L4 9"/><path d="M4 4v5h5"/><path d="M4 13a8 8 0 0 0 14.5 3.5L20 15"/><path d="M20 20v-5h-5"/></svg></span>Update</h2>' +
      '<p class="note">Check goes through every file of this app (pages, scripts, pictures, PDFs and data) and compares it with the website. Update then makes this app match the website exactly. It needs internet. Your favorites, bookmarks and settings are kept.</p>' +
      '<div class="verBox" id="auBox" data-state="current"><span class="verDot"></span><div class="verTxt"><b id="auTitle">Not checked yet</b><span id="auSub"></span></div></div>' +
      '<div class="verBarWrap" id="auBarWrap" hidden><i id="auBar"></i></div>' +
      '<div class="auWarn" id="auDont" hidden><strong>DO NOT CLOSE OR LEAVE THIS PAGE</strong><br><br>The app is being updated. Leaving this page may interrupt the process.</div>' +
      '<div class="actions" id="auActions"></div>' +
      '<p class="note" id="auNote"></p>';

    if (first && first.nextSibling) { section.insertBefore(lock, first.nextSibling); section.insertBefore(up, lock.nextSibling); }
    else { section.appendChild(lock); section.appendChild(up); }

    var $ = function (id) { return document.getElementById(id); };
    var working = false, ctl = null, plan = null, locked = true;

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
        state("error", "Could not reach the website", "Check your internet connection and try again.");
        actions([{ text: "Check", cls: "primary", run: doCheck }]);
        return;
      }
      if (mine.cancelled) return;
      working = false;
      var n = plan.added.length + plan.changed.length + plan.removedAll.length;
      var nv = plan.newVideos.length;
      var videoNote = nv ? nv + (nv === 1 ? " video on the website is not inside this app and plays" : " videos on the website are not inside this app and play") + " when you are online." : "";
      if (!n) {
        state("current", "Everything is in sync", plan.total + " of " + plan.total + " files match the website.");
        $("auNote").textContent = "Checked " + new Date().toLocaleString() + "." + (videoNote ? " " + videoNote : "");
        actions([{ text: "Check", cls: "primary", run: doCheck }]);
        return;
      }
      state("outdated", "An update is available", plan.inSync + " files are in sync · " + n + " need updating");
      $("auNote").textContent = videoNote;
      actions([{ text: "Update", cls: "primary", run: doUpdate }]);
    }

    async function doUpdate() {
      if (working) return;
      working = true; ctl = { cancelled: false };
      var mine = ctl, p = plan;
      $("auDont").hidden = false; $("auBarWrap").hidden = false; $("auBar").style.width = "0";
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
        state("error", "This phone could not use the update", "The app keeps working with the files it came with.");
        actions([{ text: "Check", cls: "primary", run: doCheck }]);
        return;
      }
      state("current", "Updated", "The app now matches the website. Reloading…");
      actions([]);
      setTimeout(function () { location.reload(); }, 1200);
    }

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
