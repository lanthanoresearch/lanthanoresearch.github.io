// Gets a copy of the website ready to go inside an installed app.
//
// The Storage and Install pages only make sense on the website itself (they
// manage the browser's saved copies and hand out the app), so they are taken
// out of the app, along with every link to them. Download stays. Settings stays
// too, without its "App updates" check (the app is its own offline copy).
//
//   node prepare-app-bundle.js <folder holding the copy of the site> [--local-only]
//
// --local-only (the Android app): the app already holds every file, so its
// service worker is told never to go to the internet for pages, scripts,
// pictures or PDFs. Without this it could swap the built-in pages for the live
// website's, and links that were taken out would come back. The phone's Back
// button is also taken care of (see app-back.js below).
//
// The GitHub Actions for the computer app and the Android app run this
// right after they copy the site.

const fs = require("fs");
const path = require("path");

const dir = path.resolve(process.argv[2] || "");
if (!process.argv[2] || !fs.existsSync(dir)) {
  console.error("Usage: node prepare-app-bundle.js <folder> [--local-only]");
  process.exit(1);
}

const LOCAL_ONLY = process.argv.includes("--local-only");
const NO_BACK = process.argv.includes("--no-back");   // the computer app has its own Back handling

// offline-app.js runs the Install page.
const REMOVE = ["storage.html", "install.html", "offline-app.js", "prepare-app-bundle.js"];
const GONE_PAGES = "(?:storage|install)\\.html";

