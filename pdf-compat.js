/*
==========================================================
LANTHANO RESEARCH: PDF VIEWER COMPATIBILITY
==========================================================

The PDF viewer (pdf.js) uses a few very new browser features. The apps run in
an older browser engine that does not have them yet, and the viewer then says
"Unable to load PDF". This file adds each missing feature, and only when it is
missing, so newer browsers are not touched at all.

It is loaded by pdf-lib.mjs (the page) and pdf-worker.mjs (the worker), always
before pdf.js itself.
==========================================================
*/

(function (g) {
  "use strict";

  function def(obj, name, fn) {
    try {
      if (obj && typeof obj[name] !== "function") {
        Object.defineProperty(obj, name, { value: fn, writable: true, configurable: true });
      }
    } catch (e) {}
  }

  /* ---- bytes <-> hex / base64 ---- */

  var U8 = g.Uint8Array;
  if (U8) {
    def(U8.prototype, "toHex", function () {
      var out = "";
      for (var i = 0; i < this.length; i++) {
        out += (this[i] < 16 ? "0" : "") + this[i].toString(16);
      }
      return out;
    });

    def(U8.prototype, "toBase64", function (options) {
      var url = options && options.alphabet === "base64url";
      var pad = !(options && options.omitPadding);
      var bin = "";
      for (var i = 0; i < this.length; i += 8192) {
        bin += String.fromCharCode.apply(null, this.subarray(i, i + 8192));
      }
      var s = g.btoa(bin);
      if (url) { s = s.replace(/\+/g, "-").replace(/\//g, "_"); }
      if (!pad) { s = s.replace(/=+$/, ""); }
      return s;
    });

    def(U8, "fromHex", function (text) {
      text = String(text);
      if (text.length % 2 || /[^0-9a-fA-F]/.test(text)) {
        throw new SyntaxError("Invalid hex string");
      }
      var out = new U8(text.length / 2);
      for (var i = 0; i < out.length; i++) {
        out[i] = parseInt(text.substr(i * 2, 2), 16);
      }
      return out;
    });

    def(U8, "fromBase64", function (text, options) {
      var s = String(text).replace(/[\t\n\f\r ]+/g, "");
      if (options && options.alphabet === "base64url") {
        s = s.replace(/-/g, "+").replace(/_/g, "/");
      }
      while (s.length % 4) { s += "="; }
      var bin = g.atob(s);
      var out = new U8(bin.length);
      for (var i = 0; i < bin.length; i++) { out[i] = bin.charCodeAt(i); }
      return out;
    });
  }

  /* ---- Map / WeakMap: getOrInsert ---- */

  [g.Map, g.WeakMap].forEach(function (C) {
    if (!C) { return; }
    def(C.prototype, "getOrInsert", function (key, value) {
      if (!this.has(key)) { this.set(key, value); }
      return this.get(key);
    });
    def(C.prototype, "getOrInsertComputed", function (key, callback) {
      if (this.has(key)) { return this.get(key); }
      var value = callback(key);
      this.set(key, value);
      return value;
    });
  });

  /* ---- Math.sumPrecise ---- */

  if (g.Math) {
    def(g.Math, "sumPrecise", function (items) {
      var sum = 0, c = 0, any = false;
      for (var x of items) {
        x = Number(x);
        any = true;
        var t = sum + x;
        if (Math.abs(sum) >= Math.abs(x)) { c += (sum - t) + x; } else { c += (x - t) + sum; }
        sum = t;
      }
      return any ? sum + c : -0;
    });
  }

  /* ---- smaller things ---- */

  if (g.Promise) {
    def(g.Promise, "try", function (fn) {
      var args = Array.prototype.slice.call(arguments, 1);
      return new Promise(function (resolve) { resolve(fn.apply(undefined, args)); });
    });
    def(g.Promise, "withResolvers", function () {
      var resolve, reject;
      var promise = new Promise(function (a, b) { resolve = a; reject = b; });
      return { promise: promise, resolve: resolve, reject: reject };
    });
  }

  if (g.URL) {
    def(g.URL, "parse", function (url, base) {
      try { return base === undefined ? new g.URL(url) : new g.URL(url, base); } catch (e) { return null; }
    });
  }
})(globalThis);
