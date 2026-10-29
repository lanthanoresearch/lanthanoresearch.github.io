/*
==========================================================
LANTHANO RESEARCH: INSTALL THE APP
==========================================================

The logic for install.html. Install turns the whole website into a real app
that has every file inside it and works with no internet at all:

  Windows   Lanthano-Research-Setup.exe   (built by the GitHub Action)
  Mac       Lanthano-Research.dmg
  Linux     Lanthano-Research.AppImage
  Android   Lanthano-Research.apk         (built by android-app.yml)
  iPhone / iPad   Apple does not allow apps to be made this way, so this
                  page shows how to add the website to the Home Screen.

The page never tries to work out whether it is already running inside an app.
It always shows what can be installed for the device it is opened on.

Installers are published as GitHub releases. site-files.json says where the
computer installers are (desktop.base). The Android app sits in the
"android-latest" release of the same repository.

Like the archive on the Download page, the page remembers that you installed
the app on this device and says so next time, while still letting you install
it again to get the newest version.
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
var REMEMBER_KEY = "lanthanoAppInstalled";

function $(id){ return document.getElementById(id); }

if(!$("appCard")){ return; }


/* ---------- Which device is this? ---------- */

function thisDevice(){
    var ua = navigator.userAgent || "";
    if(/iphone|ipad|ipod/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)){ return "ios"; }
    if(/android/i.test(ua)){ return "android"; }
    if(/cros/i.test(ua)){ return ""; }
    if(/windows/i.test(ua)){ return "windows"; }
    if(/macintosh|mac os x/i.test(ua)){ return "mac"; }
    if(/linux|x11/i.test(ua)){ return "linux"; }
    return "";
}


/* ---------- Remembering that it was installed here ---------- */

function recall(){
    try{ return JSON.parse(localStorage.getItem(REMEMBER_KEY) || "null"); }catch(e){ return null; }
}
function remember(device){
    try{ localStorage.setItem(REMEMBER_KEY, JSON.stringify({ device: device, date: new Date().toISOString() })); }catch(e){}
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
    android: "Open the file when it finishes downloading. Android asks you to allow installs from this browser. Allow it, then tap Install. Google Play Protect may show a notice because the app is not from the Play Store. To update later, delete the app and install the newest version from here."
};

function sizeText(n){
    if(!n){ return ""; }
    return n >= 1e9 ? (n / 1e9).toFixed(2) + " GB" : n >= 1e6 ? Math.round(n / 1e6) + " MB" : Math.round(n / 1e3) + " KB";
}

/* Like the Download page: once Install is pressed there is a short stretch
   where everything is put together, and it can be cancelled. Nothing is
   downloaded or remembered until that stretch finishes. */
var prep = null;   // the install being prepared, if any

function setPrep(pct, text){
    $("prepFill").style.width = pct + "%";
    $("prepPct").textContent = Math.round(pct) + "%";
    if(text){ $("prepText").textContent = text; }
}

function wait(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }

async function startDownload(device, forThisDevice){
    if(prep){ return; }
    var job = { cancelled: false };
    prep = job;
    var btn = $("appButton");
    $("appStatus").textContent = "";
    $("appPrep").hidden = false;
    btn.disabled = true;
    var rows = document.querySelectorAll("#otherList button");
    rows.forEach(function(b){ b.disabled = true; });
    setPrep(0, "Putting everything together\u2026");

    function stopped(){
        if(!job.cancelled){ return false; }
        $("appPrep").hidden = true;
        btn.disabled = false;
        rows.forEach(function(b){ b.disabled = false; });
        $("appStatus").textContent = "Cancelled. Nothing was installed.";
        prep = null;
        return true;
    }
    $("prepCancel").onclick = function(){ job.cancelled = true; stopped(); };

    // 1. find the newest version
    setPrep(10, "Finding the newest version\u2026");
    var data = await loadSiteData();
    if(job.cancelled){ return; }
    if(device === "android"){
        var apk = await findAndroid(data && data.desktop && data.desktop.base);
        if(apk){ found.android = apk; }
    }else if(data && data.desktop && data.desktop.base){
        found[device] = { url: data.desktop.base + INSTALLERS[device].file, size: (found[device] && found[device].size) || 0 };
    }
    if(job.cancelled){ return; }

    // 2. a few steps so there is time to change your mind
    var steps = [
        [35, "Putting everything together\u2026"],
        [60, "Getting the " + INSTALLERS[device].label + " app ready\u2026"],
        [85, "Almost done\u2026"],
        [100, "Starting the download\u2026"]
    ];
    for(var i = 0; i < steps.length; i++){
        setPrep(steps[i][0], steps[i][1]);
        await wait(900);
        if(job.cancelled){ return; }
    }

    // 3. hand the file to the browser
    var item = found[device];
    $("appPrep").hidden = true;
    btn.disabled = false;
    rows.forEach(function(b){ b.disabled = false; });
    prep = null;
    if(!item){
        $("appStatus").textContent = "The " + INSTALLERS[device].label + " app is not available right now. Try again soon.";
        return;
    }
    var a = document.createElement("a");
    a.href = item.url;
    a.download = INSTALLERS[device].file;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    $("appStatus").textContent = "The " + INSTALLERS[device].label + " app is on its way. " + HOWTO[device];
    if(forThisDevice){
        remember(device);
        paintAlready(device);
    }
}

/* "ALREADY INSTALLED", the same idea as "ALREADY DOWNLOADED" on the Download page. */
function paintAlready(me){
    var box = $("appAlready"), rec = recall();
    if(!rec || rec.device !== me){ box.hidden = true; return; }
    var when = rec.date ? new Date(rec.date).toLocaleDateString() : "";
    $("appAlreadyText").textContent = "You installed the app on this device" + (when ? " on " + when : "") +
        ". You can install it again to get the latest version.";
    box.hidden = false;
    $("appButton").textContent = "Install Again";
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
        b.addEventListener("click", function(){ startDownload(d, false); });
        row.appendChild(b);
        list.appendChild(row);
    });
}

async function setup(){
    var title = $("appTitle"), desc = $("appDesc"), how = $("appHowTo"), btn = $("appButton");
    var me = thisDevice();

    if(me === "ios"){
        $("appCard").hidden = true;
        $("iosCard").hidden = false;
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
                ". The whole website (every paper, image and video it holds) is inside the app, so it works with no internet at all. " +
                (me === "android" ? "To update, delete the app and install the newest version." : "When you are online it updates itself.");
            how.textContent = HOWTO[me];
            btn.textContent = "Install for " + label + (found[me].size ? " (" + sizeText(found[me].size) + ")" : "");
            btn.disabled = false;
            btn.onclick = function(){ startDownload(me, true); };
            paintAlready(me);
        }else{
            desc.textContent = "The " + label + " app has not been published yet. It is built automatically, so check back soon.";
            how.textContent = "";
            btn.hidden = true;
        }
    }else{
        title.textContent = "Install the app";
        desc.textContent = "This device could not be recognised. Choose the app for your device below. Apps are available for Windows, Mac, Linux and Android.";
        how.textContent = "";
        btn.hidden = true;
    }
    // The device is worked out automatically. The list of other devices is only
    // for the rare case where it cannot be.
    if(!me){ paintOthers(me); }
}

setup();

})();
