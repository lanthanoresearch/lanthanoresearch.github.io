# Keep the methods called from JavaScript (only relevant if minification is enabled).
-keepclassmembers class com.lanthano.research.AppBridge {
    @android.webkit.JavascriptInterface <methods>;
}
