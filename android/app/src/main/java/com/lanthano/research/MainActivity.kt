package com.lanthano.research

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.ServiceWorkerClient
import android.webkit.ServiceWorkerController
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : ComponentActivity() {

    companion object {
        private const val TAG = "LanthanoResearch"
        private val BACKGROUND = Color.rgb(0x11, 0x11, 0x11)

        /**
         * Oldest Android System WebView (Chromium major version) that can run the
         * bundled PDF.js; newer JavaScript built-ins are covered by polyfills.js.
         */
        private const val MIN_WEBVIEW_MAJOR = 100
        private const val PREF_WEBVIEW_WARNED = "webview_warned_version"
    }

    private lateinit var root: FrameLayout
    private lateinit var webView: WebView
    private lateinit var assetServer: LocalAssetServer
    private lateinit var bridge: AppBridge

    private var customView: View? = null
    private var customViewCallback: WebChromeClient.CustomViewCallback? = null
    private var destroyed = false
    private var rendererGone = false
    private val debuggable by lazy { (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0 }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
        )
        super.onCreate(savedInstanceState)
        if (debuggable) WebView.setWebContentsDebuggingEnabled(true)

        assetServer = LocalAssetServer(assets)
        bridge = AppBridge(this, assetServer) { script -> runJavaScript(script) }

        root = FrameLayout(this).apply { setBackgroundColor(BACKGROUND) }
        webView = WebView(this).apply { setBackgroundColor(BACKGROUND) }
        root.addView(webView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        setContentView(root)

        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            WindowInsetsCompat.CONSUMED
        }

        configureServiceWorkers()
        configureWebView()
        onBackPressedDispatcher.addCallback(this, backCallback)

        val restored = savedInstanceState != null && webView.restoreState(savedInstanceState) != null
        if (!restored) webView.loadUrl(LocalAssetServer.HOME_URL)
        if (savedInstanceState == null) warnIfWebViewTooOld()
    }

    /** Shows a one-time notice when the device's WebView is too old for the PDF viewer. */
    private fun warnIfWebViewTooOld() {
        val info = try {
            WebView.getCurrentWebViewPackage()
        } catch (e: Exception) {
            null
        } ?: return
        val version = info.versionName ?: return
        val major = version.substringBefore('.').toIntOrNull() ?: return
        if (major >= MIN_WEBVIEW_MAJOR) return
        val prefs = getPreferences(MODE_PRIVATE)
        if (prefs.getString(PREF_WEBVIEW_WARNED, null) == version) return
        prefs.edit().putString(PREF_WEBVIEW_WARNED, version).apply()
        Log.w(TAG, "Android System WebView $version is older than $MIN_WEBVIEW_MAJOR")
        AlertDialog.Builder(this)
            .setTitle(R.string.webview_outdated_title)
            .setMessage(getString(R.string.webview_outdated_message, version, MIN_WEBVIEW_MAJOR))
            .setPositiveButton(android.R.string.ok, null)
            .show()
    }

    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    private fun configureWebView() {
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            // Only the virtual https origin is used - no file:// or content:// access.
            allowFileAccess = false
            allowContentAccess = false
            // Belt and braces: no network loads at all (the app has no INTERNET permission).
            blockNetworkLoads = true
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            safeBrowsingEnabled = false
            setGeolocationEnabled(false)
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
            mediaPlaybackRequiresUserGesture = false
            useWideViewPort = true
            loadWithOverviewMode = false
            setSupportZoom(true)
            builtInZoomControls = false
            displayZoomControls = false
            textZoom = 100
        }

        webView.addJavascriptInterface(bridge, AppBridge.JS_NAME)

        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                assetServer.intercept(request)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                handleNavigation(request.url, request.isForMainFrame)

            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                bridge.onPageStarted(url)
            }

            override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
                bridge.trusted = LocalAssetServer.isLocal(url)
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                Log.w(TAG, "WebView renderer gone (crashed=${detail.didCrash()}); restarting")
                rendererGone = true
                root.removeView(view)
                view.destroy()
                recreate()
                return true
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowCustomView(view: View, callback: WebChromeClient.CustomViewCallback) {
                showCustomView(view, callback)
            }

            override fun onHideCustomView() {
                hideCustomView()
            }

            override fun onPermissionRequest(request: PermissionRequest) {
                request.deny() // no camera / microphone / MIDI access
            }

            override fun onGeolocationPermissionsShowPrompt(origin: String?, callback: GeolocationPermissions.Callback?) {
                callback?.invoke(origin, false, false)
            }

            override fun getDefaultVideoPoster(): Bitmap =
                Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888) // transparent, instead of the grey placeholder

            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                if (debuggable) {
                    Log.d(TAG, "${message.messageLevel()} ${message.sourceId()}:${message.lineNumber()} ${message.message()}")
                }
                return true
            }
        }

        webView.setDownloadListener { url, _, contentDisposition, mimeType, _ ->
            bridge.onNativeDownload(url, contentDisposition, mimeType)
        }
    }

    /**
     * The site never registers a service worker inside the app (the shim skips
     * it), but if one ever runs, its requests are answered from the APK as well.
     */
    private fun configureServiceWorkers() {
        try {
            val controller = ServiceWorkerController.getInstance()
            controller.serviceWorkerWebSettings.apply {
                allowContentAccess = false
                allowFileAccess = false
                blockNetworkLoads = true
            }
            controller.setServiceWorkerClient(object : ServiceWorkerClient() {
                override fun shouldInterceptRequest(request: WebResourceRequest): WebResourceResponse? =
                    assetServer.intercept(request)
            })
        } catch (e: Exception) {
            Log.w(TAG, "Service worker configuration unavailable", e)
        }
    }

    /** Returns true when the WebView must NOT load [uri] itself. */
    private fun handleNavigation(uri: Uri, isMainFrame: Boolean): Boolean {
        if (LocalAssetServer.isLocal(uri)) {
            val path = LocalAssetServer.decodePath(uri.encodedPath)
            if (isMainFrame && path.endsWith(".pdf", ignoreCase = true)) {
                // A direct link to a PDF opens in the app's own PDF.js viewer.
                webView.loadUrl(LocalAssetServer.pdfViewerUrlFor(path))
                return true
            }
            return false
        }
        return when (uri.scheme?.lowercase()) {
            "about", "blob", "data" -> false
            "intent" -> true // never launch arbitrary intents from web content
            else -> {
                // External links (http/https/mailto/...) are opened in another app
                // only when the user follows them; the app itself never needs them.
                if (isMainFrame) bridge.openExternalUri(uri)
                true
            }
        }
    }

    private fun showCustomView(view: View, callback: WebChromeClient.CustomViewCallback) {
        if (customView != null) {
            callback.onCustomViewHidden()
            return
        }
        customView = view
        customViewCallback = callback
        root.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        webView.visibility = View.GONE
        WindowCompat.getInsetsController(window, window.decorView).apply {
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            hide(WindowInsetsCompat.Type.systemBars())
        }
    }

    private fun hideCustomView() {
        val view = customView ?: return
        customView = null
        root.removeView(view)
        webView.visibility = View.VISIBLE
        WindowCompat.getInsetsController(window, window.decorView).show(WindowInsetsCompat.Type.systemBars())
        val callback = customViewCallback
        customViewCallback = null
        callback?.onCustomViewHidden()
    }

    private val backCallback = object : OnBackPressedCallback(true) {
        private var pending = false

        override fun handleOnBackPressed() {
            if (customView != null) {
                hideCustomView()
                return
            }
            if (pending) return
            pending = true
            var settled = false
            val fallback = Runnable {
                if (!settled) {
                    settled = true
                    pending = false
                    navigateBackOrExit()
                }
            }
            // Let the page close its own overlay (media viewer / fullscreen) first.
            webView.evaluateJavascript(
                "(function(){try{return !!(window.__lanthanoApp&&window.__lanthanoApp.handleBack())}catch(e){return false}})()"
            ) { result ->
                if (settled) return@evaluateJavascript
                settled = true
                pending = false
                webView.removeCallbacks(fallback)
                if (result != "true") navigateBackOrExit()
            }
            webView.postDelayed(fallback, 500)
        }
    }

    private fun navigateBackOrExit() {
        if (destroyed) return
        if (webView.canGoBack()) webView.goBack() else finish()
    }

    private fun runJavaScript(script: String) {
        runOnUiThread {
            if (!destroyed && !rendererGone) webView.evaluateJavascript(script, null)
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        if (!rendererGone) webView.saveState(outState)
    }

    override fun onResume() {
        super.onResume()
        if (!rendererGone) webView.onResume()
    }

    override fun onPause() {
        if (!rendererGone) webView.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        destroyed = true
        bridge.shutdown()
        if (!rendererGone) {
            (webView.parent as? ViewGroup)?.removeView(webView)
            webView.destroy()
        }
        super.onDestroy()
    }
}
