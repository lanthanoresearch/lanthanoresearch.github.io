# Lanthano Research — offline Android app

This folder turns the Lanthano Research site (the repository root) into a
self-contained Android app. The finished APK contains every page, script,
stylesheet, image, audio/video file, JSON data file, PDF.js and all 27 research
PDFs. It has **no INTERNET permission** and works in airplane mode.

- App name: **Lanthano Research**
- Package: `com.lanthano.research`
- Kotlin, AndroidX, one WebView activity
- Android Gradle Plugin 8.7.3, Gradle 8.11.1, Kotlin 2.0.21
- minSdk 26 (Android 8.0), targetSdk/compileSdk 35

## Layout

```
<repository root>/            the site, unchanged (index.html, pdf.html, PDFs, pdfjs/, ...)
├── .github/workflows/build-android-apk.yml   builds the APK on GitHub
└── android/                  this project
    ├── app/src/main/java/com/lanthano/research/
    │   ├── MainActivity.kt       WebView setup, navigation, Back button, fullscreen
    │   ├── LocalAssetServer.kt   serves the bundled files, blocks everything remote
    │   ├── AppBridge.kt          Save as, share, clipboard, open-with, keep-screen-on
    │   └── SpeechBridge.kt       Read Aloud on Android's on-device text-to-speech
    ├── app/src/main/assets/lanthano-app/
    │   ├── polyfills.js          newer JavaScript built-ins PDF.js 5.7 needs
    │   ├── android-shim.js       adapts browser-only features to Android
    │   └── vendor/jszip.min.js   local copy of the JSZip file support.html loaded from a CDN
    ├── tools/offline-test/       headless-Chromium test of the bundled content, fully offline
    ├── gradlew, gradlew.bat      Gradle launcher (see "Building")
    └── README.md
```

The site is **not** copied into this folder. At build time the task
`prepareLanthanoWebAssets` copies the repository root into the APK's
`assets/www`, leaving out repository-only files (`android/`, `.github/`,
`scripts/`, `README.md`, `CNAME`, `package.json`, `build-search.js`, `sw.js`).
The build fails if `index.html`, `pdf.html`, `descriptions.json`,
`search-index.json` or the PDF.js files are missing. To build from a site
folder somewhere else, pass `-Planthano.webRoot=<folder>`.

## How the app works

**Local origin.** Pages load from `https://appassets.androidplatform.net/`, a
reserved host that never resolves on a real network (it is the one AndroidX's
`WebViewAssetLoader` uses). `LocalAssetServer` answers every request for it
straight from the APK. A secure-origin URL is used instead of
`file:///android_asset/` because the site relies on ES modules, a module Web
Worker (PDF.js), `fetch()` of JSON files and `localStorage`. WebView blocks or
restricts all of these on `file://` unless its security settings are loosened.
With this approach, file access and content access stay **off**.

**No network.** Four layers keep the app offline:

1. The manifest removes `INTERNET` and `ACCESS_NETWORK_STATE`, even if a library tried to add them.
2. `blockNetworkLoads` is on for pages and service workers.
3. `LocalAssetServer` answers any non-local `http(s)` request with `403 Blocked`.
4. WebView Safe Browsing and metrics are turned off, since both would use the network.

**Unchanged site files.** Nothing in the site is edited. Two small scripts are
injected at the top of each page's `<head>` when it is served:

- `polyfills.js`. The bundled PDF.js (5.7.284, "modern" build) calls very new
  JavaScript built-ins without checking for them first, including
  `Map.prototype.getOrInsertComputed`, `Math.sumPrecise`, `Promise.try`,
  `Uint8Array.fromBase64`/`toHex`, `URL.parse`, `Set.prototype.intersection`
  and `Response.bytes()`. Many phones' Android System WebView does not have
  these yet, and without them **every PDF page fails to render**. The polyfills
  are defined only when missing. The same file is also prepended to
  `pdf.worker.mjs`, because the worker does not see the page's scripts.
