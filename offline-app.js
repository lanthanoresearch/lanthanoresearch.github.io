/*
==========================================================
LANTHANO RESEARCH: INSTALL THE APP
==========================================================

The logic for install.html. Install turns the whole website into a real app:

  Windows   Lanthano-Research-Setup.exe   (built by the GitHub Action)
  Mac       Lanthano-Research.dmg
  Linux     Lanthano-Research.AppImage
  Android   Lanthano-Research.apk         (built by android-app.yml)
  iPhone / iPad: not offered. The page and its links are hidden there.

Installers are published as GitHub releases. site-files.json says where the
computer installers are (desktop.base). The Android app sits in the
"android-latest" release of the same repository.

This is different from the other two things on the site:
  Download   zips of files and media (download.html and the viewers)
  Save       copies the browser keeps so things open without loading
             again (storage.html)
==========================================================
*/

(function(){

"use strict";

var INSTALLERS = {
    windows: { file: "Lanthano-Research-Setup.exe", label: "Windows" },
    mac:     { file: "Lanthano-Research.dmg",       label: "Mac" },
    linux:   { file: "Lanthano-Research.AppImage",  label: "Linux" },
    android: { file: "Lanthano-Research.apk",       label: "Android" }
};
var ORDER = ["windows", "mac", "linux", "android"];

function $(id){ return document.getElementById(id); }

if(!$("appCard")){ return; }


/* ---------- Which device is this? ---------- */

function isIOS(){
    return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
        (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}
function isElectronApp(){ return /electron/i.test(navigator.userAgent); }
function isAppWindow(){
    return isElectronApp() ||
        window.matchMedia("(display-mode: standalone)").matches ||
        window.matchMedia("(display-mode: window-controls-overlay)").matches ||
        window.navigator.standalone === true;
}
function thisDevice(){
    var ua = navigator.userAgent || "";
    if(isIOS()){ return "ios"; }
    if(/android/i.test(ua)){ return "android"; }
    if(/cros/i.test(ua)){ return ""; }
    if(/windows/i.test(ua)){ return "windows"; }
    if(/macintosh|mac os x/i.test(ua)){ return "mac"; }
    if(/linux|x11/i.test(ua)){ return "linux"; }
    return "";
}


/* ---------- Where the installers are ---------- */

var found = {};   // device -> {url, size}

function loadSiteData(){
    return fetch("site-files.json", { cache: "no-cache" })
        .then(function(r){ return r.ok ? r.json() : null; })
        .catch(function(){ return null; });
}

/* Android lives in its own release in the same repository, so the address is
   worked out from the computer one, and the release is checked through the
   GitHub API (which allows this page to ask). */
async function findAndroid(desktopBase){
    var m = /github\.com\/([^\/]+)\/([^\/]+)\/releases\/download\//.exec(desktopBase || "");
    if(!m){ return null; }
    try{
        var r = await fetch("https://api.github.com/repos/" + m[1] + "/" + m[2] + "/releases/tags/android-latest");
        if(!r.ok){ return null; }
        var rel = await r.json();
        var asset = (rel.assets || []).filter(function(a){ return a.name === INSTALLERS.android.file; })[0];
        if(!asset){ return null; }
        return { url: asset.browser_download_url, size: asset.size || 0 };
    }catch(e){
        return null;
    }
}

async function findInstallers(){
    var data = await loadSiteData();
    var base = data && data.desktop && data.desktop.base;
    if(base){
        ["windows", "mac", "linux"].forEach(function(os){
            found[os] = { url: base + INSTALLERS[os].file, size: 0 };
        });
    }
    var apk = await findAndroid(base);
    if(apk){ found.android = apk; }
}


/* ---------- What to tell people ---------- */

var HOWTO = {
    windows: "Open the file when it finishes downloading. Windows may show a SmartScreen notice because the app is not code signed. Choose “More info”, then “Run anyway”.",
    mac: "Open the file and drag the app into Applications. The first time, right-click the app and choose “Open”.",
    linux: "Make the file executable (right-click, Properties, Permissions), then run it.",
    android: "Open the file when it finishes downloading. Android asks you to allow installs from this browser. Allow it, then tap Install. Google Play Protect may show a notice because the app is not from the Play Store."
};

function sizeText(n){
    if(!n){ return ""; }
    return n >= 1e9 ? (n / 1e9).toFixed(2) + " GB" : n >= 1e6 ? Math.round(n / 1e6) + " MB" : Math.round(n / 1e3) + " KB";
}

function startDownload(device){
    var item = found[device], file = INSTALLERS[device].file;
    if(!item){ return; }
    var a = document.createElement("a");
    a.href = item.url;
    a.download = file;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    $("appStatus").textContent = "The " + INSTALLERS[device].label + " app is on its way. " + HOWTO[device];
}

function paintOthers(me){
    var rows = ORDER.filter(function(d){ return d !== me && found[d]; });
    var box = $("otherCard");
    if(!rows.length){ box.hidden = true; return; }
    box.hidden = false;
    var list = $("otherList");
    list.innerHTML = "";
    rows.forEach(function(d){
        var row = document.createElement("div");
        row.className = "row";
        row.innerHTML = '<div class="name"></div><div class="size"></div>';
        row.firstChild.textContent = INSTALLERS[d].label;
        row.lastChild.textContent = sizeText(found[d].size);
        var b = document.createElement("button");
        b.type = "button";
        b.className = "small";
        b.textContent = "Get";
        b.addEventListener("click", function(){ startDownload(d); });
        row.appendChild(b);
        list.appendChild(row);
    });
}

async function setup(){
    var title = $("appTitle"), desc = $("appDesc"), how = $("appHowTo"), btn = $("appButton");
    var me = thisDevice();

    if(me === "ios"){
        $("pageBody").hidden = true;
        $("iosNote").hidden = false;
        return;
    }
    if(isElectronApp()){
        title.textContent = "You are using the app";
        desc.textContent = "This app carries the whole website, so it works without internet. When you are online it checks for new research and updates itself.";
        btn.hidden = true;
        $("otherCard").hidden = true;
        return;
    }
    if(isAppWindow()){
        title.textContent = "You are using the app";
        desc.textContent = "This is already running as an app, so there is nothing more to install here.";
        btn.hidden = true;
        $("otherCard").hidden = true;
        return;
    }

    btn.disabled = true;
    btn.textContent = "Checking…";
    await findInstallers();

    if(me && INSTALLERS[me]){
        var label = INSTALLERS[me].label;
        title.textContent = "Install on " + label;
        if(found[me]){
            desc.textContent = "Installs the Lanthano Research app on your " + (me === "android" ? "phone" : "computer") +
                ". The whole website (every paper, image and video) is inside the app, so it works without internet. " +
                (me === "android" ? "To update, install the newest version from this page." : "When you are online it updates itself.");
            how.textContent = HOWTO[me];
            btn.textContent = "Install for " + label + (found[me].size ? " (" + sizeText(found[me].size) + ")" : "");
            btn.disabled = false;
            btn.onclick = function(){ startDownload(me); };
        }else{
            desc.textContent = "The " + label + " app has not been published yet. It is built automatically by the site, so check back soon.";
            how.textContent = "";
            btn.hidden = true;
        }
    }else{
        title.textContent = "Install the app";
        desc.textContent = "There is no app for this device. Apps are available for Windows, Mac, Linux and Android.";
        how.textContent = "";
        btn.hidden = true;
    }
    paintOthers(me);
}

setup();

})();
