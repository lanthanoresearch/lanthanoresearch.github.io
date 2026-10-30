// Lists every published file in the repository into site-files.json.
// offline-app.js (the phone / browser app) and desktop-app (the installer)
// both read that list, so they always know about the WHOLE site.
//
//   node build-site-manifest.js                      writes site-files.json
//   node build-site-manifest.js --copy <folder>      also copies the whole
//                                                    site into <folder>
//                                                    (used to bundle the
//                                                    desktop installer)
//
// The GitHub Action (.github/workflows/app.yml) runs this for you.
// Set DESKTOP_BASE to include the desktop installer download address.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = __dirname;

// Things that are never part of the website or the offline app.
const IGNORE_DIRS = new Set([".git", ".github", "node_modules", ".vscode", "desktop-app"]);
const IGNORE_FILES = new Set([
  "site-files.json",
  "build-site-manifest.js",
  "build-transcripts.js",
  "fetch-videos.js",
  "prepare-app-bundle.js",
  "package.json",
  "package-lock.json",
  "CNAME",
  "README.md",
  ".gitignore",
  ".DS_Store",
  "Thumbs.db"
]);

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".well-known") continue;

    // GitHub Pages (Jekyll) does not publish names that start with "_",
    // so they can never be downloaded. Skip them.
    if (entry.name.startsWith("_")) continue;

    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.has(entry.name)) walk(full, out);
    } else if (!IGNORE_FILES.has(entry.name)) {
      const bytes = fs.readFileSync(full);
      out.push({
        path: path.relative(ROOT, full).split(path.sep).join("/"),
        size: bytes.length,
        hash: crypto.createHash("sha1").update(bytes).digest("hex").slice(0, 16)
      });
    }
  }
}

const files = [];
walk(ROOT, files);
files.sort((a, b) => a.path.localeCompare(b.path));

const totalBytes = files.reduce((sum, f) => sum + f.size, 0);

const manifest = { count: files.length, totalBytes, files };

if (process.env.DESKTOP_BASE) {
  manifest.desktop = { base: process.env.DESKTOP_BASE };
}

const json = JSON.stringify(manifest, null, 1);

fs.writeFileSync(path.join(ROOT, "site-files.json"), json);

const copyIndex = process.argv.indexOf("--copy");

if (copyIndex !== -1 && process.argv[copyIndex + 1]) {
  const dest = path.resolve(process.argv[copyIndex + 1]);

  for (const f of files) {
    const target = path.join(dest, f.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(ROOT, f.path), target);
  }

  // The desktop app compares this list with the live one to find updates.
  fs.writeFileSync(path.join(dest, "site-files.json"), json);
}

console.log(
  "site-files.json: " + files.length + " files, " +
  (totalBytes / 1048576).toFixed(1) + " MB"
);
