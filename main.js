// Lanthano Research desktop app (Windows, Mac, Linux).
//
// The installer carries a complete copy of the website (the "site" folder
// is bundled at build time), so the app works with NO internet at all.
// It never replaces its own pages with ones from the internet by itself.
// "Update" in Settings can fetch newer files from the website when the person
// asks (see app-update.js): they are kept in a separate folder next to the
// app's own files, and a newer installer always starts again from its own files.

const { app, BrowserWindow, Menu, protocol, session, shell } = require("electron");
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
      corsEnabled: true,
      allowServiceWorkers: true
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

function bundledDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "site")
    : path.join(__dirname, "site");
}

// The folder of files fetched by "Update" in Settings. A file here is used
// instead of the app's own copy.
function patchDir() {
  return path.join(app.getPath("userData"), "site-patch");
}

// The OLD live updater's folder (from earlier versions). It is always deleted.
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

  // A file the website no longer has and that "Update" removed.
  if (removedFiles.has(rel)) return null;

  for (const base of [patchDir(), bundledDir()]) {
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

// ------------------------------------------------------------ Update store
//
// "Update" in Settings fetches files from the website in the page itself and
// hands them to the app here (lanthano://app/__patch/...). Only the app's own
// pages can reach this address.

let removedFiles = new Set();

// Lockdown (ON unless the person turned it off in Settings): nothing may change
// the app's files and the app makes no connections to the internet at all.
let lockdown = true;

function lockFile() {
  return path.join(app.getPath("userData"), "lockdown.json");
}

function loadLockdown() {
  try {
    lockdown = JSON.parse(fs.readFileSync(lockFile(), "utf8")).locked !== false;
  } catch (e) {
    lockdown = true;
  }
}

function saveLockdown(on) {
  lockdown = !!on;
  try {
    fs.mkdirSync(path.dirname(lockFile()), { recursive: true });
    fs.writeFileSync(lockFile(), JSON.stringify({ locked: lockdown }));
  } catch (e) {}
}

// While Lockdown is on, every request to the internet is stopped. The app's own
// pages (lanthano://) are never affected.
function applyLockdown() {
  try {
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] },
      (details, callback) => callback({ cancel: lockdown })
    );
  } catch (e) {}
}

function removedList() {
  return path.join(patchDir(), ".removed.json");
}

function loadRemoved() {
  try {
    removedFiles = new Set(JSON.parse(fs.readFileSync(removedList(), "utf8")));
  } catch (e) {
    removedFiles = new Set();
  }
}

function saveRemoved() {
  fs.mkdirSync(patchDir(), { recursive: true });
  fs.writeFileSync(removedList(), JSON.stringify([...removedFiles]));
}

// A newer installer has newer files of its own than anything fetched earlier,
// so the fetched files are dropped when the app's build changes.
function resetPatchForNewBuild() {
  let build = "";

  try {
    build = JSON.parse(fs.readFileSync(path.join(bundledDir(), "app-build.json"), "utf8")).build || "";
  } catch (e) {}

  const baseFile = path.join(patchDir(), ".base");
  let had = "";

  try {
    had = fs.readFileSync(baseFile, "utf8");
  } catch (e) {}

  if (had !== build) {
    try {
      fs.rmSync(patchDir(), { recursive: true, force: true });
    } catch (e) {}
    if (build) {
      fs.mkdirSync(patchDir(), { recursive: true });
      fs.writeFileSync(baseFile, build);
    }
  }

  loadRemoved();
}

// A clean relative path, or null.
function cleanRel(p) {
  if (typeof p !== "string") return null;
  const rel = p.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!rel || rel.split("/").some((part) => part === ".." || part === "." || part === "" || part.startsWith("."))) return null;
  return rel;
}

function listPatchFiles(dir, prefix, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) listPatchFiles(path.join(dir, entry.name), prefix + entry.name + "/", out);
    else out.push(prefix + entry.name);
  }
  return out;
}

async function handlePatch(request, url) {
  const json = (data, status) => new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
  const action = url.pathname.slice("/__patch/".length);
  const rel = cleanRel(url.searchParams.get("p"));

  try {
    if (action === "state") {
      let files = [];
      try { files = listPatchFiles(patchDir(), "", []); } catch (e) {}
      return json({ files, removed: [...removedFiles] });
    }

    if (action === "lockdown" && request.method !== "POST") return json({ locked: lockdown });

    if (request.method !== "POST") return json({ error: "POST only" }, 405);

    if (action === "lockdown") {
      saveLockdown(url.searchParams.get("p") !== "off");
      return json({ locked: lockdown });
    }

    // Nothing can touch the app's files while Lockdown is on.
    if (lockdown) return json({ error: "lockdown" }, 403);

    if (action === "put" && rel) {
      const target = path.resolve(patchDir(), rel);
      if (!target.startsWith(patchDir() + path.sep)) return json({ error: "bad path" }, 400);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.from(await request.arrayBuffer()));
      if (removedFiles.delete(rel)) saveRemoved();
      return json({ ok: true });
    }

    if (action === "remove" && rel) {
      const target = path.resolve(patchDir(), rel);
      if (target.startsWith(patchDir() + path.sep)) fs.rmSync(target, { force: true });
      removedFiles.add(rel);
      saveRemoved();
      return json({ ok: true });
    }

    if (action === "reset") {
      fs.rmSync(patchDir(), { recursive: true, force: true });
      removedFiles = new Set();
      resetPatchForNewBuild();
      return json({ ok: true });
    }
  } catch (e) {
    return json({ error: String(e && e.message || e) }, 500);
  }

  return json({ error: "unknown" }, 404);
}

