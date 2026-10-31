// The changes that turn a page of the website into the page that goes inside an
// installed app (the computer app and the Android app).
//
// It is used in two places, so a page looks exactly the same whether it came
// inside the installer or was fetched later by "Update" in Settings:
//   - prepare-app-bundle.js, when the app is built (Node)
//   - app-update.js, when the app updates itself from the website (browser)

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.AppTransform = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Pages and scripts that only belong on the website.
  const REMOVE = ["install.html", "offline-app.js", "prepare-app-bundle.js", "fetch-videos.js"];
  const GONE_PAGES = "install\\.html";

  // Files "Update" never replaces: they are part of the app itself, not of the site.
  const KEEP = REMOVE.concat([
    "sw.js", "main.js", "package.json", "package-lock.json", "app-back.js",
    "app-build.json", "app-videos.json", "site-files.json"
  ]);

  const CLEAN_STYLE =
    '<style id="app-clean">a[href$="install.html"],#updateCard,#installCard,.ltUpdate{display:none !important}' +
    "body:has(#bkExport) .card:not(:has(#bkExport)){display:none !important}</style>";

  // Storage keeps only its "Backup & restore" part. Returns null when the page
  // does not look as expected (the caller then leaves Storage out).
  function storage(html) {
    const head = html.slice(0, html.indexOf("<section>"));
    const backupFn = /\/\* What a backup would contain right now[\s\S]*?\n\}\n(?=\/\* Sizes in the same units)/.exec(html);
    const card = /<div class="card">\s*<h2 class="hd">(?:(?!<div class="card">)[\s\S])*?Backup &amp; restore[\s\S]*?<\/div>\s*(?=<\/section>)/.exec(html);
    const back = /<a class="back"[\s\S]*?<\/a>/.exec(html);
    const hero = /<div class="hero">[\s\S]*?<\/div><\/div>/.exec(html);
    const tail = html.slice(html.indexOf('<a href="#" class="top-button"'));

    if (!(backupFn && card && back && hero && tail.length > 20)) return null;

    let page =
      head + "<section>\n\n    " + back[0] + "\n\n    " + hero[0] + "\n\n" +
      '    <h1 style="margin-bottom:30px">Storage</h1>\n\n    ' + card[0].trim() + "\n\n</section>\n\n" +
      "<script>\n(function(){\n\"use strict\";\nfunction $(id){ return document.getElementById(id); }\n" +
      backupFn[0] +
      'backupSummary();\n' +
      '$("bkExport").addEventListener("click", function(){ window.LT && LT.exportBackup(); setTimeout(backupSummary, 200); });\n' +
      '$("bkImport").addEventListener("click", function(){ window.LT && LT.importBackup(); });\n' +
      "})();\n</script>\n\n" + tail;
    return page.replace(/this browser/g, "this app").replace(/<title>[^<]*<\/title>/, "<title>Storage</title>");
  }

  // Links to the pages that are not in the app.
  function removeLinks(html) {
    const linkRe = new RegExp(
      "[ \\t]*<a\\b[^>]*href=[\"'](?:\\./|/)?" + GONE_PAGES + "[\"'][^>]*>[\\s\\S]*?</a>[ \\t]*\\r?\\n?",
      "gi"
    );
    return html.replace(linkRe, "");
  }

  // Settings: the website's own update check and install cards are not part of
  // the app. The app has its own update card instead (app-update.js builds it).
  function settingsCards(html) {
    const cardRe = /[ \t]*<div class="card" id="(?:updateCard|installCard)"[^>]*>[\s\S]*?\r?\n    <\/div>[ \t]*\r?\n(?:[ \t]*\r?\n)?/g;
    return html.replace(cardRe, "");
  }

  function addScripts(html, names) {
    if (!names.length || !/<\/body>/i.test(html)) return html;
    const tags = names
      .filter(n => !html.includes('src="' + n + '"'))
      .map(n => '<script src="' + n + '"></script>\n')
      .join("");
    return tags ? html.replace(/<\/body>/i, tags + "</body>") : html;
  }

  // The PDF viewer uses pdf.js's "legacy" build, which also runs in the app's
  // browser and on phones without the newest features.
  function pdf(html) {
    return html
      .split("./pdfjs/build/pdf.mjs").join("./pdfjs/legacy/build/pdf.mjs")
      .split("./pdfjs/build/pdf.worker.mjs").join("./pdfjs/legacy/build/pdf.worker.mjs");
  }

  // The list of videos: the ones that are inside the app are read from the app.
  // hasFile(file) says whether a video file is inside the app.
  function descriptions(text, hasFile) {
    const data = JSON.parse(text);
    (function walk(o) {
      if (Array.isArray(o)) o.forEach(walk);
      else if (o && typeof o === "object") {
        if (typeof o.file === "string" && o.file && o.source !== "site" && hasFile(o.file)) {
          o.source = "site";
        }
        Object.values(o).forEach(walk);
      }
    })(data);
    return JSON.stringify(data, null, 2);
  }

  function sitemap(text) {
    const urlRe = new RegExp("<url>\\s*<loc>[^<]*" + GONE_PAGES + "[^<]*</loc>\\s*</url>\\r?\\n?", "gi");
    return text.replace(urlRe, "");
  }

  // The same clean-up for every page. opts.android adds the Back button handler
  // (Android only).
  function finishPage(html, opts) {
    opts = opts || {};
    if (opts.android && !html.includes("app-back.js") && /<\/body>/i.test(html)) {
      html = html.replace(/<\/body>/i, '<script src="app-back.js"></script>\n</body>');
    }
    if (!html.includes('id="app-clean"') && /<\/head>/i.test(html)) {
      html = html.replace(/<\/head>/i, CLEAN_STYLE + "\n</head>");
    }
    return html;
  }

  // Turns the website's version of one file into the app's version.
  // Returns the new text, the same text, or null when the file is not part of
  // the app. Only text files go through here.
  function file(name, text, opts) {
    opts = opts || {};
    if (REMOVE.includes(name)) return null;
    if (name === "sitemap.xml") return sitemap(text);
    if (name === "descriptions.json") return descriptions(text, opts.hasVideo || (() => false));
    if (!/\.html$/i.test(name)) return text;

    let html = text;
    if (name === "storage.html") {
      html = storage(html);
      if (html === null) return null;
    }
    html = removeLinks(html);
    if (name === "settings.html") html = addScripts(settingsCards(html), ["app-transform.js", "app-update.js"]);
    if (name === "pdf.html" && opts.legacyPdf !== false) html = pdf(html);
    return finishPage(html, opts);
  }

  return { REMOVE, KEEP, GONE_PAGES, CLEAN_STYLE, storage, removeLinks, settingsCards, addScripts, pdf, descriptions, sitemap, finishPage, file };
});
