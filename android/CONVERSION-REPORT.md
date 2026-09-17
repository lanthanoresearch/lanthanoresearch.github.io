# Lanthano Research → offline Android app: conversion report

## 1. What was done

The uploaded ZIP (`lanthanoresearch_github_io-main`, 277 files) was inspected in
full. It is a static site with no backend. It contains:

- 16 HTML pages;
- the paper metadata `descriptions.json` (27 papers);
- `search-index.json` (used with Fuse.js) and `page-counts.json`;
- PDF.js 5.7.284 (ES-module build with a module worker);
- 27 research PDFs, cover images, 143 supporting images, 6 MP3s and 1 MP4.

It was converted into a Kotlin/AndroidX WebView app named **Lanthano Research**
(`com.lanthano.research`). The app is built with AGP 8.7.3, Gradle 8.11.1 and
Kotlin 2.0.21, with minSdk 26 and target/compileSdk 35. See `README.md` for the
architecture. In short:

- **Bundling.** The whole site is copied into the APK at build time: 266 files,
  296.5 MB uncompressed, including all 27 PDFs. Only repository tooling is left
  out (`.github/`, `scripts/`, `build-search.js`, `package.json`, `CNAME`,
  `README.md`, `sw.js`).
- **Serving.** Pages are served from a reserved local https origin by
  `LocalAssetServer`, so ES modules, the PDF.js worker, `fetch()` and
  `localStorage` work unchanged. `file://` access stays disabled.
- **No network.**
  - There is no `INTERNET` or `ACCESS_NETWORK_STATE` permission; the manifest
    removes both explicitly.
  - WebView network loads are blocked.
  - Every non-local request is answered with "403 Blocked".
  - Safe Browsing and WebView metrics are off.
- **Permissions.** The app requests none: no dangerous permissions and no
  normal ones either.
- **Site files.** None were edited. Two scripts are injected at serve time:
  - `polyfills.js` supplies new JavaScript built-ins that PDF.js 5.7 calls
    unconditionally.
  - `android-shim.js` adapts browser-only features: Save as, share, clipboard,
    `window.open`, Read Aloud (`speechSynthesis`), the screen wake lock, the
    Back button, and service-worker registration.
- **Launcher icon.** Made from the site's own icon
  (`file_000000000c40722f92b1fe6758cb4855.png`, the one its web manifest uses),
  on the site's `#111111` background.

### Remote-dependency audit

All `http://`, `https://`, `fetch(`, `XMLHttpRequest`, `WebSocket`, CDN, font
and stylesheet references were checked. Only one is needed at run time:
**JSZip** from jsdelivr, used by the Support page's "Download Archive". It is
now served from a bundled copy (`vendor/jszip.min.js`, 3.10.1).

The rest were not needed to run the app:

- **Kokoro neural voice and WebLLM assistant.** Both are optional and download
  models. They are already hidden or disabled in the site's own code.
- **`sw.js`.** Not bundled.
- **`fetch()` calls.** All go to the site's own local files.
- **Other URLs.** The rest are citation text inside `search-index.json`,
  ordinary external links, license comments or the SVG namespace.

The site has no remote fonts, stylesheets or images, and no `XMLHttpRequest` or
`WebSocket`.

### Problem found and fixed during testing

The bundled PDF.js calls `Map.prototype.getOrInsertComputed`, `Math.sumPrecise`,
`Promise.try`, `Uint8Array.fromBase64`/`toHex`, `URL.parse`,
`Set.prototype.intersection`, `Response.bytes()` and a few others, without
checking that they exist. Chromium 141, the browser used for testing, lacks
some of them, and so do many phones' Android System WebView. **On those, every
PDF page stayed blank.**

`polyfills.js` now provides these built-ins in each page and in the PDF.js
worker. An additional test removes all of them first and confirms that PDFs
still render and can be searched.

Two further additions:

- The site's Read Aloud requests a screen wake lock, which WebView does not
  support. It is now mapped to Android's "keep screen on", so the phone does
  not lock while reading.
- The app shows a one-time notice if the phone's WebView is older than
  Chromium 100.

## 2. Functionality preserved

- **Home page:** content warning, featured carousel, archive statistics
  (27 papers / 581 pages / 143 images), category buttons, site search (Fuse.js)
  across papers and images.
- **Research archive:** all 8 categories, "All research" with sorting, favorites
  (stored locally), paper descriptions, metadata, covers and supporting images.
- **Research timeline.**
- **PDF viewer (PDF.js) for all 27 papers:**
  - opening and page navigation (page number, scrolling, side scroller);
  - zoom, fit width/page and free/locked movement;
  - in-document search with highlighting and next/previous;
  - table of contents, bookmarks and resume position;
  - reading mode, fullscreen and image context menu;
  - controversial-content notices;
  - Read Aloud with line highlighting, speed and voice choice (Android
    text-to-speech voices on the device);
  - Download (Android "Save as"), Copy link / Share (Android share sheet),
    and "open in new tab" (Android "Open with").
- **Other pages:** image viewer page, Images, video pages (MP4), music and
  Hitorah music (MP3 with seeking), Discover, About, Contact, Store, Support
  (offline ZIP archive download) and the 404 page.
- **Layout and styling:** all existing styling, responsive layout, portrait and
  landscape, rotation without reloading, touch and pinch zoom.
- **Back button:** closes viewers and fullscreen, goes back through app
  history, then exits.

## 3. Build results

