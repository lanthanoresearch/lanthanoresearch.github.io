// Gets a copy of the website ready to go inside an installed app.
//
// The Download, Storage and Install pages only make sense on the website
// itself (they download files, manage the browser's saved copies, and hand out
// the app), so they are taken out of the app, along with every link to them.
//
//   node prepare-app-bundle.js <folder holding the copy of the site>
//
// The GitHub Actions for the computer app and the Android app run this
// right after they copy the site.

const fs = require("fs");
const path = require("path");

const dir = path.resolve(process.argv[2] || "");
if (!process.argv[2] || !fs.existsSync(dir)) {
  console.error("Usage: node prepare-app-bundle.js <folder>");
  process.exit(1);
}

// support.html only forwards to the Download page. offline-app.js runs the Install page.
const REMOVE = ["download.html", "storage.html", "install.html", "support.html", "offline-app.js", "prepare-app-bundle.js"];
const PAGES = /(download|storage|install|support)\.html/i;

for (const name of REMOVE) {
  const file = path.join(dir, name);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

// Links to those pages (the footer on the home page).
for (const name of fs.readdirSync(dir)) {
  if (!/\.html$/i.test(name)) continue;
  const file = path.join(dir, name);
  const before = fs.readFileSync(file, "utf8");
  const after = before.replace(
    /[ \t]*<a\b[^>]*href=["'](?:\.\/|\/)?(?:download|storage|install|support)\.html["'][^>]*>[\s\S]*?<\/a>[ \t]*\r?\n?/gi,
    ""
  );
  if (after !== before) {
    fs.writeFileSync(file, after);
    console.log("removed links from " + name);
  }
}

// The sitemap and the file list should not mention them either.
const sitemap = path.join(dir, "sitemap.xml");
if (fs.existsSync(sitemap)) {
  const text = fs.readFileSync(sitemap, "utf8")
    .replace(/<url>\s*<loc>[^<]*(?:download|storage|install|support)\.html[^<]*<\/loc>\s*<\/url>\r?\n?/gi, "");
  fs.writeFileSync(sitemap, text);
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

// Anything left that still points at a removed page is reported.
const left = [];
for (const name of fs.readdirSync(dir)) {
  if (!/\.(html|js)$/i.test(name)) continue;
  const text = fs.readFileSync(path.join(dir, name), "utf8");
  if (/["'](?:\.\/|\/)?(?:download|storage|install|support)\.html/i.test(text)) left.push(name);
}
if (left.length) console.log("still mentions a removed page: " + left.join(", "));
console.log("app bundle ready: " + dir);
