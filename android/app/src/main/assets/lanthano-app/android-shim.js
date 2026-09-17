/*
 * Lanthano Research - Android app shim
 *
 * Injected as the first script of every HTML page by LocalAssetServer, so it
 * runs before any of the site's own code. It does nothing unless the native
 * bridge (window.LanthanoAndroid) is present, i.e. outside the Android app the
 * site behaves exactly as before.
 *
 * It adapts the handful of browser features that Android WebView either lacks
 * or implements differently, without changing the site's own files:
 *
 *   - service worker registration is skipped (every file is already bundled)
 *   - <a download> saves go through the Android "Save as" picker
 *   - window.open() stays inside the app (media viewer / in-app navigation)
 *   - navigator.share and clipboard.writeText use Android's share sheet/clipboard
 *   - speechSynthesis (Read Aloud) is backed by Android's on-device TextToSpeech
 *   - navigator.wakeLock keeps the screen on while Read Aloud is playing
 *   - the Android Back button closes the media viewer / fullscreen first
 */
(function () {
  "use strict";

  if (window.__lanthanoApp) return;

  var bridge = window.LanthanoAndroid;
  if (!bridge) return;

  // Canonical public origin the site itself uses in its own share links
  // (see shareSite() in index.html). Only used when a page shares/copies a
  // link to one of its own pages.
  var PUBLIC_ORIGIN = "https://lanthanoresearch.com";

  var app = { isAndroidApp: true, version: 1 };
  window.__lanthanoApp = app;

  function log() {
    try {
      console.info.apply(console, ["[Lanthano app]"].concat(Array.prototype.slice.call(arguments)));
    } catch (e) { /* ignore */ }
  }

  // Like decodeURIComponent, but keeps invalid %-escapes literally (the way a
  // web server treats a path such as "/33%%20Desert.png").
  function safeDecode(value) {
    try { return decodeURIComponent(value); } catch (e) { /* fall through */ }
    try {
      return decodeURIComponent(String(value).replace(/%(?![0-9a-fA-F]{2})/g, "%25"));
    } catch (e2) {
      return value;
    }
  }

  function extOf(pathname) {
    var m = /\.([a-z0-9]+)$/i.exec(pathname || "");
    return m ? m[1].toLowerCase() : "";
  }

  var MIME = {
    html: "text/html", htm: "text/html", pdf: "application/pdf", json: "application/json",
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
    avif: "image/avif", svg: "image/svg+xml", bmp: "image/bmp",
    mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime",
    mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", wav: "audio/wav",
    zip: "application/zip", txt: "text/plain"
  };

  function mimeOf(name) {
    return MIME[extOf(name)] || "application/octet-stream";
  }

  function kindOfMime(mime) {
    mime = String(mime || "").toLowerCase();
    if (mime === "text/html") return "html";
    if (mime === "application/pdf") return "pdf";
    if (mime.indexOf("image/") === 0) return "image";
    if (mime.indexOf("video/") === 0) return "video";
    if (mime.indexOf("audio/") === 0) return "audio";
    return "other";
  }

  function sanitizeName(name) {
    name = String(name || "").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").trim();
    if (!name) name = "download";
    if (name.length > 150) {
      var ext = extOf(name);
      name = name.slice(0, 140) + (ext ? "." + ext : "");
    }
    return name;
  }

  function isLocal(u) {
    return u.origin === location.origin;
  }

  function toPublicUrl(value) {
    try {
      var u = new URL(value, location.href);
      if (isLocal(u)) return PUBLIC_ORIGIN + u.pathname + u.search + u.hash;
      return u.href;
    } catch (e) {
      return String(value);
    }
  }

  /* ------------------------------------------------------------------
   * 1. Service worker: not needed (and not wanted) inside the app.
   * ------------------------------------------------------------------ */
  try {
    var swContainer = navigator.serviceWorker;
    if (swContainer) {
      if (typeof swContainer.getRegistrations === "function") {
        swContainer.getRegistrations().then(function (regs) {
          regs.forEach(function (r) { r.unregister(); });
        }).catch(function () {});
      }
      Object.defineProperty(swContainer, "register", {
        configurable: true,
        writable: true,
        value: function () {
          log("Service worker registration skipped - all files are bundled in the app.");
          return new Promise(function () {}); // never settles, like a pending registration
        }
      });
    }
  } catch (e) { /* ignore */ }

  /* ------------------------------------------------------------------
   * 2. Blob registry, so a download link can be saved even if the page
   *    revokes its blob: URL right after clicking it.
   * ------------------------------------------------------------------ */
  var blobRegistry = new Map();
  var originalCreateObjectURL = URL.createObjectURL;
  var originalRevokeObjectURL = URL.revokeObjectURL;

  URL.createObjectURL = function (obj) {
    var url = originalCreateObjectURL.apply(URL, arguments);
    try {
      if (typeof Blob !== "undefined" && obj instanceof Blob) blobRegistry.set(url, obj);
    } catch (e) { /* ignore */ }
    return url;
  };

  URL.revokeObjectURL = function (url) {
    blobRegistry.delete(String(url));
    return originalRevokeObjectURL.apply(URL, arguments);
  };

  function blobFromUrl(href) {
    var known = blobRegistry.get(href);
    if (known) return Promise.resolve(known);
    return fetch(href).then(function (r) { return r.blob(); });
  }

  /* ------------------------------------------------------------------
   * 3. Saving files ("Download" buttons).
   * ------------------------------------------------------------------ */
  var saveSeq = 0;
  var saveWaiters = new Map();

  function nextId(prefix) {
    saveSeq += 1;
    return prefix + saveSeq + "_" + Date.now().toString(36);
  }

  // Called by native once the user has picked (or cancelled) a destination.
  app._saveReady = function (id, ok) {
    var waiter = saveWaiters.get(id);
    if (waiter) {
      saveWaiters.delete(id);
      waiter(!!ok);
    }
  };

  function readChunkBase64(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var s = String(reader.result || "");
        var i = s.indexOf(",");
        resolve(i >= 0 ? s.slice(i + 1) : "");
      };
      reader.onerror = function () { reject(reader.error); };
      reader.readAsDataURL(blob);
    });
  }

  function saveBlob(blob, name) {
    var id = nextId("b");
    var mime = blob.type || mimeOf(name);
    return new Promise(function (resolve) {
      saveWaiters.set(id, resolve);
      bridge.beginSave(id, sanitizeName(name), mime);
    }).then(function (ok) {
      if (!ok) return false;
      var CHUNK = 2 * 1024 * 1024;
      var offset = 0;
      function step() {
        if (offset >= blob.size) {
          bridge.finishSave(id, true);
          return true;
        }
        var end = Math.min(offset + CHUNK, blob.size);
        return readChunkBase64(blob.slice(offset, end)).then(function (b64) {
          if (!bridge.writeSaveChunk(id, b64)) throw new Error("write failed");
          offset = end;
          return step();
        });
      }
      return Promise.resolve().then(step).catch(function (err) {
        log("Save failed:", err);
        bridge.finishSave(id, false);
        return false;
      });
    });
  }

  function saveHref(href, suggestedName) {
    var u;
    try { u = new URL(href, location.href); } catch (e) { return false; }

    var name = suggestedName || safeDecode(u.pathname.split("/").pop() || "") || "download";

    if (u.protocol === "blob:" || u.protocol === "data:") {
      blobFromUrl(u.href).then(function (blob) {
        return saveBlob(blob, name);
      }).catch(function (err) {
        log("Could not read file for saving:", err);
        bridge.toast("Couldn't save this file.");
      });
      return true;
    }

    if (isLocal(u)) {
      // The raw (still %-encoded) path is passed; the app decodes it itself.
      bridge.saveAsset(nextId("a"), u.pathname, sanitizeName(name), mimeOf(u.pathname));
      return true;
    }

    if (u.protocol === "http:" || u.protocol === "https:") {
      bridge.openExternal(u.href);
      return true;
    }
    return false;
  }

  function saveFromAnchor(a) {
    var href = a.getAttribute("href");
    if (!href) return false;
    return saveHref(a.href, a.getAttribute("download") || "");
  }

  var originalAnchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.hasAttribute("download") && saveFromAnchor(this)) return;
    return originalAnchorClick.apply(this, arguments);
  };

  window.addEventListener("click", function (ev) {
    var target = ev.target;
    var a = target && target.closest ? target.closest("a[download]") : null;
    if (a && saveFromAnchor(a)) ev.preventDefault();
  }, true);

  // Native DownloadListener fallback (e.g. a download started some other way).
  app._nativeDownload = function (url, suggestedName) {
    saveHref(url, suggestedName || "");
  };

  /* ------------------------------------------------------------------
   * 4. In-app media viewer (used for "open in new tab" on images/video).
   * ------------------------------------------------------------------ */
  var viewer = null;

  function closeViewer() {
    if (!viewer) return false;
    try { if (viewer.media.pause) viewer.media.pause(); } catch (e) { /* ignore */ }
    viewer.wrap.remove();
    viewer = null;
    return true;
  }

  function openViewer(src, kind) {
    closeViewer();

    var wrap = document.createElement("div");
    wrap.setAttribute("data-lanthano-viewer", "");
    wrap.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;background:#000;overflow:auto;" +
      "display:flex;align-items:center;justify-content:center;";

    var media;
    if (kind === "video" || kind === "audio") {
      media = document.createElement(kind);
      media.controls = true;
      media.autoplay = true;
      media.setAttribute("playsinline", "");
      media.style.cssText = "max-width:100%;max-height:100%;";
    } else {
      media = document.createElement("img");
      media.alt = "";
      var fitCss = "max-width:100%;max-height:100%;object-fit:contain;";
      media.style.cssText = fitCss;
      var zoomed = false;
      media.addEventListener("click", function () {
        zoomed = !zoomed;
        media.style.cssText = zoomed ? "max-width:none;max-height:none;" : fitCss;
        wrap.style.display = zoomed ? "block" : "flex";
      });
    }
    media.src = src;

    var close = document.createElement("button");
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    close.textContent = "\u2715";
    close.style.cssText =
      "position:fixed;top:12px;right:12px;width:44px;height:44px;border-radius:22px;" +
      "border:0;background:rgba(40,40,40,.85);color:#fff;font:20px/44px Arial,sans-serif;" +
      "padding:0;z-index:1;";
    close.addEventListener("click", closeViewer);

    wrap.appendChild(media);
    wrap.appendChild(close);
    (document.body || document.documentElement).appendChild(wrap);
    viewer = { wrap: wrap, media: media };
  }

  app.openViewer = openViewer;
  app.closeViewer = closeViewer;

  /* ------------------------------------------------------------------
   * 5. window.open - keep everything inside the app.
   * ------------------------------------------------------------------ */
  var originalOpen = window.open;
  window.open = function (url) {
    if (url === undefined || url === null || url === "" || url === "about:blank") {
      return originalOpen.apply(window, arguments);
    }
    var u;
    try { u = new URL(String(url), location.href); } catch (e) { return null; }

    if (u.protocol === "blob:" || u.protocol === "data:") {
      blobFromUrl(u.href).then(function (blob) {
        var kind = kindOfMime(blob.type);
        if (kind === "image" || kind === "video" || kind === "audio") {
          openViewer(URL.createObjectURL(blob), kind);
        } else {
          saveBlob(blob, "file");
        }
      }).catch(function (err) { log("Could not open blob:", err); });
      return null;
    }

    if (isLocal(u)) {
      var kind = kindOfMime(mimeOf(u.pathname));
      if (kind === "pdf") {
        bridge.openAssetExternally(u.pathname, "application/pdf");
      } else if (kind === "image" || kind === "video" || kind === "audio") {
        openViewer(u.href, kind);
      } else {
        location.assign(u.href);
      }
      return null;
    }

    bridge.openExternal(u.href);
    return null;
  };

  /* ------------------------------------------------------------------
   * 6. Share sheet + clipboard.
   * ------------------------------------------------------------------ */
  try {
    Object.defineProperty(navigator, "share", {
      configurable: true,
      writable: true,
      value: function (data) {
        return new Promise(function (resolve, reject) {
          data = data || {};
          if (data.files && data.files.length) {
            reject(new DOMException("Sharing files is not supported in the app.", "NotAllowedError"));
            return;
          }
          var title = data.title ? String(data.title) : "";
          var text = data.text ? String(data.text) : "";
          var url = data.url ? toPublicUrl(String(data.url)) : "";
          if (!title && !text && !url) {
            reject(new TypeError("Nothing to share."));
            return;
          }
          try {
            bridge.share(title, text, url);
            resolve();
          } catch (e) {
            reject(new DOMException("Share failed.", "AbortError"));
          }
        });
      }
    });
    Object.defineProperty(navigator, "canShare", {
      configurable: true,
      writable: true,
      value: function (data) {
        return !!data && !(data.files && data.files.length) && !!(data.title || data.text || data.url);
      }
    });
  } catch (e) { /* ignore */ }

  try {
    var clipboard = navigator.clipboard;
    if (clipboard) {
      var originalWriteText = clipboard.writeText ? clipboard.writeText.bind(clipboard) : null;
      Object.defineProperty(clipboard, "writeText", {
        configurable: true,
        writable: true,
        value: function (text) {
          var value = String(text);
          if (value.indexOf(location.origin + "/") === 0) value = toPublicUrl(value);
          try {
            bridge.copyText(value);
            return Promise.resolve();
          } catch (e) {
            return originalWriteText ? originalWriteText(value) : Promise.reject(e);
          }
        }
      });
    }
  } catch (e) { /* ignore */ }

  /* ------------------------------------------------------------------
   * 7. speechSynthesis backed by Android TextToSpeech (Read Aloud).
   * ------------------------------------------------------------------ */
  (function installSpeech() {
    if (typeof bridge.ttsStart !== "function") return;

    var EVENT_TYPES = ["start", "end", "error", "pause", "resume", "mark", "boundary"];
    var voices = [];

    function loadVoices() {
      try {
        voices = JSON.parse(bridge.ttsVoices() || "[]").map(function (v) {
          return Object.freeze({
            name: String(v.name),
            lang: String(v.lang || ""),
            voiceURI: String(v.voiceURI),
            localService: true,
            "default": !!v["default"]
          });
        });
      } catch (e) {
        voices = [];
      }
    }

    class SpeechUtterance extends EventTarget {
      constructor(text) {
        super();
        var self = this;
        this.text = text === undefined || text === null ? "" : String(text);
        this.lang = "";
        this.voice = null;
        this.volume = 1;
        this.rate = 1;
        this.pitch = 1;
        EVENT_TYPES.forEach(function (type) {
          self["on" + type] = null;
          self.addEventListener(type, function (ev) {
            var handler = self["on" + type];
            if (typeof handler === "function") handler.call(self, ev);
          });
        });
      }
    }

    function fire(utt, type, extra) {
      extra = extra || {};
      var ev = new Event(type);
      Object.defineProperties(ev, {
        utterance: { value: utt },
        charIndex: { value: extra.charIndex || 0 },
        charLength: { value: extra.charLength || 0 },
        elapsedTime: { value: extra.elapsedTime || 0 },
        name: { value: extra.name || "" },
        error: { value: extra.error }
      });
      utt.dispatchEvent(ev);
    }

    var synth = new EventTarget();
    var queue = [];
    var current = null;
    var paused = false;
    var tokenSeq = 0;
    var readyWaiters = [];

    synth.onvoiceschanged = null;
    synth.addEventListener("voiceschanged", function (ev) {
      if (typeof synth.onvoiceschanged === "function") synth.onvoiceschanged.call(synth, ev);
    });

    Object.defineProperties(synth, {
      speaking: { get: function () { return !!current; } },
      pending: { get: function () { return queue.length > 0; } },
      paused: { get: function () { return paused; } }
    });

    function elapsed(c) {
      return c.startedAt ? (performance.now() - c.startedAt) / 1000 : 0;
    }

    function finish(c, type, extra) {
      if (current !== c) return;
      current = null;
      c.token = null;
      if (type === "end" && !c.started) fire(c.utt, "start", { charIndex: 0 });
      var info = extra || {};
      info.elapsedTime = elapsed(c);
      fire(c.utt, type, info);
      startNext();
    }

    function whenReady(onReady, onFail) {
      if (bridge.ttsReady()) {
        onReady();
        return;
      }
      if (bridge.ttsFailed()) {
        onFail();
        return;
      }
      var entry = { ok: onReady, fail: onFail };
      readyWaiters.push(entry);
      bridge.ttsWarmUp();
      setTimeout(function () {
        var i = readyWaiters.indexOf(entry);
        if (i >= 0) {
          readyWaiters.splice(i, 1);
          onFail();
        }
      }, 10000);
    }

    function speakFrom(c, from) {
      tokenSeq += 1;
      var token = "t" + tokenSeq;
      c.token = token;
      c.offset = from;
      var text = c.utt.text.slice(from);

      if (!text.trim()) {
        setTimeout(function () {
          if (current === c && c.token === token) finish(c, "end", { charIndex: c.utt.text.length });
        }, 0);
        return;
      }

      whenReady(function () {
        if (current !== c || c.token !== token) return;
        var v = c.utt.voice;
        var ok = false;
        try {
          ok = bridge.ttsStart(
            token,
            text,
            v && v.voiceURI ? String(v.voiceURI) : "",
            String(c.utt.lang || (v && v.lang) || ""),
            Number(c.utt.rate) || 1,
            Number(c.utt.pitch) || 1,
            c.utt.volume === undefined || c.utt.volume === null ? 1 : Number(c.utt.volume)
          );
        } catch (e) {
          ok = false;
        }
        if (!ok) finish(c, "error", { error: "synthesis-failed", charIndex: from });
      }, function () {
        if (current === c && c.token === token) finish(c, "error", { error: "synthesis-unavailable" });
      });
    }

    function startNext() {
      if (current || paused) return;
      var utt = queue.shift();
      if (!utt) return;
      current = { utt: utt, token: null, offset: 0, lastIndex: 0, started: false, startedAt: 0 };
      speakFrom(current, 0);
    }

    synth.getVoices = function () {
      if (!voices.length) {
        if (bridge.ttsReady()) loadVoices();
        else bridge.ttsWarmUp();
      }
      return voices.slice();
    };

    synth.speak = function (utt) {
      if (!(utt instanceof SpeechUtterance)) {
        throw new TypeError("Failed to execute 'speak': parameter 1 is not a SpeechSynthesisUtterance.");
      }
      queue.push(utt);
      if (!current && !paused) startNext();
    };

    synth.cancel = function () {
      var dropped = queue.splice(0);
      var c = current;
      current = null;
      try { bridge.ttsStop(); } catch (e) { /* ignore */ }
      if (c) {
        c.token = null;
        fire(c.utt, "error", { error: "interrupted", charIndex: c.lastIndex, elapsedTime: elapsed(c) });
      }
      dropped.forEach(function (u) { fire(u, "error", { error: "canceled" }); });
    };

    synth.pause = function () {
      if (paused) return;
      paused = true;
      if (current) {
        try { bridge.ttsStop(); } catch (e) { /* ignore */ }
        current.token = null;
        fire(current.utt, "pause", { charIndex: current.lastIndex, elapsedTime: elapsed(current) });
      }
    };

    synth.resume = function () {
      if (!paused) return;
      paused = false;
      if (current) {
        fire(current.utt, "resume", { charIndex: current.lastIndex, elapsedTime: elapsed(current) });
        speakFrom(current, current.lastIndex);
      } else {
        startNext();
      }
    };

    // Native -> JS: progress events for the utterance identified by token.
    app._tts = function (token, type, charIndex, charLength) {
      var c = current;
      if (!c || c.token !== token) return;
      if (type === "start") {
        if (!c.started) {
          c.started = true;
          c.startedAt = performance.now();
          fire(c.utt, "start", { charIndex: c.offset });
        }
      } else if (type === "boundary") {
        var idx = c.offset + (charIndex | 0);
        c.lastIndex = idx;
        fire(c.utt, "boundary", {
          name: "word", charIndex: idx, charLength: charLength | 0, elapsedTime: elapsed(c)
        });
      } else if (type === "end") {
        finish(c, "end", { charIndex: c.utt.text.length });
      } else if (type === "error") {
        finish(c, "error", { error: "synthesis-failed", charIndex: c.lastIndex });
      }
    };

    // Native -> JS: the TTS engine finished initialising (or failed to).
    app._ttsReady = function () {
      var waiters = readyWaiters.splice(0);
      var ok = bridge.ttsReady();
      if (ok) loadVoices();
      waiters.forEach(function (w) {
        try { (ok ? w.ok : w.fail)(); } catch (e) { /* ignore */ }
      });
      if (ok) synth.dispatchEvent(new Event("voiceschanged"));
    };

    if (bridge.ttsReady()) loadVoices();

    try {
      Object.defineProperty(window, "speechSynthesis", {
        configurable: true, enumerable: true, get: function () { return synth; }
      });
    } catch (e) {
      try {
        Object.defineProperty(Window.prototype, "speechSynthesis", {
          configurable: true, enumerable: true, get: function () { return synth; }
        });
      } catch (e2) { log("Could not install speech support:", e2); }
    }
    window.SpeechSynthesisUtterance = SpeechUtterance;
  })();

  /* ------------------------------------------------------------------
   * 8. Screen Wake Lock (navigator.wakeLock) -> Android "keep screen on".
   *    Android WebView has no Screen Wake Lock API; Read Aloud uses it to
   *    stop the phone from locking while it reads.
   *    pdf.html may request a new lock while it still holds one and keeps
   *    only the newest, so a new request quietly supersedes older sentinels
   *    (no "release" event for those, which would clear the page's reference
   *    to the new one). Locks are released, with an event, when the page is
   *    hidden, as the specification requires.
   * ------------------------------------------------------------------ */
  (function installWakeLock() {
    if (typeof bridge.setKeepScreenOn !== "function") return;
    var current = null;

    function keepOn(on) {
      try { bridge.setKeepScreenOn(!!on); } catch (e) { log("keep screen on failed:", e); }
    }

    class LanthanoWakeLockSentinel extends EventTarget {
      constructor() {
        super();
        this._released = false;
        this.onrelease = null;
      }
      get released() { return this._released; }
      get type() { return "screen"; }
      release() {
        releaseSentinel(this, true);
        return Promise.resolve();
      }
    }

    function releaseSentinel(sentinel, notify) {
      if (!sentinel || sentinel._released) return;
      sentinel._released = true;
      if (current === sentinel) {
        current = null;
        keepOn(false);
      }
      if (!notify) return;
      var event = new Event("release");
      try {
        if (typeof sentinel.onrelease === "function") sentinel.onrelease.call(sentinel, event);
      } catch (e) { log(e); }
      sentinel.dispatchEvent(event);
    }

    var wakeLock = {
      request: function (type) {
        if (type !== undefined && type !== "screen") {
          return Promise.reject(new TypeError("Unsupported wake lock type: " + type));
        }
        if (document.visibilityState !== "visible") {
          return Promise.reject(new DOMException("The document is not visible.", "NotAllowedError"));
        }
        var previous = current;
        var sentinel = new LanthanoWakeLockSentinel();
        current = sentinel;
        if (previous) previous._released = true; // superseded, silently
        keepOn(true);
        return Promise.resolve(sentinel);
      }
    };

    function releaseAll() {
      releaseSentinel(current, true);
      keepOn(false);
    }
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState !== "visible") releaseAll();
    });
    window.addEventListener("pagehide", releaseAll);

    try {
      Object.defineProperty(navigator, "wakeLock", {
        configurable: true, enumerable: true, get: function () { return wakeLock; }
      });
      if (typeof window.WakeLockSentinel === "undefined") window.WakeLockSentinel = LanthanoWakeLockSentinel;
    } catch (e) { log("Could not install wake lock support:", e); }
  })();

  /* ------------------------------------------------------------------
   * 9. Android Back button.
   * ------------------------------------------------------------------ */
  app.handleBack = function () {
    if (closeViewer()) return true;
    if (document.fullscreenElement && document.exitFullscreen) {
      document.exitFullscreen().catch(function () {});
      return true;
    }
    return false;
  };
})();