**No APK was built in this environment.** It has no Android SDK, no Gradle, no
Kotlin compiler and no emulator. Its network access is blocked (dl.google.com,
services.gradle.org and Maven Central return `403 host_not_allowed`), so none
of these could be installed. No `.apk` file exists from this work, and none is
claimed.

What was done instead:

- **Complete project.** The Gradle project is complete, and the Kotlin, the
  manifest and the resources were reviewed by hand. That review cannot replace
  a compiler run: the first real build may still reveal an error.
- **Build commands.**
  - `./gradlew assembleDebug` / `assembleRelease` work without a committed
    wrapper jar. `gradlew` downloads Gradle 8.11.1 once; its download,
    checksum and cache paths were tested with a local stand-in distribution.
  - `gradlew.bat` and `gradle/launcher.ps1` are the Windows equivalents. They
    could not be run here because no PowerShell is available.
- **GitHub Actions** (`.github/workflows/build-android-apk.yml`).
  - It builds the debug APK, and a signed release APK when secrets exist.
  - It checks that the APK exists, has no `INTERNET` permission, and contains
    every repository PDF, PDF.js, the polyfills and the shim.
  - It uploads the APK as an artifact.
  - The verification script was dry-run here against stand-in APKs: it passes
    for a complete APK and fails when a PDF is missing.
- **Expected APK size:** about 285–300 MB.

To get the APK: add `android/` and `.github/workflows/build-android-apk.yml` to
the site repository, push, and download **lanthano-research-debug-apk** from the
Actions run. Alternatively, run `cd android && ./gradlew assembleDebug` on a
computer with JDK 17 and the Android SDK.

## 4. Offline testing results

An Android emulator was not available. Instead,
`tools/offline-test/offline-test.cjs` ran the exact bundled content in headless
Chromium 141 (Playwright), served the way the app serves it:

- Pages come from the same local origin, through a JavaScript port of
  `LocalAssetServer` with the same bundle rules, shim injection, polyfills,
  range support and 404 page.
- DNS is disabled for the whole browser, and every non-local request is
  refused.
- A mock of the Android bridge is installed, so the app-only code paths run.

**Result: 182 checks passed, 0 failed.**

- **Launch and home page:** loads without JS errors, the search index loads,
  and no service worker is registered.
- **Search:** "moon landing" returns papers, and tapping a result opens it in
  the PDF viewer.
- **Navigation:** Back returns to the home page, and the viewer's Back button
  returns to the archive.
- **Archive:** all 8 category pages list papers, the full archive lists
  27 of 27, and all covers load.
- **Timeline** renders 27 papers.
- **Other pages:** Discover, About, Contact, Store, Support (JSZip available
  offline), Music (MP3 loads and seeks, 66 s track), Hitorah music, Images,
  Featured video, Video, the image viewer, the 404 page and pretty URLs all
  load with content, no missing resources and no broken images.
- **All 27 PDFs** open and page 1 is actually drawn. Every page count matches
  `page-counts.json` (581 pages in total), with loading times of 0.5–1 s.
- **PDF viewer:** jump to page 5, scroll to page 13, zoom 100 % → 125 %.
  Search for "moon" finds 205 matches and steps through them. The contents
  panel opens.
- **Read Aloud:** speaks through the Android bridge with word-boundary events
  and line highlighting, keeps the screen on, and releases it on stop.
- **Old-WebView run:** with every polyfilled built-in removed, the 128-page
  *The Corrupt Versions* renders and search finds 2,749 matches.
- **Android integrations:**
  - Download saves the bundled PDF through "Save as".
  - Generated files are streamed in chunks.
  - Share and Copy link use Android with the public link.
  - `window.open` opens the in-app viewer (external links go to Android, PDFs
    to "Open with").
  - Back closes the viewer first.
- **Network:** remote fetches and images are blocked, and the site attempted
  no remote requests of its own during the tests (only the test's two
  deliberate probes appear).
- **Screens:** landscape home has no horizontal overflow, the landscape PDF
  renders, and rotating back to portrait re-fits the page.
- **Normal browser:** the shim stays inactive, so the site is unchanged there.

One note, not a failure: `research-timeline.html` logs
`e.target.closest is not a function` from its own capture-phase `mouseenter`
listener. This is a harmless bug in the original site that also happens in
desktop browsers.

Screenshots and `report.json` are provided in `offline-test-results.zip`; running the test again recreates them in `android/tools/test-output/`.

**Not covered by these tests:**

- the real Android WebView and native code (TextToSpeech, Save as, share sheet,
  FileProvider, Back handling, rotation in the activity);
- MP4 playback, because Playwright's Chromium has no H.264 decoder.

Please check these on a phone: install the APK, switch on airplane mode, and go
through the same flow.

## 5. Remaining limitations

- The APK has not been compiled or run on a device yet (see section 3).
- The neural "Kokoro" voice and the WebLLM research assistant need model
  downloads. Both were already hidden or disabled in the site and remain
  unavailable offline.
- **Read Aloud needs a text-to-speech voice on the phone.** Only on-device
  voices are offered, and most phones include one.
- **External links need a connection** in the app they open in: music
  platforms, store, video sites and e-mail.
- **Share and Copy link** produce `https://lanthanoresearch.com/...` links, as
  the site itself does.
- **WebView version:** Android System WebView 100 or newer is needed for the
  PDF viewer.
- **App size:** about 300 MB, because of the bundled PDFs, images and video.
- **Content updates:** the APK contains the site as it was at build time. New
  papers need a rebuild, which the workflow does automatically on push.
