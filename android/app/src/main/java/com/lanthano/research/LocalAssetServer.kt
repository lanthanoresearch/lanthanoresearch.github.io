package com.lanthano.research

import android.content.res.AssetManager
import android.net.Uri
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.FilterInputStream
import java.io.IOException
import java.io.InputStream
import java.util.concurrent.ConcurrentHashMap

/**
 * Serves the bundled Lanthano Research site to the WebView.
 *
 * Pages are loaded from https://appassets.androidplatform.net/ - a reserved
 * host that never resolves on the real network (the same one androidx.webkit's
 * WebViewAssetLoader uses). Every request for it is answered here, straight from
 * the APK's assets/www folder, so the site gets a normal secure https origin
 * (ES modules, fetch(), module workers and localStorage all behave as they do on
 * the web) without any server or network connection.
 *
 * Anything else is refused: the app has no INTERNET permission and WebView's
 * network loads are blocked, and this class answers remote requests with an
 * explicit "blocked" response. The one exception is the small set of library
 * files the site used to pull from a CDN, which are served from copies bundled
 * in assets/lanthano-app/vendor.
 */
class LocalAssetServer(private val assets: AssetManager) {

    companion object {
        const val HOST = "appassets.androidplatform.net"
        const val ORIGIN = "https://$HOST"
        const val HOME_URL = "$ORIGIN/index.html"

        private const val WEB_DIR = "www"
        private const val APP_DIR = "lanthano-app"
        private const val APP_PATH_PREFIX = "/__lanthano__/"
        private const val POLYFILLS_ASSET = "$APP_DIR/polyfills.js"

        /**
         * Injected as the first element of <head> in every bundled page: the
         * JavaScript polyfills first (see polyfills.js), then the Android shim.
         * Both are classic scripts, so they run before any module script.
         */
        private const val SHIM_TAG =
            "<script src=\"/__lanthano__/polyfills.js\"></script>" +
                "<script src=\"/__lanthano__/android-shim.js\"></script>"

        /** Remote library URLs referenced by the site -> bundled offline copies. */
        private val VENDORED = mapOf(
            "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js" to "$APP_DIR/vendor/jszip.min.js",
        )

        private val MEDIA_EXTENSIONS = setOf(
            "mp4", "m4v", "webm", "mov", "mp3", "m4a", "aac", "ogg", "oga", "wav", "flac",
        )

        private val MIME_TYPES = mapOf(
            "html" to "text/html", "htm" to "text/html",
            "js" to "text/javascript", "mjs" to "text/javascript", "cjs" to "text/javascript",
            "css" to "text/css",
            "json" to "application/json", "webmanifest" to "application/manifest+json",
            "txt" to "text/plain", "md" to "text/plain", "xml" to "application/xml",
            "png" to "image/png", "jpg" to "image/jpeg", "jpeg" to "image/jpeg",
            "gif" to "image/gif", "webp" to "image/webp", "avif" to "image/avif",
            "svg" to "image/svg+xml", "ico" to "image/x-icon", "bmp" to "image/bmp",
            "pdf" to "application/pdf",
            "mp3" to "audio/mpeg", "m4a" to "audio/mp4", "aac" to "audio/aac",
            "ogg" to "audio/ogg", "oga" to "audio/ogg", "wav" to "audio/wav", "flac" to "audio/flac",
            "mp4" to "video/mp4", "m4v" to "video/mp4", "webm" to "video/webm", "mov" to "video/quicktime",
            "wasm" to "application/wasm",
            "woff" to "font/woff", "woff2" to "font/woff2", "ttf" to "font/ttf", "otf" to "font/otf",
            "zip" to "application/zip",
        )

        fun isLocal(uri: Uri?): Boolean =
            uri != null &&
                "https".equals(uri.scheme, ignoreCase = true) &&
                HOST.equals(uri.host, ignoreCase = true)

        fun isLocal(url: String?): Boolean = url != null && isLocal(Uri.parse(url))

        /** In-app PDF viewer URL for a bundled PDF path such as "/Artemis.pdf". */
        fun pdfViewerUrlFor(pdfPath: String): String =
            "$ORIGIN/pdf.html?file=" + Uri.encode(pdfPath.trimStart('/'))

        fun mimeTypeFor(path: String): String =
            MIME_TYPES[path.substringAfterLast('.', "").lowercase()] ?: "application/octet-stream"

        /**
         * Decodes a raw (%-encoded) URL path the way a web server does. Unlike
         * Uri.getPath(), an invalid escape such as the "%" in "/33%%20Desert.png"
         * is kept literally instead of being turned into U+FFFD.
         */
        fun decodePath(encodedPath: String?): String {
            val raw = if (encodedPath.isNullOrEmpty()) "/" else encodedPath
            if (raw.indexOf('%') < 0) return raw
            val out = ByteArrayOutputStream(raw.length)
            var i = 0
            while (i < raw.length) {
                val c = raw[i]
                if (c == '%' && i + 2 < raw.length) {
                    val hi = Character.digit(raw[i + 1], 16)
                    val lo = Character.digit(raw[i + 2], 16)
                    if (hi >= 0 && lo >= 0) {
                        out.write(hi * 16 + lo)
                        i += 3
                        continue
                    }
                }
                val codePoint = raw.codePointAt(i)
                val bytes = String(Character.toChars(codePoint)).toByteArray(Charsets.UTF_8)
                out.write(bytes, 0, bytes.size)
                i += Character.charCount(codePoint)
            }
            return String(out.toByteArray(), Charsets.UTF_8)
        }
    }

