// Gets a copy of the website ready to go inside an installed app.
//
// The Storage and Install pages only make sense on the website itself (they
// manage the browser's saved copies and hand out the app), so they are taken
// out of the app, along with every link to them. Download stays.
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
      console.log("service worker set to local-only");
    } else {
      console.log("WARNING: could not find where to switch the service worker to local-only");
    }
  }

  // 2. Back button. Android's Back goes to the previous page, goes to the home
  //    page when there is nothing earlier, and only leaves the app from home.
  fs.writeFileSync(path.join(dir, "app-back.js"), [
    "(function(){",
    "  var C = window.Capacitor, App = C && C.Plugins && C.Plugins.App;",
    "  if(!App || !App.addListener) return;",
    "  function atHome(){ return /(^|\\/)(index\\.html)?$/.test(location.pathname); }",
    "  App.addListener('backButton', function(e){",
    "    if(e && e.canGoBack){ history.back(); return; }",
    "    if(!atHome()){ location.href = 'index.html'; return; }",
    "    App.exitApp();",
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

// Anything left that still points at a removed page is reported.
const left = [];
const leftRe = new RegExp("[\"'](?:\\./|/)?" + GONE_PAGES, "i");
for (const name of fs.readdirSync(dir)) {
  if (!/\.(html|js)$/i.test(name)) continue;
  if (leftRe.test(fs.readFileSync(path.join(dir, name), "utf8"))) left.push(name);
}
if (left.length) console.log("still mentions a removed page: " + left.join(", "));
console.log("app bundle ready: " + dir);
