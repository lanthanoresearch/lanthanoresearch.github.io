// Lists every file in the repository into site-files.json so the
// "Offline App" feature on support.html can copy the WHOLE site.
//
// Run manually:   node build-site-manifest.js
// Or let the GitHub Action (.github/workflows/site-manifest.yml) run it
// automatically on every push.

const fs = require("fs");
const path = require("path");

const ROOT = __dirname;

// Things that should never be shipped inside the offline app.
const IGNORE_DIRS = new Set([".git", ".github", "node_modules", ".vscode"]);
const IGNORE_FILES = new Set([
  "site-files.json",
  "build-site-manifest.js",
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

    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.has(entry.name)) walk(full, out);
    } else if (!IGNORE_FILES.has(entry.name)) {
      out.push({
        path: path.relative(ROOT, full).split(path.sep).join("/"),
        size: fs.statSync(full).size
      });
    }
  }
}

const files = [];
walk(ROOT, files);
files.sort((a, b) => a.path.localeCompare(b.path));

const totalBytes = files.reduce((sum, f) => sum + f.size, 0);

fs.writeFileSync(
  path.join(ROOT, "site-files.json"),
  JSON.stringify({ count: files.length, totalBytes, files }, null, 1)
);

console.log(
  "site-files.json: " + files.length + " files, " +
  (totalBytes / 1048576).toFixed(1) + " MB"
);