    private val dirListings = ConcurrentHashMap<String, Set<String>>()

    /** polyfills.js followed by a newline, prepended to worker scripts. */
    private val workerPrelude: ByteArray by lazy {
        try {
            assets.open(POLYFILLS_ASSET).use { it.readBytes() } + "\n".toByteArray(Charsets.UTF_8)
        } catch (e: IOException) {
            ByteArray(0)
        }
    }

    /** Entry point from WebViewClient / ServiceWorkerClient. Never returns null for http(s). */
    fun intercept(request: WebResourceRequest): WebResourceResponse? {
        val uri = request.url
        VENDORED[uri.toString()]?.let { vendored ->
            return serve(vendored, request, webAsset = false) ?: notFound(request)
        }

        val scheme = uri.scheme?.lowercase()
        if (scheme != "http" && scheme != "https") return null // blob:, data: etc. stay in WebView
        if (!isLocal(uri)) return blocked()

        val method = request.method?.uppercase() ?: "GET"
        if (method != "GET" && method != "HEAD") return blocked(405, "Method Not Allowed")

        val assetPath = resolveAssetPath(decodePath(uri.encodedPath)) ?: return notFound(request)
        return serve(assetPath, request, webAsset = assetPath.startsWith("$WEB_DIR/"))
            ?: notFound(request)
    }

    /** Maps a raw (%-encoded) URL path of the local origin to a web asset path, or null. */
    fun resolveWebAssetPath(encodedUrlPath: String): String? =
        resolveAssetPath(decodePath(encodedUrlPath))?.takeIf { it.startsWith("$WEB_DIR/") }

    fun openAsset(assetPath: String): InputStream = assets.open(assetPath, AssetManager.ACCESS_STREAMING)

    private fun resolveAssetPath(urlPath: String): String? {
        if (urlPath.startsWith(APP_PATH_PREFIX)) {
            return normalize(APP_DIR, urlPath.removePrefix(APP_PATH_PREFIX))?.takeIf { exists(it) }
        }
        var rel = urlPath.trimStart('/')
        if (rel.isEmpty() || rel.endsWith("/")) rel += "index.html"

        normalize(WEB_DIR, rel)?.let { if (exists(it)) return it }

        // GitHub Pages style "pretty" URLs: /about -> about.html, /dir -> dir/index.html
        if (!rel.substringAfterLast('/').contains('.')) {
            normalize(WEB_DIR, "$rel.html")?.let { if (exists(it)) return it }
            normalize(WEB_DIR, "$rel/index.html")?.let { if (exists(it)) return it }
        }
        return null
    }

    /** Joins [rel] onto [base], refusing anything that could escape the folder. */
    private fun normalize(base: String, rel: String): String? {
        val parts = ArrayList<String>()
        for (segment in rel.split('/')) {
            when {
                segment.isEmpty() || segment == "." -> Unit
                segment == ".." -> return null
                segment.contains('\u0000') || segment.contains('\\') -> return null
                else -> parts += segment
            }
        }
        if (parts.isEmpty()) return null
        return base + "/" + parts.joinToString("/")
    }