// Pages that only belong on the website. The app never shows them, even if an
// old copy of them is somehow still lying around.
const WEBSITE_ONLY = /^\/(install\.html|offline-app\.js|prepare-app-bundle\.js)$/i;

// Hides every link to those pages, and the update / install cards in Settings.
const HIDE_WEBSITE_ONLY = [
  'a[href$="install.html"]',
  "#updateCard",
  "#installCard",
  ".ltUpdate"
].join(",") + "{display:none !important}" +
  // Storage keeps only its Backup & restore card.
  "body:has(#bkExport) .card:not(:has(#bkExport)){display:none !important}";

function registerProtocol() {
  protocol.handle(SCHEME, (request) => {
    try {
      const url = new URL(request.url);

      if (url.pathname.startsWith("/__patch/")) return handlePatch(request, url);

      if (WEBSITE_ONLY.test(url.pathname)) {
        return new Response("Not found", { status: 404 });
      }
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

// ------------------------------------------------------- old update folder

// Earlier versions of the app copied newer pages from the website into an
// update folder by themselves and used them instead of the built-in ones.
// That is gone (updating now only happens when the person asks, and goes
// through the page's own "Update" with every file checked), so anything left
// there is removed. Otherwise old pages could bring back links that were taken
// out of the app.
function clearOldUpdates() {
  try {
    fs.rmSync(updatesDir(), { recursive: true, force: true });
  } catch (e) {}
}

// ---------------------------------------------------------- video server

// The videos come from the video server, which only answers requests that come
// from the website (https://lanthanoresearch.com). Pages inside the app live at
// lanthano://app, so the request is sent as if it came from the website, and
// the answer is allowed through to the app's pages. The server itself is not
// changed in any way.
function allowVideoServer() {
  const filter = { urls: ["https://videos.lanthanoresearch.com/*"] };
  const ses = session.defaultSession;

  ses.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    const headers = details.requestHeaders;
    headers["Origin"] = "https://lanthanoresearch.com";
    headers["Referer"] = "https://lanthanoresearch.com/";
    callback({ requestHeaders: headers });
  });

  ses.webRequest.onHeadersReceived(filter, (details, callback) => {
    const headers = {};

    Object.keys(details.responseHeaders || {}).forEach((name) => {
      if (!/^access-control-/i.test(name)) headers[name] = details.responseHeaders[name];
    });

    headers["Access-Control-Allow-Origin"] = [SCHEME + "://app"];
    headers["Access-Control-Allow-Methods"] = ["GET, HEAD, POST, OPTIONS"];
    headers["Access-Control-Allow-Headers"] = ["*"];
    headers["Access-Control-Expose-Headers"] = ["*"];

    const answer = { responseHeaders: headers };
    if (details.method === "OPTIONS") answer.statusLine = "HTTP/1.1 204 No Content";
    callback(answer);
  });
}

// ---------------------------------------------------------------- window

function isAppUrl(url) {
  return url.startsWith(SCHEME + "://");
}

function history() {
  return mainWindow && mainWindow.webContents;
}

function goBack() {
  const wc = history();
  if (!wc) return;
  if (wc.navigationHistory) {
    if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  } else if (wc.canGoBack()) {
    wc.goBack();
  }
}

function goForward() {
  const wc = history();
  if (!wc) return;
  if (wc.navigationHistory) {
    if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  } else if (wc.canGoForward()) {
    wc.goForward();
  }
}

// The menu is kept out of sight (press Alt on Windows / Linux to show it) but
// it is what makes the usual keyboard shortcuts work: copy, paste, select all,
// zoom, reload, full screen, Back and Forward.
function buildMenu() {
  const mac = process.platform === "darwin";

  const template = [
    ...(mac ? [{ role: "appMenu" }] : []),
    {
      label: "File",
      submenu: [mac ? { role: "close" } : { role: "quit" }]
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" }
      ]
    },
    {
      label: "Go",
      submenu: [
        {
          label: "Back",
          accelerator: mac ? "Cmd+[" : "Alt+Left",
          click: goBack
        },
        {
          label: "Forward",
          accelerator: mac ? "Cmd+]" : "Alt+Right",
          click: goForward
        },
        {
          label: "Home",
          accelerator: mac ? "Cmd+Shift+H" : "Alt+Home",
          click: () => {
            if (mainWindow) mainWindow.loadURL(START_URL);
          }
        }
      ]
    },
    { role: "windowMenu" }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 380,
    minHeight: 500,
    backgroundColor: "#111111",
    autoHideMenuBar: true,
    title: "Lanthano Research Offline",
    icon: path.join(__dirname, "build", "icon.png"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  buildMenu();

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

  // Mouse Back / Forward buttons (Windows) and two-finger swipes (Mac).
  mainWindow.on("app-command", (event, command) => {
    if (command === "browser-backward") goBack();
    else if (command === "browser-forward") goForward();
  });

  mainWindow.on("swipe", (event, direction) => {
    if (direction === "left") goBack();
    else if (direction === "right") goForward();
  });

  mainWindow.webContents.on("dom-ready", () => {
    mainWindow.webContents.insertCSS(HIDE_WEBSITE_ONLY).catch(() => {});
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

    clearOldUpdates();
    resetPatchForNewBuild();
    loadLockdown();
    applyLockdown();
    registerProtocol();
    allowVideoServer();
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    app.quit();
  });
}
