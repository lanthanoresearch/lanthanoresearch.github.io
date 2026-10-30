// Lanthano Research desktop app (Windows, Mac, Linux).
//
// The installer carries a complete copy of the website (the "site" folder
// is bundled at build time), so the app works with NO internet at all.
// It never replaces its own pages with ones from the internet. To get a newer
// version, install the newest installer.

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

// Pages that only belong on the website. The app never shows them, even if an
// old copy of them is somehow still lying around.
const WEBSITE_ONLY = /^\/(storage\.html|install\.html|offline-app\.js|prepare-app-bundle\.js)$/i;

// Hides every link to those pages, and the update / install cards in Settings.
const HIDE_WEBSITE_ONLY = [
  'a[href$="storage.html"]',
  'a[href$="install.html"]',
  "#updateCard",
  "#installCard",
  ".ltUpdate"
].join(",") + "{display:none !important}";

function registerProtocol() {
  protocol.handle(SCHEME, (request) => {
    try {
      const url = new URL(request.url);

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
// update folder and used them instead of the built-in ones. The app is now
// complete and offline on its own (to update, install the newest version), so
// anything left there is removed. Otherwise old pages could bring back links
// that were taken out of the app.
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