for (const name of REMOVE) {
  const file = path.join(dir, name);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

// Links to those pages (the footer on the home page).
const linkRe = new RegExp(
  "[ \\t]*<a\\b[^>]*href=[\"'](?:\\./|/)?" + GONE_PAGES + "[\"'][^>]*>[\\s\\S]*?</a>[ \\t]*\\r?\\n?",
  "gi"
);
for (const name of fs.readdirSync(dir)) {
  if (!/\.html$/i.test(name)) continue;
  const file = path.join(dir, name);
  const before = fs.readFileSync(file, "utf8");
  const after = before.replace(linkRe, "");
  if (after !== before) {
    fs.writeFileSync(file, after);
    console.log("removed links from " + name);
  }
}

// Settings stays, but an app that holds everything itself has nothing to check
// for updates and nothing to install, so those two cards are taken out.
const settingsFile = path.join(dir, "settings.html");
if (fs.existsSync(settingsFile)) {
  const cardRe = /[ \t]*<div class="card" id="(?:updateCard|installCard)"[^>]*>[\s\S]*?\r?\n    <\/div>[ \t]*\r?\n(?:[ \t]*\r?\n)?/g;
  const before = fs.readFileSync(settingsFile, "utf8");
  const after = before.replace(cardRe, "");
  if (after !== before) {
    fs.writeFileSync(settingsFile, after);
    console.log("removed update check from settings.html");
  } else {
    console.log("WARNING: could not find the update check in settings.html");
  }
}

// The PDF viewer. The website uses the newest build of pdf.js, which needs very
// recent browser features (the computer app's browser and many phones' do not
// have them yet, which showed "hashOriginal.toHex is not a function"). pdf.js
// also ships a "legacy" build that carries what is missing, so the app uses it.
const pdfPage = path.join(dir, "pdf.html");
if (fs.existsSync(pdfPage) && fs.existsSync(path.join(dir, "pdfjs", "legacy", "build", "pdf.mjs"))) {
  const before = fs.readFileSync(pdfPage, "utf8");
  const after = before
    .split("./pdfjs/build/pdf.mjs").join("./pdfjs/legacy/build/pdf.mjs")
    .split("./pdfjs/build/pdf.worker.mjs").join("./pdfjs/legacy/build/pdf.worker.mjs");
  if (after !== before) {
    fs.writeFileSync(pdfPage, after);
    console.log("PDF viewer set to the compatible pdf.js build");
  }
} else if (fs.existsSync(pdfPage)) {
  console.log("WARNING: pdfjs/legacy/build not found, the PDF viewer may fail in the app");
}

// The sitemap and the file list should not mention them either.
const sitemap = path.join(dir, "sitemap.xml");
if (fs.existsSync(sitemap)) {
  const urlRe = new RegExp("<url>\\s*<loc>[^<]*" + GONE_PAGES + "[^<]*</loc>\\s*</url>\\r?\\n?", "gi");
  fs.writeFileSync(sitemap, fs.readFileSync(sitemap, "utf8").replace(urlRe, ""));
}

const list = path.join(dir, "site-files.json");
if (fs.existsSync(list)) {
  const data = JSON.parse(fs.readFileSync(list, "utf8"));
  const gone = new Set(REMOVE);
  data.files = (data.files || []).filter(f => !gone.has(f.path));
  data.count = data.files.length;
  data.totalBytes = data.files.reduce((n, f) => n + f.size, 0);
  fs.writeFileSync(list, JSON.stringify(data, null, 1));
}

if (LOCAL_ONLY) {
  // 1. The service worker only plays back saved videos. Every other file is
  //    already inside the app and is answered by the app itself.
  const swFile = path.join(dir, "sw.js");
  if (fs.existsSync(swFile)) {
    const sw = fs.readFileSync(swFile, "utf8");
    const marker = "  // Page navigations: live site first";
    if (sw.includes("Installed app:")) {
      // already done
    } else if (sw.includes(marker)) {
      fs.writeFileSync(swFile, sw.replace(marker,
        "  // Installed app: every other file is already inside the app, so the\n" +
        "  // internet is never used for it.\n" +
        "  return;\n\n" + marker));
      let patched = fs.readFileSync(swFile, "utf8");
      const act = 'self.addEventListener("activate", event => {';
      if (patched.includes(act)) {
        patched = patched.replace(act, act +
          "\n  // Installed app: forget any copies of live website pages an older version saved.\n" +
          "  event.waitUntil(Promise.all([SITE_CACHE, OFFLINE_CACHE].map(n => caches.delete(n))));");
        fs.writeFileSync(swFile, patched);
      }
      console.log("service worker set to local-only");
    } else {
      console.log("WARNING: could not find where to switch the service worker to local-only");
    }
  }

  // 2. Back button (Android only).
  if (!NO_BACK) {
  // Android's Back goes to the previous page, goes to the home
  //    page when there is nothing earlier, and only leaves the app from home.
  fs.writeFileSync(path.join(dir, "app-back.js"), [
    "(function(){",
    "  var C = window.Capacitor, App = C && ((C.Plugins && C.Plugins.App) || (C.registerPlugin && C.registerPlugin('App')));",
    "  if(!App || !App.addListener) return;",
    "  function atHome(){ return /(^|\\/)(index\\.html)?$/.test(location.pathname); }",
    "  var busy = false;",
    "  App.addListener('backButton', function(){",
    "    if(busy) return;",
    "    busy = true; setTimeout(function(){ busy = false; }, 500);",
    "    // Always try the page before first. If the phone has nothing earlier to go",
    "    // back to (the page does not change), go to the home page, and leave the",
    "    // app only from the home page.",
    "    var before = location.href, left = false;",
    "    window.addEventListener('pagehide', function(){ left = true; }, {once:true});",
    "    history.back();",
    "    setTimeout(function(){",
    "      if(left || location.href !== before) return;",
    "      if(!atHome()){ location.href = 'index.html'; return; }",
    "      App.exitApp();",
    "    }, 350);",
    "  });",
    "})();",
    ""
  ].join("\n"));
  for (const name of fs.readdirSync(dir)) {
    if (!/\.html$/i.test(name)) continue;
    const file = path.join(dir, name);
    const html = fs.readFileSync(file, "utf8");
    if (html.includes("app-back.js") || !/<\/body>/i.test(html)) continue;
    fs.writeFileSync(file, html.replace(/<\/body>/i, '<script src="app-back.js"></script>\n</body>'));
  }
  console.log("back button handler added");
  }
}

// Belt and braces: every page in the app also hides, by itself, the links to the
// website-only pages and the update / install cards, so they can never show up
// even if a stray old copy of a page ever turned up.
const CLEAN_STYLE = '<style id="app-clean">a[href$="storage.html"],a[href$="install.html"],#updateCard,#installCard,.ltUpdate{display:none !important}</style>';
for (const name of fs.readdirSync(dir)) {
  if (!/\.html$/i.test(name)) continue;
  const file = path.join(dir, name);
  const html = fs.readFileSync(file, "utf8");
  if (html.includes('id="app-clean"') || !/<\/head>/i.test(html)) continue;
  fs.writeFileSync(file, html.replace(/<\/head>/i, CLEAN_STYLE + "\n</head>"));
}

// Anything left that still points at a removed page is reported.
const left = [];
const leftRe = new RegExp("[\"'](?:\\./|/)?" + GONE_PAGES, "i");
for (const name of fs.readdirSync(dir)) {
  if (!/\.(html|js)$/i.test(name)) continue;
  const text = fs.readFileSync(path.join(dir, name), "utf8").replace(/<style id="app-clean">[\s\S]*?<\/style>/, "");
  if (leftRe.test(text)) left.push(name);
}
if (left.length) console.log("still mentions a removed page: " + left.join(", "));
console.log("app bundle ready: " + dir);
