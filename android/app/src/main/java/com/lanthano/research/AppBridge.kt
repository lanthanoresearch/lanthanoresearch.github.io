package com.lanthano.research

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.DocumentsContract
import android.util.Base64
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.URLUtil
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContract
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.BufferedOutputStream
import java.io.File
import java.io.OutputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/**
 * Native helpers exposed to the bundled site as `window.LanthanoAndroid`.
 * Used only by assets/lanthano-app/android-shim.js.
 *
 * Every method first checks that the page currently shown is the app's own
 * local origin, so nothing else could ever call into it.
 */
class AppBridge(
    private val activity: ComponentActivity,
    private val assetServer: LocalAssetServer,
    private val runJs: (String) -> Unit,
) {
    companion object {
        const val JS_NAME = "LanthanoAndroid"
        private val EXTERNAL_SCHEMES = setOf("http", "https", "mailto", "tel", "sms", "geo", "market")
    }

    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private val speech = SpeechBridge(activity.applicationContext, runJs)

    /** True while the WebView shows a page of the local origin. Updated on the UI thread. */
    @Volatile var trusted = false

    // ---- Saving files through the system "Save as" picker -----------------

    private data class SaveRequest(val id: String, val fileName: String, val mime: String, val assetPath: String?)

    private class OpenSave(val stream: OutputStream, val uri: Uri, val fileName: String)

    private val saveQueue = ArrayDeque<SaveRequest>() // UI thread only
    private var saveInFlight: SaveRequest? = null // UI thread only
    private val openSaves = ConcurrentHashMap<String, OpenSave>()

    private val createDocument: ActivityResultLauncher<Pair<String, String>> =
        activity.registerForActivityResult(CreateDocument()) { uri -> onDestinationChosen(uri) }

    private class CreateDocument : ActivityResultContract<Pair<String, String>, Uri?>() {
        override fun createIntent(context: Context, input: Pair<String, String>): Intent =
            Intent(Intent.ACTION_CREATE_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .setType(input.second)
                .putExtra(Intent.EXTRA_TITLE, input.first)

        override fun parseResult(resultCode: Int, intent: Intent?): Uri? =
            if (resultCode == Activity.RESULT_OK) intent?.data else null
    }

    /** Starts saving a file whose bytes the page will stream with [writeSaveChunk]. */
    @JavascriptInterface
    fun beginSave(id: String, fileName: String, mime: String) {
        if (!trusted) return
        enqueueSave(SaveRequest(id, cleanFileName(fileName), cleanMime(mime), null))
    }

    /** Saves one of the bundled files (e.g. a research PDF) by copying it from the APK. [urlPath] is %-encoded. */
    @JavascriptInterface
    fun saveAsset(id: String, urlPath: String, fileName: String, mime: String) {
        if (!trusted) return
        val assetPath = assetServer.resolveWebAssetPath(urlPath)
        if (assetPath == null) {
            toast("This file isn't available.")
            return
        }
        enqueueSave(SaveRequest(id, cleanFileName(fileName), cleanMime(mime), assetPath))
    }

    @JavascriptInterface
    fun writeSaveChunk(id: String, base64: String): Boolean {
        val save = openSaves[id] ?: return false
        return try {
            save.stream.write(Base64.decode(base64, Base64.DEFAULT))
            true
        } catch (e: Exception) {
            false
        }
    }

    @JavascriptInterface
    fun finishSave(id: String, success: Boolean) {
        val save = openSaves.remove(id) ?: return
        val closed = try {
            save.stream.close()
            true
        } catch (e: Exception) {
            false
        }
        if (success && closed) {
            toast("Saved \u201c${save.fileName}\u201d")
        } else {
            deleteQuietly(save.uri)
            toast("Couldn't save \u201c${save.fileName}\u201d")
        }
    }

    private fun enqueueSave(request: SaveRequest) {
        main.post {
            saveQueue.addLast(request)
            launchNextSave()
        }
    }

    private fun launchNextSave() {
        if (saveInFlight != null) return
        val next = saveQueue.removeFirstOrNull() ?: return
        saveInFlight = next
        try {
            createDocument.launch(next.fileName to next.mime)
        } catch (e: ActivityNotFoundException) {
            saveInFlight = null
            toast("No app is available to save files.")
            notifySaveReady(next, false)
            launchNextSave()
        }
    }

    private fun onDestinationChosen(uri: Uri?) {
        val request = saveInFlight ?: return
        saveInFlight = null
        when {
            uri == null -> notifySaveReady(request, false)
            request.assetPath != null -> copyAsset(request.assetPath, uri, request.fileName)
            else -> {
                val stream = try {
                    activity.contentResolver.openOutputStream(uri, "w")
                } catch (e: Exception) {
                    null
                }
                if (stream == null) {
                    deleteQuietly(uri)
                    toast("Couldn't save \u201c${request.fileName}\u201d")
                    notifySaveReady(request, false)
                } else {
                    openSaves[request.id] = OpenSave(BufferedOutputStream(stream, 256 * 1024), uri, request.fileName)
                    notifySaveReady(request, true)
                }
            }
        }
        launchNextSave()
    }

    private fun notifySaveReady(request: SaveRequest, ok: Boolean) {
        if (request.assetPath != null) return
        runJs(
            "window.__lanthanoApp&&window.__lanthanoApp._saveReady(" +
                JSONObject.quote(request.id) + "," + ok + ")",
        )
    }

    private fun copyAsset(assetPath: String, uri: Uri, fileName: String) {
        io.execute {
            val ok = try {
                assetServer.openAsset(assetPath).use { input ->
                    val output = activity.contentResolver.openOutputStream(uri, "w")
                        ?: throw java.io.IOException("No output stream")
                    output.use { input.copyTo(it, 256 * 1024) }
                }
                true
            } catch (e: Exception) {
                false
            }
            if (ok) {
                toast("Saved \u201c$fileName\u201d")
            } else {
                deleteQuietly(uri)
                toast("Couldn't save \u201c$fileName\u201d")
            }
        }
    }

    private fun deleteQuietly(uri: Uri) {
        try {
            DocumentsContract.deleteDocument(activity.contentResolver, uri)
        } catch (e: Exception) {
            // ignore
        }
    }

    /** Called from WebView's DownloadListener for downloads not caught by the shim. */
    fun onNativeDownload(url: String, contentDisposition: String?, mimeType: String?) {
        val uri = Uri.parse(url)
        val name = URLUtil.guessFileName(url, contentDisposition, mimeType)
        when {
            url.startsWith("blob:") || url.startsWith("data:") -> runJs(
                "window.__lanthanoApp&&window.__lanthanoApp._nativeDownload(" +
                    JSONObject.quote(url) + "," + JSONObject.quote(name) + ")",
            )
            LocalAssetServer.isLocal(uri) -> {
                val assetPath = assetServer.resolveWebAssetPath(uri.encodedPath ?: "")
                if (assetPath == null) {
                    toast("This file isn't available.")
                } else {
                    val fileName = cleanFileName(assetPath.substringAfterLast('/'))
                    enqueueSave(SaveRequest("native", fileName, LocalAssetServer.mimeTypeFor(assetPath), assetPath))
                }
            }
            else -> openExternalUri(uri)
        }
    }

    // ---- Links, files and sharing ------------------------------------------

    /** Opens a link the user tapped in another app (browser, mail, ...). */
    @JavascriptInterface
    fun openExternal(url: String) {
        if (!trusted) return
        main.post { openExternalUri(Uri.parse(url)) }
    }

    fun openExternalUri(uri: Uri) {
        val scheme = uri.scheme?.lowercase() ?: return
        if (scheme !in EXTERNAL_SCHEMES) return
        val intent = if (scheme == "mailto") {
            Intent(Intent.ACTION_SENDTO, uri)
        } else {
            Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)
        }
        try {
            activity.startActivity(intent)
        } catch (e: ActivityNotFoundException) {
            toast("No app is available to open this link.")
        } catch (e: SecurityException) {
            toast("No app is available to open this link.")
        }
    }

    /** Hands a bundled file (e.g. a PDF) to another app via "Open with". [urlPath] is %-encoded. */
    @JavascriptInterface
    fun openAssetExternally(urlPath: String, mime: String) {
        if (!trusted) return
        val assetPath = assetServer.resolveWebAssetPath(urlPath)
        if (assetPath == null) {
            toast("This file isn't available.")
            return
        }
        io.execute {
            val file = try {
                val dir = File(activity.cacheDir, "shared").apply { mkdirs() }
                val target = File(dir, cleanFileName(assetPath.substringAfterLast('/')))
                if (!target.exists()) {
                    val temp = File(dir, target.name + ".part")
                    assetServer.openAsset(assetPath).use { input ->
                        temp.outputStream().use { input.copyTo(it, 256 * 1024) }
                    }
                    if (!temp.renameTo(target)) throw java.io.IOException("rename failed")
                }
                target
            } catch (e: Exception) {
                null
            }
            main.post {
                if (file == null) {
                    toast("Couldn't open this file.")
                    return@post
                }
                val contentUri = FileProvider.getUriForFile(activity, activity.packageName + ".files", file)
                val view = Intent(Intent.ACTION_VIEW)
                    .setDataAndType(contentUri, cleanMime(mime))
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                try {
                    activity.startActivity(Intent.createChooser(view, "Open with"))
                } catch (e: ActivityNotFoundException) {
                    toast("No app is available to open this file.")
                }
            }
        }
    }

    @JavascriptInterface
    fun share(title: String, text: String, url: String) {
        if (!trusted) return
        val body = listOf(text, url).filter { it.isNotBlank() }.joinToString("\n").ifBlank { title }
        val send = Intent(Intent.ACTION_SEND)
            .setType("text/plain")
            .putExtra(Intent.EXTRA_TEXT, body)
        if (title.isNotBlank()) send.putExtra(Intent.EXTRA_SUBJECT, title)
        main.post {
            try {
                activity.startActivity(Intent.createChooser(send, title.ifBlank { null }))
            } catch (e: ActivityNotFoundException) {
                toast("No app is available to share with.")
            }
        }
    }

    @JavascriptInterface
    fun copyText(text: String) {
        if (!trusted) return
        main.post {
            val clipboard = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            clipboard.setPrimaryClip(ClipData.newPlainText("Lanthano Research", text))
            // Android 13+ shows its own confirmation.
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) toast("Copied")
        }
    }

    @JavascriptInterface
    fun toast(message: String) {
        main.post { Toast.makeText(activity, message, Toast.LENGTH_SHORT).show() }
    }

    // ---- Screen wake lock (navigator.wakeLock, used by Read Aloud) ---------

    @JavascriptInterface
    fun setKeepScreenOn(on: Boolean) {
        if (on && !trusted) return
        main.post { applyKeepScreenOn(on) }
    }

    /** UI thread only. */
    private fun applyKeepScreenOn(on: Boolean) {
        if (on) {
            activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } else {
            activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    // ---- Text to speech ----------------------------------------------------

    @JavascriptInterface
    fun ttsWarmUp() {
        if (trusted) speech.warmUp()
    }

    @JavascriptInterface
    fun ttsReady(): Boolean = speech.isReady

    @JavascriptInterface
    fun ttsFailed(): Boolean = speech.hasFailed

    @JavascriptInterface
    fun ttsVoices(): String = if (trusted) speech.voicesJson else "[]"

    @JavascriptInterface
    fun ttsStart(
        token: String,
        text: String,
        voiceUri: String,
        lang: String,
        rate: Double,
        pitch: Double,
        volume: Double,
    ): Boolean {
        if (!trusted) return false
        return speech.start(token, text, voiceUri, lang, rate, pitch, volume)
    }

    @JavascriptInterface
    fun ttsStop() {
        speech.stop()
    }

    // ---- Lifecycle ---------------------------------------------------------

    /** UI thread: a new page started loading. */
    fun onPageStarted(url: String?) {
        trusted = LocalAssetServer.isLocal(url)
        speech.stop() // like a browser, leaving the page stops Read Aloud
        applyKeepScreenOn(false) // and releases its wake lock
    }

    fun shutdown() {
        speech.shutdown()
        openSaves.values.forEach {
            try {
                it.stream.close()
            } catch (e: Exception) {
                // ignore
            }
        }
        openSaves.clear()
        io.shutdown()
    }

    private fun cleanFileName(name: String): String {
        val cleaned = name.replace(Regex("[\\\\/:*?\"<>|\\u0000-\\u001f]+"), "_").trim()
        return cleaned.ifEmpty { "download" }.take(150)
    }

    private fun cleanMime(mime: String): String =
        if (Regex("^[a-zA-Z0-9.+-]+/[a-zA-Z0-9.+-]+$").matches(mime)) mime else "application/octet-stream"
}