    private fun exists(assetPath: String): Boolean {
        val dir = assetPath.substringBeforeLast('/', "")
        val name = assetPath.substringAfterLast('/')
        val listing = dirListings.getOrPut(dir) {
            try {
                assets.list(dir)?.toHashSet() ?: emptySet()
            } catch (e: IOException) {
                emptySet()
            }
        }
        return name in listing
    }

    private fun serve(assetPath: String, request: WebResourceRequest, webAsset: Boolean): WebResourceResponse? {
        if (!exists(assetPath)) return null
        val extension = assetPath.substringAfterLast('.', "").lowercase()
        val mime = mimeTypeFor(assetPath)
        val headers = baseHeaders()
        return try {
            when {
                mime == "text/html" -> {
                    var bytes = assets.open(assetPath).use { it.readBytes() }
                    if (webAsset) bytes = injectShimTag(bytes)
                    response(mime, 200, "OK", headers, ByteArrayInputStream(bytes))
                }
                extension in MEDIA_EXTENSIONS -> serveMedia(assetPath, mime, request, headers)
                webAsset && isWorkerScript(assetPath) -> {
                    // Web workers (the PDF.js worker) do not see the page's
                    // <script> tags, so they get the polyfills prepended.
                    val bytes = assets.open(assetPath).use { it.readBytes() }
                    response(mime, 200, "OK", headers, ByteArrayInputStream(workerPrelude + bytes))
                }
                else -> response(mime, 200, "OK", headers, openAsset(assetPath))
            }
        } catch (e: IOException) {
            null
        }
    }

    /** Audio/video with HTTP Range support, so seeking works in <video>/<audio>. */
    private fun serveMedia(
        assetPath: String,
        mime: String,
        request: WebResourceRequest,
        headers: MutableMap<String, String>,
    ): WebResourceResponse {
        val fd = try {
            assets.openFd(assetPath) // only works for uncompressed assets (see noCompress)
        } catch (e: IOException) {
            null
        }
        if (fd == null || fd.length < 0) {
            fd?.close()
            return response(mime, 200, "OK", headers, openAsset(assetPath))
        }

        val total = fd.length
        headers["Accept-Ranges"] = "bytes"
        val rangeHeader = request.requestHeaders.entries
            .firstOrNull { it.key.equals("Range", ignoreCase = true) }?.value
        val range = parseRange(rangeHeader, total)
        val input = fd.createInputStream()

        if (range == null) {
            headers["Content-Length"] = total.toString()
            return response(mime, 200, "OK", headers, BoundedInputStream(input, total))
        }
        if (range.first > range.last) {
            input.close()
            headers["Content-Range"] = "bytes */$total"
            return response(mime, 416, "Range Not Satisfiable", headers, ByteArrayInputStream(ByteArray(0)))
        }
        skipFully(input, range.first)
        val length = range.last - range.first + 1
        headers["Content-Range"] = "bytes ${range.first}-${range.last}/$total"
        headers["Content-Length"] = length.toString()
        return response(mime, 206, "Partial Content", headers, BoundedInputStream(input, length))
    }

    /**
     * Parses a single "bytes=" range. Returns null when there is no usable Range
     * header (serve the whole file) and an empty range (first > last) when the
     * range cannot be satisfied.
     */
    private fun parseRange(header: String?, total: Long): LongRange? {
        if (header.isNullOrBlank()) return null
        val spec = header.trim()
        if (!spec.startsWith("bytes=", ignoreCase = true)) return null
        val first = spec.substring(6).split(',').first().trim()
        val dash = first.indexOf('-')
        if (dash < 0) return null
        val startText = first.substring(0, dash).trim()
        val endText = first.substring(dash + 1).trim()
        val unsatisfiable = LongRange(1, 0)
        if (total <= 0) return unsatisfiable
        return if (startText.isEmpty()) {
            val suffix = endText.toLongOrNull() ?: return null
            if (suffix <= 0) unsatisfiable else LongRange(maxOf(0L, total - suffix), total - 1)
        } else {
            val start = startText.toLongOrNull() ?: return null
            val end = if (endText.isEmpty()) total - 1 else (endText.toLongOrNull() ?: return null)
            if (start >= total || end < start) unsatisfiable else LongRange(start, minOf(end, total - 1))
        }
    }

