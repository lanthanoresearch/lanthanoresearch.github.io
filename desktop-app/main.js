// Lanthano Research desktop app (Windows, Mac, Linux).
//
// The installer carries a complete copy of the website (the "site" folder
// is bundled at build time), so the app works with NO internet at all.
// Whenever it is online it also checks the live website and downloads
// anything new or changed into a separate update folder, which is used
// in preference to the bundled copy.

const { app, BrowserWindow, Menu, net, protocol, shell } = require("electron");
const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");

const SITE = "https://lanthanoresearch.com/";
const SCHEME = "lanthano";
const START_URL = SCHEME + "://app/index.html";

// Must run before the app is ready. "standard" + "secure" make the site
// behave like a normal https website (modules, fetch, localStorage).
protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true
    }
  }
]);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf"
};

let mainWindow = null;
let startedAt = Date.now();

function bundledDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "site")
    : path.join(__dirname, "site");
}

function updatesDir() {
  return path.join(app.getPath("userData"), "site-updates");
}

// ---------------------------------------------------------------- files

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch (e) {
    return false;
  }
}

// Finds a requested path in the update folder first, then the bundled copy.
function resolveFile(urlPath) {
  let rel;

  try {
    rel = decodeURIComponent(urlPath);
  } catch (e) {
    return null;
  }

  rel = rel.replace(/^\/+/, "");
  if (rel === "" || rel.endsWith("/")) rel += "index.html";

  for (const base of [updatesDir(), bundledDir()]) {
    const full = path.resolve(base, rel);

    // Never leave the site folder.
    if (full !== base && !full.startsWith(base + path.sep)) continue;

    if (isFile(full)) return full;
  }

  return null;
}

function serveFile(file, request) {
  const size = fs.statSync(file).size;
  const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";

  const headers = {
    "Content-Type": type,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-cache"
  };

  const head = request.method === "HEAD";
  const range = request.headers.get("range");
  const match = range && /bytes=(\d*)-(\d*)/.exec(range);

  if (match && size > 0) {
    let start = match[1] ? parseInt(match[1], 10) : 0;
    let end = match[2] ? parseInt(match[2], 10) : size - 1;

    if (!match[1] && match[2]) {
      start = Math.max(0, size - parseInt(match[2], 10));
      end = size - 1;
    }

    end = Math.min(end, size - 1);

    if (start > end || start >= size) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": "bytes */" + size }
      });
    }

    headers["Content-Range"] = "bytes " + start + "-" + end + "/" + size;
    headers["Content-Length"] = String(end - start + 1);

    return new Response(
      head ? null : Readable.toWeb(fs.createReadStream(file, { start, end })),
      { status: 206, headers }
    );
  }

  headers["Content-Length"] = String(size);

  return new Response(
    head || size === 0 ? null : Readable.toWeb(fs.createReadStream(file)),
    { status: 200, headers }
  );
}

function registerProtocol() {
  protocol.handle(SCHEME, (request) => {
    try {
      const url = new URL(request.url);
      const file = resolveFile(url.pathname);

      if (file) return serveFile(file, request);

      // Unknown page: show the site's own 404 page if it has one.
      const notFound = resolveFile("/404.html");

      if (notFound && request.headers.get("accept") &&
          request.headers.get("accept").includes("text/html")) {
        const response = serveFile(notFound, request);
        return new Response(response.body, {
          status: 404,
          headers: response.headers
        });
      }
    } catch (e) {}

    return new Response("Not found", { status: 404 });
  });
}

// ---------------------------------------------------------- live updates

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return null;
  }
}

function encodePath(p) {
  return p
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

// Downloads anything new or changed on the live site into the update folder.
async function updateFromLive() {
  try {
    const response = await net.fetch(SITE + "site-files.json?t=" + Date.now(), {
      cache: "no-store"
    });

    if (!response.ok) return 0;

    const remote = await response.json();
    const list = (Array.isArray(remote) ? remote : remote.files || []).filter(
      (f) => f && typeof f === "object" && f.path && f.hash
    );

    if (!list.length) return 0;

    const dir = updatesDir();
    fs.mkdirSync(dir, { recursive: true });

    const stateFile = path.join(dir, "state.json");
    const state = readJson(stateFile) || { hashes: {} };

    // What the installer shipped with.
    const bundled = readJson(path.join(bundledDir(), "site-files.json"));
    const bundledHashes = {};

    ((bundled && bundled.files) || []).forEach((f) => {
      if (f && f.path && f.hash) bundledHashes[f.path] = f.hash;
    });

    const todo = list.filter(
      (f) =>
        state.hashes[f.path] !== f.hash &&
        !(bundledHashes[f.path] === f.hash && !state.hashes[f.path])
    );

    let changed = 0;
    let index = 0;

    async function lane() {
      while (index < todo.length) {
        const f = todo[index++];

        try {
          const r = await net.fetch(SITE + encodePath(f.path), {
            cache: "reload"
          });

          if (!r.ok) continue;

          const bytes = Buffer.from(await r.arrayBuffer());
          const target = path.join(dir, f.path);

          fs.mkdirSync(path.dirname(target), { recursive: true });

          // Write to a temporary name first so a half-finished download
          // is never used.
          fs.writeFileSync(target + ".part", bytes);
          fs.renameSync(target + ".part", target);

          state.hashes[f.path] = f.hash;
          changed++;
        } catch (e) {
          // Try again next launch.
        }
      }
    }

    await Promise.all([lane(), lane(), lane()]);

    // Keep the new list so the next launch knows what is current.
    fs.writeFileSync(path.join(dir, "site-files.json"), JSON.stringify(remote));
    fs.writeFileSync(stateFile, JSON.stringify(state));

    return changed;
  } catch (e) {
    return 0; // offline: keep using what is already on this computer
  }
}

// ---------------------------------------------------------------- window

function isAppUrl(url) {
  return url.startsWith(SCHEME + "://");
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 380,
    minHeight: 500,
    backgroundColor: "#111111",
    autoHideMenuBar: true,
    title: "Lanthano Research",
    icon: path.join(__dirname, "build", "icon.png"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  Menu.setApplicationMenu(null);

  // Links to other websites open in the normal browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url)) return { action: "allow" };
    if (/^https?:|^mailto:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isAppUrl(url)) {
      event.preventDefault();
      if (/^https?:|^mailto:/i.test(url)) shell.openExternal(url);
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.loadURL(START_URL);
}

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    app.setAppUserModelId("com.lanthano.research");

    registerProtocol();
    createWindow();

    // Check the live site in the background. If it finished quickly
    // after launch (nothing is being read yet), show the new version now;
    // otherwise it appears the next time the app starts.
    updateFromLive().then((changed) => {
      if (changed > 0 && mainWindow && Date.now() - startedAt < 45000) {
        mainWindow.webContents.reloadIgnoringCache();
      }
    });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    app.quit();
  });
}