- `android-shim.js`. It is active only inside the app, so the site behaves
  exactly as before in a normal browser. It changes the following:

  | Browser feature | In the app |
  |---|---|
  | Service worker (`sw.js`) | Not registered; every file is already local |
  | `<a download>` / Download buttons | Android "Save as" picker. Bundled PDFs are copied straight from the APK; generated files (e.g. the support-page ZIP) are streamed in chunks |
  | `window.open()` | Images/video/audio open in an in-app viewer; PDFs offer "Open with"; external links go to another app |
  | `navigator.share`, `clipboard.writeText` | Android share sheet and clipboard; links to the site's own pages use its public address |
  | `speechSynthesis` (Read Aloud) | Android's on-device text-to-speech, including word-by-word highlighting, pause/resume and voice choice |
  | `navigator.wakeLock` | Keeps the screen on while reading aloud |
  | Back button | Closes the in-app viewer / fullscreen video first, then goes back through page history, then exits |

The one remote file the site needs at run time,
`https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js` (loaded by
`support.html`), is served from the bundled copy in `vendor/`.

**Other details.**

- A tap on a direct link to a `.pdf` opens it in the app's own PDF.js viewer.
- Audio and video are stored uncompressed and served with HTTP range support,
  so seeking works.
- Missing pages show the site's `404.html`.
- If the WebView renderer crashes, the activity restarts.
- If the device's WebView is older than Chromium 100, a one-time notice
  suggests updating "Android System WebView".

## Remote references in the site and how each is handled

| Reference | Needed? | Handling |
|---|---|---|
| JSZip from jsdelivr (`support.html`) | Yes (archive download) | Bundled copy |
| Kitten/Kokoro neural voice: phonemizer + onnxruntime-web (jsdelivr), model/voices (huggingface.co) in `pdf.html` | No. That option is hidden in the site's UI; Read Aloud falls back to the system voice | Blocked; Read Aloud uses Android text-to-speech |
| WebLLM (`esm.run`, jsdelivr) in `assistant-window.js` | No. The assistant is disabled in the site (`ENABLE_AI_BUTTON = false`) | Never loaded; would be blocked |
| `sw.js` network-first caching | No | Not bundled, registration skipped |
| `fetch()` calls (`descriptions.json`, `page-counts.json`, `search-index.json`, `featured-video.html`, `content-pages.json`) | Yes | All same-origin, served from the APK. `content-pages.json` does not exist in the source; the site already handles that |
| ~600 URLs inside `search-index.json` | No | Citation text, only searched and displayed |
| Links to music platforms, store, video sites, lanthanomusic.com | No | Opened in another app only when tapped |
| `fuse.basic.min.mjs` / PDF.js URLs | No | License comments |
| `http://www.w3.org/...` | No | SVG namespace |

There are no `XMLHttpRequest` or `WebSocket` uses and no remote fonts,
stylesheets or images.

## Building

The build needs a network connection to download Gradle, the Android Gradle
Plugin and the Android SDK. The app that is built never uses the network.

### On GitHub (no local setup)

1. Put this `android/` folder and `.github/workflows/build-android-apk.yml`
   into the site repository and push.
2. Open **Actions → Build Android APK**. It runs on every push to `main`, or
   start it with **Run workflow**.
3. Download the artifact **lanthano-research-debug-apk**. It contains
   `LanthanoResearch-debug.apk` and `SHA256SUMS.txt`.

The workflow also checks each APK:

- The APK exists.
- It does not request `INTERNET`.
- It contains every PDF of the repository, PDF.js, the polyfills and the shim.

A second job runs the offline test below and uploads its report and
screenshots.

**Signed release APK (optional).** Add these repository secrets:

- `LANTHANO_KEYSTORE_BASE64`: `base64 -w0 release.jks`
- `LANTHANO_KEYSTORE_PASSWORD`
- `LANTHANO_KEY_ALIAS`
- `LANTHANO_KEY_PASSWORD`

