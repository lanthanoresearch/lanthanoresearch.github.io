/*
==========================================================
LANTHANO RESEARCH: OFFLINE APP
==========================================================

All the logic for the "Offline App" option on download.html lives here,
so it can be updated without touching the page.

If this file is missing or fails to load, download.html simply keeps
working as it always did (the switcher and app panel stay hidden).

What it does, per device:
  Phone / tablet   Installs the site as an app (Android: install prompt,
                   iPhone / iPad: Add to Home Screen) and saves the whole
                   site so it opens with no internet.
  Computer         Downloads the real installer built by the GitHub Action
                   (Windows .exe, Mac .dmg, Linux .AppImage). The installed
                   app carries the whole site and works fully offline.
                   If no installer exists yet: browser install (Chrome,
                   Edge), otherwise a portable ZIP with a launcher.
==========================================================
*/

(function(){

"use strict";

var OFFLINE_CACHE_NAME = "lanthano-offline-app";
var APP_STORAGE_KEY = "lanthanoAppDownloaded";

var INSTALLER_NAMES = {
    windows: "Lanthano-Research-Setup.exe",
    mac: "Lanthano-Research.dmg",
    linux: "Lanthano-Research.AppImage"
};

var OS_LABELS = { windows: "Windows", mac: "Mac", linux: "Linux" };


function $(id){
    return document.getElementById(id);
}

/* Nothing to do if the page does not have the app panel. */
if(!$("appCard") || !$("modeSwitcher")){
    return;
}


/*
----------------------------------------------------------
STATE
----------------------------------------------------------
*/

var appBusy = false;
var appCancelled = false;
var installPrompt = null;
var appInstalled = false;
var siteData = null;
var sitePromise = null;


/*
The ZIP feature on the page keeps its own "busy" flag. Share it so that
leaving the page mid-download shows the same warning popup.
*/

function setPageGuard(on){

    try{
        archiveCompiling = on;
        allowNavigation = !on;
    }catch(e){}

}

function zipIsBusy(){

    try{
        return archiveCompiling === true && !appBusy;
    }catch(e){
        return false;
    }

}


/*
----------------------------------------------------------
DEVICE DETECTION
----------------------------------------------------------
*/

function isIOS(){

    return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
        (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

}

function isElectronApp(){
    return /electron/i.test(navigator.userAgent);
}

function isStandalone(){

    return isElectronApp() ||
        window.matchMedia("(display-mode: standalone)").matches ||
        window.matchMedia("(display-mode: window-controls-overlay)").matches ||
        window.navigator.standalone === true;

}

function isMobileDevice(){

    var ua = navigator.userAgent || "";

    if(/android|iphone|ipad|ipod|mobile/i.test(ua)){
        return true;
    }

    if(isIOS()){
        return true;
    }

    // Phones using "request desktop site" hide the usual clues.
    try{

        return window.matchMedia("(pointer: coarse)").matches &&
            navigator.maxTouchPoints > 1 &&
            Math.min(screen.width, screen.height) < 900;

    }catch(e){
        return false;
    }

}

function desktopOS(){

    var ua = navigator.userAgent || "";

    if(/cros/i.test(ua)){ return ""; }
    if(/windows/i.test(ua)){ return "windows"; }
    if(/macintosh|mac os x/i.test(ua)){ return "mac"; }
    if(/linux|x11/i.test(ua) && !/android/i.test(ua)){ return "linux"; }

    return "";

}


/*
----------------------------------------------------------
URLS
----------------------------------------------------------
*/

function fileUrl(path){

    // Only characters that would break a URL are escaped. Everything else
    // is left for the browser to normalise, exactly like <img src="...">.
    var safe = path.replace(/[%#?]/g, function(c){
        return encodeURIComponent(c);
    });

    return new URL(safe, window.location.href).href;

}


/*
----------------------------------------------------------
LIST OF EVERY FILE ON THE SITE
----------------------------------------------------------
Written by build-site-manifest.js into site-files.json.
*/

function loadSiteData(){

    if(!sitePromise){

        sitePromise = fetch("site-files.json", { cache:"no-cache" })
            .then(function(r){ return r.ok ? r.json() : null; })
            .catch(function(){ return null; })
            .then(function(data){
                siteData = data;
                return data;
            });

    }

    return sitePromise;

}

async function getSiteFiles(){

    var data = await loadSiteData();

    if(data){

        var list = Array.isArray(data) ? data : (data.files || []);

        var files = list
            .map(function(f){ return typeof f === "string" ? f : f.path; })
            .filter(Boolean);

        if(files.length){
            return files;
        }

    }

    /*
    Fallback when site-files.json does not exist yet: core pages plus
    everything referenced by descriptions.json.
    */

    var set = new Set([
        "index.html", "category.html", "discover.html",
        "research-timeline.html", "about.html", "contact.html",
        "download.html", "privacy.html", "pdf.html", "image.html", "video.html", "gallery.html", "404.html",
        "hitorahmusic.html", "manifest.json", "sw.js", "offline-app.js",
        "descriptions.json", "search-index.json", "page-counts.json",
        "fuse.basic.min.mjs", "featured-video.css", "featured-video.js",
        "assistant.css", "assistant.js", "assistant-window.js",
        "file_000000000c40722f92b1fe6758cb4855.png",
        "file_0000000007f472099da6ef16a4a6ed95.png",
        "file_00000000ecb4722f9273c2a87dca3a4c.png",
        "12615 no back.png", "predictive programming.mp4"
    ]);

    try{

        var response = await fetch("descriptions.json", { cache:"no-cache" });
        var descriptions = await response.json();

        Object.keys(descriptions).forEach(function(key){

            var paper = descriptions[key];

            if(paper.url){ set.add(paper.url); }

            set.add("covers/" + key + ".png");

            (paper.images || []).forEach(function(image){
                if(typeof image === "string" && !image.trim().startsWith("#$")){
                    set.add(image);
                }
            });

        });

    }catch(e){}

    return Array.from(set);

}

function desktopBase(){

    if(siteData && siteData.desktop && siteData.desktop.base){
        return siteData.desktop.base;
    }

    return "";

}


/*
----------------------------------------------------------
REMEMBER THE DOWNLOAD
----------------------------------------------------------
*/

function rememberApp(count){

    try{
        localStorage.setItem(APP_STORAGE_KEY, JSON.stringify({
            date: new Date().toISOString(),
            count: count
        }));
    }catch(e){}

}

function getRememberedApp(){

    try{
        return JSON.parse(localStorage.getItem(APP_STORAGE_KEY) || "null");
    }catch(e){
        return null;
    }

}


/*
----------------------------------------------------------
WHICH KIND OF APP THIS DEVICE GETS
----------------------------------------------------------
*/

function appMode(){

    if(isElectronApp()){ return "electron"; }
    if(isStandalone()){ return "standalone"; }
    if(isMobileDevice()){ return "mobile"; }

    if(desktopBase() && INSTALLER_NAMES[desktopOS()]){
        return "installer";
    }

    if(installPrompt){ return "desktop-install"; }

    return "zip";

}

function installHelpText(){

    if(isStandalone()){
        return "";
    }

    if(isIOS()){
        return "To finish installing: tap the Share button in Safari, " +
            "then \"Add to Home Screen\". (Apple does not let websites " +
            "install apps automatically.)";
    }

    if(isMobileDevice()){
        return "To finish installing: open your browser menu and choose " +
            "\"Install app\" or \"Add to Home screen\".";
    }

    if(desktopOS() === "mac" && /safari/i.test(navigator.userAgent) &&
       !/chrome|chromium|edg/i.test(navigator.userAgent)){
        return "To finish installing: in Safari choose File, then " +
            "\"Add to Dock\".";
    }

    return "To finish installing: open your browser menu and choose " +
        "\"Install\" or \"Install app\".";

}

function setupAppCard(){

    if(appBusy){
        return;
    }

    var mode = appMode();
    var os = desktopOS();
    var label = OS_LABELS[os] || "your computer";

    var title = $("appTitle");
    var desc = $("appDesc");
    var howTo = $("appHowTo");
    var button = $("appButton");

    button.style.display = "";

    if(mode === "electron"){

        title.textContent = "You are using the app";
        desc.textContent =
            "This app carries a full copy of the website, so it works " +
            "without internet. Whenever you are online it checks for new " +
            "research and updates itself.";
        howTo.textContent = "";
        button.style.display = "none";

    }else if(mode === "standalone"){

        title.textContent = "You are using the app";
        desc.textContent =
            "This app always loads the latest version of the website. " +
            "Refresh the offline copy any time to save the newest papers, " +
            "images and video for use without internet.";
        howTo.textContent = "This can take a while and uses a lot of storage.";

        if(!getRememberedApp()){
            button.textContent = "Save Offline Copy";
        }

    }else if(mode === "mobile"){

        title.textContent = "Download as a Phone App";
        desc.textContent =
            "Installs the Lanthano Research app on this device and saves " +
            "the entire website (every paper, image and video) so it " +
            "works without internet.";
        howTo.textContent =
            "This can take a while and uses a lot of storage. " +
            "Wi-Fi is recommended.";

    }else if(mode === "installer"){

        title.textContent = "Download as a Computer App";
        desc.textContent =
            "Downloads the Lanthano Research app for " + label + ". " +
            "It installs like any other program, adds a shortcut, and " +
            "carries the entire website (every paper, image and video) so " +
            "it works without internet. When you are online it updates " +
            "itself to the latest version.";

        if(os === "windows"){
            howTo.textContent =
                "Windows may show a SmartScreen notice because the app is " +
                "not code signed. Choose \"More info\", then \"Run anyway\".";
        }else if(os === "mac"){
            howTo.textContent =
                "Open the downloaded file and drag the app into Applications. " +
                "The first time, right-click the app and choose \"Open\".";
        }else{
            howTo.textContent =
                "Make the downloaded file executable (right-click, " +
                "Properties, Permissions), then run it.";
        }

    }else if(mode === "desktop-install"){

        title.textContent = "Download as a Computer App";
        desc.textContent =
            "Installs Lanthano Research on your computer with its own " +
            "window and a shortcut, and saves the entire website for use " +
            "without internet. It loads the live site, so it stays up to date.";
        howTo.textContent = "This can take a while.";

    }else{

        title.textContent = "Download as a Computer App";
        desc.textContent =
            "Creates a copy of the entire Lanthano Research website " +
            "(every paper, image and video) as an app for your computer " +
            "that works without internet.";
        howTo.textContent =
            "This can take a while. When it finishes, unzip the download and " +
            "open \"Start Lanthano Research.bat\" (Windows) or " +
            "\"start-mac-linux.command\" (Mac / Linux).";

    }

}


/*
----------------------------------------------------------
PROGRESS + RESULT DISPLAY
----------------------------------------------------------
*/

function appSetProgress(percent, text){

    var safe = Math.max(0, Math.min(100, percent));

    $("appProgress").style.display = "block";
    $("appFill").style.width = safe + "%";
    $("appPercent").textContent = Math.round(safe) + "%";
    $("appText").textContent = text;

}

function appClearFinished(){

    ["appFill", "appPercent", "appText", "appStatus"].forEach(function(id){
        $(id).classList.remove("finished");
    });

    $("appWarning").classList.remove("finished");

}

function setAppFinishedState(returning, detail, help){

    var button = $("appButton");
    var warning = $("appWarning");
    var status = $("appStatus");

    appSetProgress(100, "Done");

    ["appFill", "appPercent", "appText", "appStatus"].forEach(function(id){
        $(id).classList.add("finished");
    });

    button.disabled = false;
    button.textContent = "Download Again";

    warning.style.display = "block";
    warning.classList.add("finished");

    if(returning){

        var saved = getRememberedApp();
        var when = saved && saved.date
            ? " on " + new Date(saved.date).toLocaleDateString()
            : "";

        warning.innerHTML =
            "<strong>ALREADY DOWNLOADED</strong><br><br>" +
            "The Lanthano Research app has already been downloaded on " +
            "this device" + when + ".<br><br>" +
            "You may download it again to get the latest version.";

        status.textContent = "App already downloaded.";

    }else{

        warning.innerHTML =
            "<strong>DONE</strong><br><br>" +
            (detail || "The app has been downloaded.");

        status.textContent = "Download finished.";

    }

    $("appHelp").textContent = help || "";

}

function failedSummary(failed){

    if(!failed.length){ return ""; }

    var names = failed.slice(0, 4).map(function(path){
        return path.split("/").pop();
    });

    return " Could not fetch " + failed.length + " file(s): " +
        names.join(", ") + (failed.length > 4 ? ", and more" : "") + ".";

}


/*
----------------------------------------------------------
DOWNLOAD HELPERS
----------------------------------------------------------
*/

async function runPool(items, limit, worker){

    var next = 0;

    async function lane(){
        while(next < items.length){
            if(appCancelled){ return; }
            var index = next++;
            await worker(items[index], index);
        }
    }

    var lanes = [];
    for(var i = 0; i < limit; i++){ lanes.push(lane()); }
    await Promise.all(lanes);

}

async function fetchWithRetry(url){

    var lastError = null;

    for(var attempt = 0; attempt < 3; attempt++){

        try{

            var response = await fetch(url, { cache:"reload" });

            if(!response.ok){
                throw new Error("HTTP " + response.status);
            }

            return response;

        }catch(error){

            lastError = error;

            // A missing file will not appear by retrying.
            if(appCancelled || /HTTP 404/.test(String(error.message))){
                break;
            }

            await new Promise(function(resolve){
                setTimeout(resolve, 500 * (attempt + 1));
            });

        }

    }

    throw lastError;

}


/*
----------------------------------------------------------
LAUNCHERS FOR THE PORTABLE ZIP (last-resort option)
----------------------------------------------------------
*/

var WIN_BAT = [
    "@echo off",
    "title Lanthano Research",
    "echo Starting Lanthano Research...",
    "echo Keep this window open while you use the app. Close it to stop.",
    "powershell -NoProfile -ExecutionPolicy Bypass -File \"%~dp0server.ps1\"",
    ""
].join("\r\n");

var WIN_PS1 = [
    "$root = (Resolve-Path (Join-Path $PSScriptRoot 'site')).Path",
    "$port = 8787",
    "$listener = New-Object System.Net.HttpListener",
    "$listener.Prefixes.Add(\"http://localhost:$port/\")",
    "$listener.Start()",
    "$mime = @{",
    "  '.html'='text/html; charset=utf-8'; '.htm'='text/html; charset=utf-8'",
    "  '.js'='text/javascript'; '.mjs'='text/javascript'; '.css'='text/css'",
    "  '.json'='application/json'; '.png'='image/png'; '.jpg'='image/jpeg'",
    "  '.jpeg'='image/jpeg'; '.webp'='image/webp'; '.gif'='image/gif'",
    "  '.svg'='image/svg+xml'; '.ico'='image/x-icon'; '.pdf'='application/pdf'",
    "  '.mp4'='video/mp4'; '.webm'='video/webm'; '.mp3'='audio/mpeg'",
    "  '.txt'='text/plain'; '.webmanifest'='application/manifest+json'",
    "}",
    "Start-Process \"http://localhost:$port/\"",
    "while ($listener.IsListening) {",
    "  $ctx = $listener.GetContext()",
    "  try {",
    "    $path = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath)",
    "    if ($path -eq '/') { $path = '/index.html' }",
    "    $file = [IO.Path]::GetFullPath((Join-Path $root $path.TrimStart('/')))",
    "    if ($file.StartsWith($root) -and (Test-Path -LiteralPath $file -PathType Leaf)) {",
    "      $ext = [IO.Path]::GetExtension($file).ToLower()",
    "      $type = $mime[$ext]",
    "      if (-not $type) { $type = 'application/octet-stream' }",
    "      $bytes = [IO.File]::ReadAllBytes($file)",
    "      $ctx.Response.ContentType = $type",
    "      $ctx.Response.ContentLength64 = $bytes.Length",
    "      $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)",
    "    } else {",
    "      $ctx.Response.StatusCode = 404",
    "    }",
    "  } catch { }",
    "  try { $ctx.Response.Close() } catch { }",
    "}",
    ""
].join("\r\n");

var UNIX_SH = [
    "#!/bin/sh",
    "cd \"$(dirname \"$0\")/site\" || exit 1",
    "echo \"Starting Lanthano Research on http://localhost:8787\"",
    "echo \"Keep this window open while you use the app. Close it to stop.\"",
    "(sleep 1; (open http://localhost:8787 || xdg-open http://localhost:8787) >/dev/null 2>&1) &",
    "if command -v python3 >/dev/null 2>&1; then",
    "  python3 -m http.server 8787",
    "else",
    "  python -m http.server 8787",
    "fi",
    ""
].join("\n");

var PACKAGE_README = [
    "LANTHANO RESEARCH",
    "COMPUTER APP",
    "",
    "This folder is a complete offline copy of the Lanthano Research website.",
    "",
    "WINDOWS",
    "  1. Unzip this folder anywhere.",
    "  2. Double-click \"Start Lanthano Research.bat\".",
    "  3. Your browser opens the site. Keep the black window open while using it.",
    "",
    "MAC / LINUX",
    "  1. Unzip this folder anywhere.",
    "  2. Open a terminal in this folder and run:  chmod +x start-mac-linux.command",
    "  3. Run:  ./start-mac-linux.command   (on a Mac you can double-click it)",
    "  Requires Python 3, which is included with macOS and most Linux systems.",
    "",
    "Website: https://lanthanoresearch.com",
    ""
].join("\r\n");


/*
----------------------------------------------------------
COMPUTER INSTALLER (built by the GitHub Action)
----------------------------------------------------------
*/

function appInstallerDownload(){

    var os = desktopOS();
    var name = INSTALLER_NAMES[os];

    var link = document.createElement("a");
    link.href = desktopBase() + name;
    link.download = name;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();

    rememberApp(1);

    setAppFinishedState(
        false,
        "The installer for " + OS_LABELS[os] + " is downloading. Open it " +
        "when it finishes. It installs the app and adds a shortcut to your " +
        "computer. The app carries the whole website, works without " +
        "internet, and updates itself when you are online.",
        ""
    );

}


/*
----------------------------------------------------------
START (picks the right action for this device)
----------------------------------------------------------
*/

function appStart(){

    var mode = appMode();

    if(mode === "installer"){
        appInstallerDownload();
    }else if(mode === "zip"){
        appRun("zip");
    }else{
        appRun("cache");
    }

}


/*
----------------------------------------------------------
MAIN JOB: install + save offline copy, or portable ZIP
----------------------------------------------------------
*/

async function appRun(kind){

    if(appBusy || zipIsBusy()){
        return;
    }

    var button = $("appButton");
    var status = $("appStatus");
    var warning = $("appWarning");
    var cancelButton = $("appCancel");

    if(kind === "cache" && !("caches" in window)){
        status.textContent =
            "This browser cannot save an offline app. Try Chrome, Edge, " +
            "Safari or Firefox.";
        return;
    }

    if(kind === "zip" && typeof JSZip === "undefined"){
        status.textContent = "The ZIP library could not be loaded.";
        return;
    }


    /*
    Install FIRST, while the tap is still fresh (browsers only allow the
    install prompt right after a tap).
    */

    appInstalled = false;

    if(kind === "cache" && installPrompt){

        try{
            installPrompt.prompt();
            var choice = await installPrompt.userChoice;
            appInstalled = !!choice && choice.outcome === "accepted";
        }catch(e){}

        installPrompt = null;

    }


    appBusy = true;
    appCancelled = false;
    setPageGuard(true);

    appClearFinished();

    button.disabled = true;
    button.textContent = "Preparing App...";
    cancelButton.style.display = "inline-block";

    warning.style.display = "block";
    warning.innerHTML =
        "<strong>DO NOT CLOSE OR LEAVE THIS PAGE</strong><br><br>" +
        "The app is being prepared on your device. " +
        "Leaving this page may interrupt the process.";

    status.textContent = "";
    $("appHelp").textContent = "";

    appSetProgress(0, "Preparing: Listing every file on the site...");

    try{

        var files = await getSiteFiles();

        if(!files.length){
            throw new Error("No files were found.");
        }

        var failed = [];
        var storageFull = false;
        var done = 0;

        var zip = kind === "zip" ? new JSZip() : null;
        var cache = null;

        if(kind === "cache"){

            // Ask the browser not to throw the saved site away later.
            try{
                if(navigator.storage && navigator.storage.persist){
                    await navigator.storage.persist();
                }
            }catch(e){}

            cache = await caches.open(OFFLINE_CACHE_NAME);

            // Give the service worker a few seconds to start, but never
            // wait forever (some browsers block service workers).
            try{
                if(navigator.serviceWorker){
                    await Promise.race([
                        navigator.serviceWorker.ready,
                        new Promise(function(resolve){ setTimeout(resolve, 4000); })
                    ]);
                }
            }catch(e){}

        }

        await runPool(files, kind === "cache" ? 4 : 3, async function(path){

            var label = path.split("/").pop();

            try{

                var url = fileUrl(path);
                var response = await fetchWithRetry(url);

                if(kind === "cache"){

                    // The home page is also saved as "/" so that opening
                    // the installed app with no internet works.
                    var rootCopy = path === "index.html" ? response.clone() : null;

                    await cache.put(url, response);

                    if(rootCopy){
                        await cache.put(
                            new URL("./", window.location.href).href,
                            rootCopy
                        );
                    }

                }else{

                    var blob = await response.blob();
                    zip.file("site/" + path, blob);

                }

            }catch(error){

                failed.push(path);

                if(error && /quota/i.test(String(error.name) + String(error.message))){
                    storageFull = true;
                }

            }

            done++;

            appSetProgress(
                (done / files.length) * (kind === "zip" ? 90 : 100),
                "Compiling: " + label + " (" + done + " of " + files.length + ")"
            );

        });

        if(appCancelled){
            throw new Error("__APP_CANCELLED__");
        }

        if(storageFull){
            throw new Error(
                "This device ran out of storage space. Free some space " +
                "and try again."
            );
        }

        if(failed.length === files.length){
            throw new Error(
                "Could not reach the site. Check your connection and try again."
            );
        }


        var detail;
        var help = "";

        if(kind === "cache"){

            if(isStandalone()){
                detail = "The offline copy has been refreshed.";
            }else if(appInstalled){
                detail = "The app has been installed and the whole site " +
                    "has been saved to this device. Open it from your " +
                    (isMobileDevice()
                        ? "home screen or app list."
                        : "desktop, Start menu or Dock.") +
                    " It works without internet.";
            }else{
                detail = "The whole site has been saved to this device and " +
                    "works without internet.";
                help = installHelpText();
            }

        }else{

            zip.file("Start Lanthano Research.bat", WIN_BAT);
            zip.file("server.ps1", WIN_PS1);
            zip.file("start-mac-linux.command", UNIX_SH, { unixPermissions: "755" });
            zip.file("README.txt", PACKAGE_README);

            if(failed.length){
                zip.file("DOWNLOAD-ERRORS.txt",
                    "Some files could not be downloaded.\r\n\r\n" + failed.join("\r\n"));
            }

            appSetProgress(90, "Compiling: App package");

            var blobZip = await zip.generateAsync(
                {
                    type:"blob",
                    platform:"UNIX",
                    compression:"DEFLATE",
                    compressionOptions:{ level:6 }
                },
                function(meta){
                    if(!appCancelled){
                        appSetProgress(90 + meta.percent * 0.10, "Compiling: App package");
                    }
                }
            );

            if(appCancelled){
                throw new Error("__APP_CANCELLED__");
            }

            button.textContent = "Starting Download...";

            var href = URL.createObjectURL(blobZip);
            var link = document.createElement("a");
            link.href = href;
            link.download = "Lanthano-Research-App.zip";
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(function(){ URL.revokeObjectURL(href); }, 10000);

            detail = "The app has been created and the download has been " +
                "sent to your browser. Unzip it and open the launcher inside.";

        }

        detail += failedSummary(failed);

        rememberApp(files.length - failed.length);

        appBusy = false;
        setPageGuard(false);
        cancelButton.style.display = "none";

        setAppFinishedState(false, detail, help);

    }catch(error){

        appBusy = false;
        setPageGuard(false);
        cancelButton.style.display = "none";

        button.disabled = false;

        if(error.message === "__APP_CANCELLED__"){

            if(getRememberedApp()){
                setAppFinishedState(true);
            }else{
                button.textContent = "Download App";
                warning.style.display = "none";
                $("appProgress").style.display = "none";
                status.textContent = "App download cancelled.";
            }

            return;

        }

        console.error(error);

        if(getRememberedApp()){
            setAppFinishedState(true);
            status.textContent = error.message || "Something went wrong.";
            return;
        }

        button.textContent = "Download App";
        appSetProgress(0, "Preparing: App download failed");

        warning.classList.remove("finished");
        warning.innerHTML =
            "<strong>APP DOWNLOAD FAILED</strong><br><br>" +
            "The app was not completed. You can try again.";

        status.textContent = error.message || "Something went wrong.";

    }

}


/*
----------------------------------------------------------
MODE SWITCHER (Research ZIP  <->  Offline App)
----------------------------------------------------------
*/

function setMode(mode){

    if(appBusy || zipIsBusy()){
        return;
    }

    var zipCard = document.querySelector(".download-section:not(#appCard)");
    var appCard = $("appCard");
    var switcher = $("modeSwitcher");

    if(!zipCard){
        return;
    }

    var showApp = mode === "app";

    switcher.classList.toggle("right", showApp);
    $("modeZip").classList.toggle("active", !showApp);
    $("modeApp").classList.toggle("active", showApp);

    var target = showApp ? appCard : zipCard;
    var other = showApp ? zipCard : appCard;

    other.style.display = "none";
    target.style.display = "block";
    target.classList.remove("panel-enter");
    void target.offsetWidth;
    target.classList.add("panel-enter");

    try{ sessionStorage.setItem("supportMode", mode); }catch(e){}

}


/*
----------------------------------------------------------
INSTALL PROMPT + SERVICE WORKER
----------------------------------------------------------
*/

if("serviceWorker" in navigator && location.protocol !== "file:" &&
   !isElectronApp()){
    navigator.serviceWorker.register("sw.js").catch(function(){});
}

window.addEventListener("beforeinstallprompt", function(e){
    e.preventDefault();
    installPrompt = e;
    setupAppCard();
});

window.addEventListener("appinstalled", function(){
    appInstalled = true;
    installPrompt = null;
});


/*
----------------------------------------------------------
START UP
----------------------------------------------------------
*/

$("modeZip").addEventListener("click", function(){ setMode("zip"); });
$("modeApp").addEventListener("click", function(){ setMode("app"); });
$("appButton").addEventListener("click", appStart);
$("appCancel").addEventListener("click", function(){ appCancelled = true; });

// The switcher stays hidden until everything above has loaded.
$("modeSwitcher").style.display = "flex";

setupAppCard();

loadSiteData().then(setupAppCard);

if(getRememberedApp() && !isElectronApp()){
    setAppFinishedState(true);
}

try{
    if(sessionStorage.getItem("supportMode") === "app"){
        setMode("app");
    }
}catch(e){}

})();