    private fun skipFully(input: InputStream, count: Long) {
        var remaining = count
        while (remaining > 0) {
            val skipped = input.skip(remaining)
            if (skipped <= 0) {
                if (input.read() < 0) throw IOException("Unexpected end of asset")
                remaining -= 1
            } else {
                remaining -= skipped
            }
        }
    }

    private fun isWorkerScript(assetPath: String): Boolean {
        val name = assetPath.substringAfterLast('/').lowercase()
        return (name.endsWith(".mjs") || name.endsWith(".js")) && name.contains("worker")
    }

    /** Inserts the polyfills and the app shim as the very first elements of <head>. */
    private fun injectShimTag(html: ByteArray): ByteArray {
        val tag = SHIM_TAG.toByteArray(Charsets.UTF_8)
        val insertAt = findTagEnd(html, "head") ?: findTagEnd(html, "html") ?: 0
        val out = ByteArray(html.size + tag.size)
        System.arraycopy(html, 0, out, 0, insertAt)
        System.arraycopy(tag, 0, out, insertAt, tag.size)
        System.arraycopy(html, insertAt, out, insertAt + tag.size, html.size - insertAt)
        return out
    }

    /** Index just after the '>' of the first <name ...> start tag (ASCII, case-insensitive). */
    private fun findTagEnd(html: ByteArray, name: String): Int? {
        val needle = "<$name".toByteArray(Charsets.US_ASCII)
        var i = 0
        while (i <= html.size - needle.size - 1) {
            var match = true
            for (j in needle.indices) {
                val b = html[i + j].toInt() and 0xFF
                val lower = if (b in 'A'.code..'Z'.code) b + 32 else b
                if (lower != needle[j].toInt()) {
                    match = false
                    break
                }
            }
            if (match) {
                val next = html[i + needle.size].toInt().toChar()
                if (next == '>' || next.isWhitespace() || next == '/') {
                    var k = i + needle.size
                    while (k < html.size && html[k] != '>'.code.toByte()) k++
                    if (k < html.size) return k + 1
                    return null
                }
            }
            i++
        }
        return null
    }

    private fun baseHeaders(): MutableMap<String, String> = mutableMapOf(
        "Cache-Control" to "no-cache",
        "X-Content-Type-Options" to "nosniff",
    )

    private fun response(
        mime: String,
        status: Int,
        reason: String,
        headers: Map<String, String>,
        body: InputStream,
    ): WebResourceResponse {
        val textual = mime.startsWith("text/") || mime == "application/json" ||
            mime == "application/manifest+json" || mime == "image/svg+xml" || mime == "application/xml"
        return WebResourceResponse(mime, if (textual) "utf-8" else null, status, reason, headers, body)
    }

    private fun notFound(request: WebResourceRequest): WebResourceResponse {
        if (request.isForMainFrame) {
            val page = "$WEB_DIR/404.html"
            if (exists(page)) {
                try {
                    val bytes = injectShimTag(assets.open(page).use { it.readBytes() })
                    return response("text/html", 404, "Not Found", baseHeaders(), ByteArrayInputStream(bytes))
                } catch (e: IOException) {
                    // fall through to the plain response
                }
            }
        }
        return response("text/plain", 404, "Not Found", baseHeaders(), ByteArrayInputStream(ByteArray(0)))
    }

    private fun blocked(status: Int = 403, reason: String = "Blocked - offline app"): WebResourceResponse =
        response(
            "text/plain", status, reason,
            mapOf("Cache-Control" to "no-store"),
            ByteArrayInputStream(ByteArray(0)),
        )

    /** Limits an InputStream to [limit] bytes. */
    private class BoundedInputStream(input: InputStream, private var remaining: Long) : FilterInputStream(input) {
        override fun read(): Int {
            if (remaining <= 0) return -1
            val b = super.read()
            if (b >= 0) remaining--
            return b
        }

        override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
            if (remaining <= 0) return -1
            val n = super.read(buffer, offset, minOf(length.toLong(), remaining).toInt())
            if (n > 0) remaining -= n
            return n
        }

        override fun skip(n: Long): Long {
            val skipped = super.skip(minOf(n, remaining))
            if (skipped > 0) remaining -= skipped
            return skipped
        }

        override fun available(): Int = minOf(super.available().toLong(), remaining).toInt()

        override fun markSupported(): Boolean = false
    }
}