The workflow then also uploads **lanthano-research-release-apk**. The keystore
only exists in the runner's temp folder during the build. Never commit
keystores or passwords; `.gitignore` excludes them, along with `.gradle/`,
`build/`, `local.properties` and APKs.

### Locally

Requirements: JDK 17 and the Android SDK (Android Studio installs both). If
`ANDROID_HOME` is not set, create `android/local.properties` with
`sdk.dir=/path/to/Android/sdk`.

```sh
cd android
./gradlew assembleDebug          # Windows: gradlew.bat assembleDebug
# -> app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

`gradlew` behaves like the standard Gradle wrapper. The repository does not
keep the binary `gradle-wrapper.jar`, so on first use the script downloads
Gradle 8.11.1 into `~/.gradle`. If you prefer the official wrapper, run
`gradle wrapper --gradle-version 8.11.1` once; `gradlew` will use the
generated jar from then on. Opening `android/` in Android Studio also works.

Release: `LANTHANO_KEYSTORE_FILE=... LANTHANO_KEYSTORE_PASSWORD=... LANTHANO_KEY_ALIAS=... LANTHANO_KEY_PASSWORD=... ./gradlew assembleRelease`.
Without these variables, `assembleRelease` produces an unsigned APK.

The APK is about 300 MB, because the site's images, PDFs and video are that
large.

## Offline test

`tools/offline-test/offline-test.cjs` runs the bundled content in headless
Chromium the way the app serves it:

- Every page is loaded from `https://appassets.androidplatform.net/`.
- A JavaScript port of `LocalAssetServer` answers each request, with the same
  exclude rules, shim injection, range support and 404 page.
- Every other request is refused, and DNS is disabled for the whole browser.
- A mock `window.LanthanoAndroid` bridge makes the shim run as it does in the
  app.

The test covers:

- **Home:** warning, search index, categories, statistics, featured carousel, images, no service worker.
- **Search:** Fuse search, and opening a result in the PDF viewer.
- **Archive:** all 8 category pages, the full archive, favorites and cover images.
- **Other pages:** timeline, about, contact, store, support (JSZip), music (audio seeking), video pages, image viewer, the 404 page and pretty URLs.
- **Every one of the 27 PDFs:** opens, the page count matches `page-counts.json`, and page 1 is actually painted.
- **PDF viewer:** page jump, scrolling, zoom, in-document search, contents, Read Aloud with highlighting and wake lock, Download, Copy link.
- **Old WebView:** the new built-ins are removed and PDF rendering and search still work through `polyfills.js`.
- **Shim:** downloads, share, `window.open`, Back, and blocked remote fetches and images.
- **Layout:** landscape, and rotation back to portrait.

To run it:

```sh
cd android/tools/offline-test
npm install && npx playwright install chromium
node offline-test.cjs --web-root ../../..      # optional: --only pdfs,viewer  --pdf moon_hoax
```

Results go to `android/tools/test-output/report.json`, with screenshots in the
same folder.

## Known limitations

- The optional neural "Kitten/Kokoro" voice and the WebLLM research assistant
  need to download models, so they cannot work offline. Both are already
  hidden or disabled in the site itself. Read Aloud uses the phone's installed
  text-to-speech voices; only voices marked as not needing a network are
  offered.
- External links (store, music platforms, video sites, e-mail) open in other
  apps and need a connection there. The app itself never needs them.
- Share and Copy link produce `https://lanthanoresearch.com/...` links, as the
  site does.
- PDF.js needs Android System WebView based on Chromium 100 or newer. Any
  phone that has had Play Store updates since 2022 has this.
- `research-timeline.html` logs a harmless `e.target.closest is not a function`
  error. It comes from a capture-phase `mouseenter` listener in the original
  site and happens in desktop browsers too; it does not affect the page.
