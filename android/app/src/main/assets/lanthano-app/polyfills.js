/*
 * Lanthano Research (Android) - JavaScript built-in polyfills.
 *
 * The bundled PDF.js (5.7, "modern" build) calls several very recent
 * JavaScript built-ins without feature detection, e.g.
 * Map.prototype.getOrInsertComputed and Math.sumPrecise. Android System WebView
 * is updated separately from the app and many phones run a WebView that does
 * not have them yet; without these polyfills PDF pages fail to render there.
 *
 * This file is loaded by the app before any page script, and it is also
 * prepended to the PDF.js worker (pdf.worker.mjs) when the app serves it, so it
 * must work both in a window and in a module worker. Every polyfill is added
 * only when the built-in is missing, so it is a no-op on an up-to-date WebView.
 */
(function () {
  "use strict";
  var G = typeof globalThis !== "undefined" ? globalThis : self;
  if (G.__lanthanoPolyfills) return;
  try {
    Object.defineProperty(G, "__lanthanoPolyfills", { value: true });
  } catch (e) {
    /* ignore */
  }

  function define(target, name, value) {
    if (!target || typeof target[name] !== "undefined") return;
    try {
      Object.defineProperty(target, name, { value: value, writable: true, configurable: true, enumerable: false });
    } catch (e) {
      /* ignore */
    }
  }

  // ------------------------------------------- Map / WeakMap "upsert"
  function addUpsert(proto) {
    if (!proto) return;
    define(proto, "getOrInsert", function getOrInsert(key, value) {
      if (this.has(key)) return this.get(key);
      this.set(key, value);
      return value;
    });
    define(proto, "getOrInsertComputed", function getOrInsertComputed(key, callbackfn) {
      if (typeof callbackfn !== "function") throw new TypeError("callbackfn is not a function");
      if (this.has(key)) return this.get(key);
      var value = callbackfn(key);
      this.set(key, value);
      return value;
    });
  }
  if (typeof Map !== "undefined") addUpsert(Map.prototype);
  if (typeof WeakMap !== "undefined") addUpsert(WeakMap.prototype);

  // ---------------------------------------------------- Math.sumPrecise
  define(Math, "sumPrecise", function sumPrecise(items) {
    if (items == null || typeof items[Symbol.iterator] !== "function") {
      throw new TypeError("Math.sumPrecise requires an iterable");
    }
    var sum = 0;
    var compensation = 0;
    var any = false;
    var nan = false;
    var posInf = false;
    var negInf = false;
    var allNegZero = true;
    for (var it = items[Symbol.iterator](), step = it.next(); !step.done; step = it.next()) {
      var x = step.value;
      if (typeof x !== "number") {
        if (typeof it.return === "function") it.return();
        throw new TypeError("Math.sumPrecise: value is not a number");
      }
      any = true;
      if (x !== x) {
        nan = true;
        continue;
      }
      if (x === Infinity) {
        posInf = true;
        continue;
      }
      if (x === -Infinity) {
        negInf = true;
        continue;
      }
      if (!(x === 0 && 1 / x < 0)) allNegZero = false;
      // Neumaier's improved Kahan summation.
      var t = sum + x;
      if (Math.abs(sum) >= Math.abs(x)) compensation += sum - t + x;
      else compensation += x - t + sum;
      sum = t;
    }
    if (nan || (posInf && negInf)) return NaN;
    if (posInf) return Infinity;
    if (negInf) return -Infinity;
    if (!any || allNegZero) return -0;
    var result = sum + compensation;
    return result === 0 ? 0 : result;
  });

  // ------------------------------------------------------------ Promise
  if (typeof Promise !== "undefined") {
    define(Promise, "withResolvers", function withResolvers() {
      var resolve;
      var reject;
      var promise = new this(function (res, rej) {
        resolve = res;
        reject = rej;
      });
      return { promise: promise, resolve: resolve, reject: reject };
    });
    define(Promise, "try", function (callback) {
      var args = Array.prototype.slice.call(arguments, 1);
      var C = this;
      return new C(function (resolve) {
        resolve(callback.apply(undefined, args));
      });
    });
  }

  // ---------------------------------------------------------------- URL
  if (typeof URL !== "undefined") {
    define(URL, "parse", function parse(url, base) {
      try {
        return base === undefined ? new URL(url) : new URL(url, base);
      } catch (e) {
        return null;
      }
    });
    define(URL, "canParse", function canParse(url, base) {
      try {
        if (base === undefined) new URL(url);
        else new URL(url, base);
        return true;
      } catch (e) {
        return false;
      }
    });
  }

  // ------------------------------------------------- Set methods (ES2025)
  if (typeof Set !== "undefined") {
    var toSetLike = function (other) {
      if (other == null || typeof other.has !== "function" || typeof other.keys !== "function") {
        throw new TypeError("Argument is not set-like");
      }
      return other;
    };
    var keysOf = function (other) {
      var out = [];
      for (var it = other.keys(), s = it.next(); !s.done; s = it.next()) out.push(s.value);
      return out;
    };
    define(Set.prototype, "intersection", function intersection(other) {
      toSetLike(other);
      var result = new Set();
      this.forEach(function (v) {
        if (other.has(v)) result.add(v);
      });
      return result;
    });
    define(Set.prototype, "union", function union(other) {
      toSetLike(other);
      var result = new Set(this);
      keysOf(other).forEach(function (v) {
        result.add(v);
      });
      return result;
    });
    define(Set.prototype, "difference", function difference(other) {
      toSetLike(other);
      var result = new Set();
      this.forEach(function (v) {
        if (!other.has(v)) result.add(v);
      });
      return result;
    });
    define(Set.prototype, "symmetricDifference", function symmetricDifference(other) {
      toSetLike(other);
      var self = this;
      var result = new Set(this);
      keysOf(other).forEach(function (v) {
        if (self.has(v)) result.delete(v);
        else result.add(v);
      });
      return result;
    });
    define(Set.prototype, "isSubsetOf", function isSubsetOf(other) {
      toSetLike(other);
      var ok = true;
      this.forEach(function (v) {
        if (!other.has(v)) ok = false;
      });
      return ok;
    });
    define(Set.prototype, "isSupersetOf", function isSupersetOf(other) {
      toSetLike(other);
      var self = this;
      return keysOf(other).every(function (v) {
        return self.has(v);
      });
    });
    define(Set.prototype, "isDisjointFrom", function isDisjointFrom(other) {
      toSetLike(other);
      var ok = true;
      this.forEach(function (v) {
        if (other.has(v)) ok = false;
      });
      return ok;
    });
  }

  // ------------------------------------------------------ Array helpers
  define(Array.prototype, "findLast", function findLast(fn, thisArg) {
    for (var i = this.length - 1; i >= 0; i--) if (fn.call(thisArg, this[i], i, this)) return this[i];
    return undefined;
  });
  define(Array.prototype, "findLastIndex", function findLastIndex(fn, thisArg) {
    for (var i = this.length - 1; i >= 0; i--) if (fn.call(thisArg, this[i], i, this)) return i;
    return -1;
  });

  // --------------------------------- ArrayBuffer.prototype.transferToFixedLength
  if (typeof ArrayBuffer !== "undefined") {
    var transfer = function (newLength) {
      var length = newLength === undefined ? this.byteLength : Math.max(0, Math.floor(Number(newLength)) || 0);
      var copy = new ArrayBuffer(length);
      new Uint8Array(copy).set(new Uint8Array(this, 0, Math.min(length, this.byteLength)));
      return copy;
    };
    define(ArrayBuffer.prototype, "transferToFixedLength", transfer);
    define(ArrayBuffer.prototype, "transfer", transfer);
  }

  // --------------------------------------- Uint8Array base64 / hex (ES2026)
  if (typeof Uint8Array !== "undefined") {
    var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    var B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

    var decodeBase64 = function (input, options) {
      if (typeof input !== "string") throw new TypeError("Expected a string");
      var alphabet = options && options.alphabet === "base64url" ? "base64url" : "base64";
      var s = input.replace(/[\t\n\f\r ]+/g, "");
      if (alphabet === "base64url") {
        if (/[+/]/.test(s)) throw new SyntaxError("Invalid base64url string");
        s = s.replace(/-/g, "+").replace(/_/g, "/");
      } else if (/[-_]/.test(s)) {
        throw new SyntaxError("Invalid base64 string");
      }
      var pad = s.indexOf("=");
      var body = pad >= 0 ? s.slice(0, pad) : s;
      if (!/^[A-Za-z0-9+/]*$/.test(body) || (pad >= 0 && !/^={1,2}$/.test(s.slice(pad)))) {
        throw new SyntaxError("Invalid base64 string");
      }
      var lastChunk = options && options.lastChunkHandling;
      if (body.length % 4 === 1) throw new SyntaxError("Invalid base64 string");
      if (lastChunk === "strict" && s.length % 4 !== 0) throw new SyntaxError("Invalid base64 padding");
      if (lastChunk === "stop-before-partial" && pad < 0 && body.length % 4 !== 0) {
        body = body.slice(0, body.length - (body.length % 4));
      }
      var padded = body + "===".slice(0, (4 - (body.length % 4)) % 4);
      var binary = atob(padded);
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes;
    };

    define(Uint8Array, "fromBase64", function fromBase64(string, options) {
      return decodeBase64(string, options);
    });

    define(Uint8Array.prototype, "toBase64", function toBase64(options) {
      var table = options && options.alphabet === "base64url" ? B64URL : B64;
      var omitPadding = !!(options && options.omitPadding);
      var bytes = this;
      var out = "";
      var i = 0;
      for (; i + 2 < bytes.length; i += 3) {
        var n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
        out += table[(n >> 18) & 63] + table[(n >> 12) & 63] + table[(n >> 6) & 63] + table[n & 63];
      }
      var rest = bytes.length - i;
      if (rest === 1) {
        var a = bytes[i] << 16;
        out += table[(a >> 18) & 63] + table[(a >> 12) & 63] + (omitPadding ? "" : "==");
      } else if (rest === 2) {
        var b = (bytes[i] << 16) | (bytes[i + 1] << 8);
        out += table[(b >> 18) & 63] + table[(b >> 12) & 63] + table[(b >> 6) & 63] + (omitPadding ? "" : "=");
      }
      return out;
    });

    define(Uint8Array.prototype, "toHex", function toHex() {
      var out = "";
      for (var i = 0; i < this.length; i++) out += (this[i] < 16 ? "0" : "") + this[i].toString(16);
      return out;
    });

    define(Uint8Array, "fromHex", function fromHex(string) {
      if (typeof string !== "string") throw new TypeError("Expected a string");
      if (string.length % 2 !== 0 || /[^0-9a-fA-F]/.test(string)) throw new SyntaxError("Invalid hex string");
      var bytes = new Uint8Array(string.length / 2);
      for (var i = 0; i < bytes.length; i++) bytes[i] = parseInt(string.substr(i * 2, 2), 16);
      return bytes;
    });

    define(Uint8Array.prototype, "setFromBase64", function setFromBase64(string, options) {
      var bytes = decodeBase64(string, options);
      var written = Math.min(bytes.length, this.length);
      this.set(bytes.subarray(0, written));
      return { read: string.length, written: written };
    });

    define(Uint8Array.prototype, "setFromHex", function setFromHex(string) {
      var bytes = Uint8Array.fromHex(string);
      var written = Math.min(bytes.length, this.length);
      this.set(bytes.subarray(0, written));
      return { read: written * 2, written: written };
    });
  }

  // ------------------------------------------- Response / Blob .bytes()
  if (typeof Response !== "undefined") {
    define(Response.prototype, "bytes", function bytes() {
      return this.arrayBuffer().then(function (buffer) {
        return new Uint8Array(buffer);
      });
    });
  }
  if (typeof Blob !== "undefined") {
    define(Blob.prototype, "bytes", function bytes() {
      return this.arrayBuffer().then(function (buffer) {
        return new Uint8Array(buffer);
      });
    });
  }

  // -------------------------------------------------------- AbortSignal
  if (typeof AbortSignal !== "undefined" && typeof AbortController !== "undefined") {
    define(AbortSignal, "any", function any(signals) {
      var controller = new AbortController();
      var list = Array.prototype.slice.call(signals);
      for (var i = 0; i < list.length; i++) {
        if (list[i].aborted) {
          controller.abort(list[i].reason);
          return controller.signal;
        }
      }
      var onAbort = function (event) {
        list.forEach(function (s) {
          s.removeEventListener("abort", onAbort);
        });
        controller.abort(event.target.reason);
      };
      list.forEach(function (s) {
        s.addEventListener("abort", onAbort);
      });
      return controller.signal;
    });
    define(AbortSignal, "timeout", function timeout(ms) {
      var controller = new AbortController();
      setTimeout(function () {
        var reason;
        try {
          reason = new DOMException("The operation timed out.", "TimeoutError");
        } catch (e) {
          reason = new Error("TimeoutError");
        }
        controller.abort(reason);
      }, ms);
      return controller.signal;
    });
  }
})();
