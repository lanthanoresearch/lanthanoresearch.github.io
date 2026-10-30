// Gets a copy of the website ready to go inside an installed app.
//
// The Install page only makes sense on the website itself (it hands out the
// app), so it is taken out of the app, along with every link to it. Download
// stays. Storage stays too, but only its "Backup & restore" part (the rest is
// about what the browser saves, which an app that holds everything does not
// need). Settings stays without its "App updates" check (the app is its own
// offline copy).
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
const NO_BACK = process.argv.includes("--no-back");
const VIDEOS_AT = process.argv.indexOf("--videos") > -1 ? process.argv[process.argv.indexOf("--videos") + 1] : "";   // the computer app has its own Back handling

// offline-app.js runs the Install page.
const REMOVE = ["install.html", "offline-app.js", "prepare-app-bundle.js", "fetch-videos.js"];
const GONE_PAGES = "install\\.html";

// Storage stays in the app, but only its "Backup & restore" part: everything else
// on that page (what is saved in the browser, Save all, and so on) does not apply
// to an app that already holds everything.
const storageFile = path.join(dir, "storage.html");
if (fs.existsSync(storageFile)) {
  const html = fs.readFileSync(storageFile, "utf8");
  const head = html.slice(0, html.indexOf("<section>"));
  const backupFn = /\/\* What a backup would contain right now[\s\S]*?\n\}\n(?=\/\* Sizes in the same units)/.exec(html);
  const card = /<div class="card">\s*<h2 class="hd">(?:(?!<div class="card">)[\s\S])*?Backup &amp; restore[\s\S]*?<\/div>\s*(?=<\/section>)/.exec(html);
  const back = /<a class="back"[\s\S]*?<\/a>/.exec(html);
  const hero = /<div class="hero">[\s\S]*?<\/div><\/div>/.exec(html);
  const tail = html.slice(html.indexOf('<a href="#" class="top-button"'));

  if (backupFn && card && back && hero && tail.length > 20) {
    let page =
      head + "<section>\n\n    " + back[0] + "\n\n    " + hero[0] + "\n\n" +
      '    <h1 style="margin-bottom:30px">Storage</h1>\n\n    ' + card[0].trim() + "\n\n</section>\n\n" +
      "<script>\n(function(){\n\"use strict\";\nfunction $(id){ return document.getElementById(id); }\n" +
      backupFn[0] +
      'backupSummary();\n' +
      '$("bkExport").addEventListener("click", function(){ window.LT && LT.exportBackup(); setTimeout(backupSummary, 200); });\n' +
      '$("bkImport").addEventListener("click", function(){ window.LT && LT.importBackup(); });\n' +
      "})();\n</script>\n\n" + tail;
    page = page.replace(/this browser/g, "this app").replace(/<title>[^<]*<\/title>/, "<title>Storage</title>");
    fs.writeFileSync(storageFile, page);
    console.log("storage.html reduced to Backup & restore");
  } else {
    console.log("WARNING: could not reduce storage.html to Backup & restore, it is left out of the app instead");
    fs.unlinkSync(storageFile);
    REMOVE.push("storage.html");
  }
}

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

// A small line at the bottom of Settings saying which build this is, so it is
// easy to tell whether the newest version of the app is the one installed.
if (fs.existsSync(settingsFile)) {
  const run = process.env.GITHUB_RUN_NUMBER || "local";
  const sha = (process.env.GITHUB_SHA || "").slice(0, 7);
  const when = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const line = '<p class="note" id="appBuild" style="text-align:center;margin:30px 0 0">Lanthano Research Offline \u00b7 build ' +
    run + (sha ? " (" + sha + ")" : "") + " \u00b7 " + when + "</p>\n";
  const html = fs.readFileSync(settingsFile, "utf8");
  if (!html.includes('id="appBuild"') && /<\/section>/i.test(html)) {
    const i = html.toLowerCase().lastIndexOf("</section>");
    fs.writeFileSync(settingsFile, html.slice(0, i) + line + html.slice(i));
    console.log("build number added to settings.html");
  }
}

// The videos that normally come from the video server are put inside the app
// (see fetch-videos.js), and the app's list of videos is told to read them from
// the app itself, exactly like a video that is part of the site. That means they
// play, and are included in downloads, with no internet.
if (VIDEOS_AT) {
  const from = path.resolve(VIDEOS_AT);
  const listFile = path.join(dir, "descriptions.json");
  let inside = 0;
  let insideBytes = 0;
  let missing = 0;

  if (fs.existsSync(listFile) && fs.existsSync(from)) {
    const data = JSON.parse(fs.readFileSync(listFile, "utf8"));

    (function walk(o) {
      if (Array.isArray(o)) o.forEach(walk);
      else if (o && typeof o === "object") {
        if (typeof o.file === "string" && o.file && o.source !== "site") {
          const rel = o.file.split("/");
          const src = path.join(from, ...rel);

          if (fs.existsSync(src) && fs.statSync(src).size > 0) {
            const dest = path.join(dir, ...rel);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            if (!fs.existsSync(dest)) {
              try { fs.linkSync(src, dest); } catch (e) { fs.copyFileSync(src, dest); }
            }
            o.source = "site";
            inside++;
            insideBytes += fs.statSync(src).size;
          } else {
            missing++;
          }
        }
        Object.values(o).forEach(walk);
      }
    })(data);

    fs.writeFileSync(listFile, JSON.stringify(data, null, 2));
  }

  console.log("videos inside the app: " + inside + (missing ? " (" + missing + " could not be included and still need the internet)" : ""));
  console.log("size of those videos: " + (insideBytes / 1e9).toFixed(2) + " GB");
  if (insideBytes > 1.7e9) {
    console.log("::warning::The videos are " + (insideBytes / 1e9).toFixed(2) + " GB. Installers and GitHub downloads are limited to about 2 GB each, so the build may fail.");
  }
  if (missing) console.log("::warning::" + missing + " videos are not inside the app");
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
const CLEAN_STYLE = '<style id="app-clean">a[href$="install.html"],#updateCard,#installCard,.ltUpdate{display:none !important}body:has(#bkExport) .card:not(:has(#bkExport)){display:none !important}</style>';
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
