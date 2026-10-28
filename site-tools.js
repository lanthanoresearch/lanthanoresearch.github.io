/* ============================================================
   Lanthano Research - shared site tools
   One small script loaded by every page. It adds:
     - light / dark / automatic theme and text size
     - "Cite" and "Report a correction" (opens an email) for papers,
       images and videos
     - the download menu on each paper card (PDF, images, videos)
     - backup / restore of favorites, bookmarks and settings
   Everything stays in the browser. Nothing is tracked or counted.
============================================================ */
(function(){
"use strict";

var SITE = "https://lanthanoresearch.com";
var CONTACT = "LanthanoResearch@protonmail.com";
var API = window.LT_API || "https://videos.lanthanoresearch.com";

var path = (location.pathname.split("/").pop() || "index.html").toLowerCase();
var VIEWER = /^(pdf|video|image)\.html$/.test(path);

function get(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } }
function set(k,v){ try{ localStorage.setItem(k,v); }catch(e){} }

/* ---------------------------------------------------------------
   Theme + text size (applied immediately so nothing flashes)
--------------------------------------------------------------- */
var root = document.documentElement;

function systemLight(){
  try{ return window.matchMedia("(prefers-color-scheme: light)").matches; }catch(e){ return false; }
}
function applyTheme(){
  if(VIEWER) return;
  var t = get("lt_theme") || "dark";
  var light = t === "light" || (t === "auto" && systemLight());
  if(light) root.setAttribute("data-lt-theme","light");
  else root.removeAttribute("data-lt-theme");
}
function applyText(){
  if(VIEWER) return;
  var z = parseFloat(get("lt_text")) || 1;
  root.style.zoom = z === 1 ? "" : String(z);
}
applyTheme();
applyText();

var css = document.createElement("style");
css.textContent =
  /* Light theme: flip the whole page, then flip pictures back. */
  'html[data-lt-theme="light"]{filter:invert(1) hue-rotate(180deg);background:#fff}' +
  'html[data-lt-theme="light"] img,html[data-lt-theme="light"] video,' +
  'html[data-lt-theme="light"] canvas,html[data-lt-theme="light"] iframe,' +
  'html[data-lt-theme="light"] picture,html[data-lt-theme="light"] [style*="background-image"],' +
  'html[data-lt-theme="light"] .lt-keep{filter:invert(1) hue-rotate(180deg)}' +

  /* Everything below copies the look of the site's own Settings panel,
     option popups, centred prompts (like "Resume") and toggles. */

  /* picker row: label left, value + chevron right */
  '.ltPickRow{box-sizing:border-box;display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;' +
    'padding:10px 16px;border:0;border-radius:8px;background:#2e2e2e;color:#eee;font-size:13.5px;font-family:inherit;' +
    'cursor:pointer;text-align:left;text-decoration:none}' +
  '.ltPickRow:hover{background:#383838}' +
  '.ltPickVal{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex:1 1 auto;min-width:0;color:#eee;font-size:13.5px}' +
  '.ltPickVal span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}' +
  '.ltPickCaret{flex-shrink:0;width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;' +
    'border-top:7px solid #999;transition:transform .15s ease}' +
  '.ltPickRow.open .ltPickCaret{transform:rotate(180deg)}' +
  '.ltPickChev{color:#999;font-size:16px;line-height:1}' +

  /* option popup */
  '.ltPopup{box-sizing:border-box;position:fixed;display:flex;flex-direction:column;width:190px;max-width:calc(100vw - 24px);' +
    'max-height:min(60vh,420px);padding:10px;background:#1d1d1d;border:1px solid #2c2c2c;border-radius:10px;' +
    'box-shadow:0 6px 18px rgba(0,0,0,.5);z-index:9950;font-family:Arial,sans-serif}' +
  '.ltOpt{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;padding:8px 8px;border:0;border-radius:6px;' +
    'background:transparent;color:#ddd;font-size:13px;font-family:inherit;text-align:left;white-space:nowrap;cursor:pointer}' +
  '.ltOpt:hover{background:#262626}' +
  '.ltOptNote{color:#777;font-size:12px}' +
  '.ltOpt.active{background:#262626;color:#fff}' +
  '.ltOpt .ltOptCheck{flex:0 0 auto;min-width:14px;text-align:center;color:#999;visibility:hidden}' +
  '.ltOpt.active .ltOptCheck{visibility:visible}' +

  /* centred prompt (same card as the "Resume" prompt) */
  '.ltModalBack{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:20px;' +
    'background:rgba(0,0,0,.55);z-index:9800;font-family:Arial,sans-serif}' +
  '.ltModal{box-sizing:border-box;width:100%;max-width:420px;max-height:calc(100vh - 40px);overflow:auto;padding:20px;' +
    'background:#1e1e1e;border:1px solid #3a3a3a;border-radius:13px;box-shadow:0 12px 32px rgba(0,0,0,.55);color:#eee;text-align:left}' +
  '.ltModal h3{margin:0 0 8px;font-size:16px;color:#fff}' +
  '.ltModal p{margin:0 0 16px;color:#bbb;font-size:13px;line-height:1.45}' +
  '.ltModal p.ltSub{margin:-4px 0 14px;color:#888;font-size:12px;word-break:break-word}' +
  '.ltModal .ltPickRow{margin:0 0 8px}' +
  '.ltModal textarea{display:block;width:100%;box-sizing:border-box;min-height:110px;margin:0 0 12px;padding:10px;' +
    'background:#1d1d1d;color:#eee;border:1px solid #333;border-radius:10px;font:13px/1.45 Arial,sans-serif;resize:vertical}' +
  '.ltModal .ltLabel{margin:16px 0 6px;color:#888;font-size:11px;letter-spacing:.08em;text-transform:uppercase}' +
  '.ltModal ul{margin:0 0 4px;padding-left:18px;color:#ccc;font-size:13px;line-height:1.45}' +
  '.ltModal li{margin:0 0 6px}' +
  '.ltModal a:not(.ltPrimary){color:#4a8dff}' +
  '.ltPrimary{display:block;box-sizing:border-box;width:100%;padding:11px 10px;border:1px solid #2f7cff;border-radius:8px;' +
    'background:#2f7cff;color:#fff;font:14px Arial,sans-serif;text-align:center;text-decoration:none;cursor:pointer}' +
  '.ltPrimary:hover{background:#4a8dff}' +
  '.ltCancel{display:block;margin:2px auto 0;padding:6px;background:transparent;border:0;color:#999;font:12px Arial,sans-serif;cursor:pointer}' +
  '.ltCancel:hover{color:#ccc}' +

  /* small confirmation message */
  '.ltToast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:9990;max-width:calc(100vw - 32px);' +
    'padding:10px 16px;background:#222;border:1px solid #333;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.5);' +
    'color:#eee;font:13.5px Arial,sans-serif;text-align:center}';
(document.head || root).appendChild(css);

/* ---------------------------------------------------------------
   Small helpers
--------------------------------------------------------------- */
function el(tag, attrs, html){
  var n = document.createElement(tag);
  if(attrs) for(var k in attrs) n.setAttribute(k, attrs[k]);
  if(html != null) n.innerHTML = html;
  return n;
}
function esc(s){
  return String(s == null ? "" : s).replace(/[&<>"]/g, function(c){
    return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c];
  });
}
function toast(msg){
  var t = el("div", {"class":"ltToast"}, esc(msg));
  document.body.appendChild(t);
  setTimeout(function(){ t.remove(); }, 2200);
}
function copy(text){
  function fallback(){
    var ta = el("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try{ document.execCommand("copy"); toast("Copied"); }catch(e){ toast("Press Ctrl+C to copy"); }
    ta.remove();
  }
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(function(){ toast("Copied"); }, fallback);
  }else fallback();
}
function modal(titleHtml, bodyHtml){
  var back = el("div", {"class":"ltModalBack"});
  var box = el("div", {"class":"ltModal", role:"dialog", "aria-modal":"true"}, titleHtml + bodyHtml);
  back.appendChild(box);
  function close(){ closePopup(); back.remove(); document.removeEventListener("keydown", onKey, true); }
  function onKey(e){ if(e.key === "Escape"){ e.stopPropagation(); if(popup) closePopup(); else close(); } }
  back.addEventListener("click", function(e){ if(e.target === back) close(); });
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(back);
  box.__close = close;
  return box;
}

/* ---------------------------------------------------------------
   Picker row + option popup (same look and behaviour as the
   Settings panel's View / Reading Speed pickers)
--------------------------------------------------------------- */
var popup = null;
function closePopup(){
  if(!popup) return;
  popup.el.remove();
  popup.row.classList.remove("open");
  popup.row.setAttribute("aria-expanded", "false");
  popup = null;
}
function pickerRowHtml(label){
  return '<span>' + esc(label) + '</span><span class="ltPickVal videoPickerValue"><span class="ltPickText"></span>' +
    '<span class="ltPickCaret videoPickerCaret" aria-hidden="true"></span></span>';
}
/* row: a button; opts: [{value,label}]; get(): current value; set(v) */
function bindPicker(row, opts, get, setv){
  function paint(){
    var cur = opts.filter(function(o){ return o.value === get(); })[0];
    row.querySelector(".ltPickText").textContent = cur ? cur.label : "";
  }
  paint();
  row.setAttribute("aria-haspopup", "true");
  row.setAttribute("aria-expanded", "false");
  row.addEventListener("click", function(e){
    e.stopPropagation();
    // the page's own option popup (View / Reading Speed ...) closes like it would on any other click
    var host = document.getElementById("optionPopup");
    if(host) host.classList.remove("open");
    var was = popup && popup.row === row;
    closePopup();
    if(was) return;
    var pop = el("div", {"class":"ltPopup videoOptionPopup open", role:"menu"});
    opts.forEach(function(o){
      var b = el("button", {type:"button", "class":"ltOpt" + (o.value === get() ? " active" : ""), role:"menuitemradio",
        "aria-checked": o.value === get() ? "true" : "false"},
        '<span>' + esc(o.label) + '</span><span class="ltOptCheck">✓</span>');
      b.addEventListener("click", function(ev){
        ev.stopPropagation();
        setv(o.value);
        paint();
        closePopup();
      });
      pop.appendChild(b);
    });
    pop.addEventListener("click", function(ev){ ev.stopPropagation(); });
    document.body.appendChild(pop);
    var r = row.getBoundingClientRect(), w = Math.min(190, window.innerWidth - 24);
    var left = Math.max(12, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 12));
    pop.style.left = left + "px";
    var below = window.innerHeight - r.bottom - 8, above = r.top - 8;
    if(below >= 160 || below >= above){ pop.style.top = (r.bottom + 8) + "px"; }
    else{ pop.style.bottom = (window.innerHeight - r.top + 8) + "px"; }
    row.classList.add("open");
    row.setAttribute("aria-expanded", "true");
    popup = {el:pop, row:row};
  });
  return paint;
}
document.addEventListener("click", function(){ closePopup(); });
window.addEventListener("resize", closePopup);
document.addEventListener("keydown", function(e){ if(e.key === "Escape") closePopup(); });

var MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
function parseDate(s){
  var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || "");
  return m ? {y:+m[1], m:+m[2], d:+m[3]} : null;
}
function today(){
  var d = new Date();
  return {y:d.getFullYear(), m:d.getMonth()+1, d:d.getDate()};
}
function baseName(p){ return String(p || "").split("/").pop(); }
function safeDecode(s){ try{ return decodeURIComponent(s); }catch(e){ return s; } }

/* ---------------------------------------------------------------
   Look up which paper a file belongs to (descriptions.json)
--------------------------------------------------------------- */
var dataPromise = null;
function loadData(){
  if(!dataPromise){
    dataPromise = fetch("descriptions.json").then(function(r){ return r.json(); }).catch(function(){ return {}; });
  }
  return dataPromise;
}
function findPaper(kind, name){
  return loadData().then(function(all){
    var want = safeDecode(name || "");
    var wantBase = baseName(want);
    var hit = null;
    Object.keys(all).some(function(k){
      var p = all[k];
      if(!p || typeof p !== "object") return false;
      var ok = false;
      if(kind === "paper") ok = p.url === want || baseName(p.url) === wantBase;
      else if(kind === "image") ok = (p.images || []).some(function(i){ return i === want || baseName(i) === wantBase; });
      else if(kind === "video") ok = (p.videos || []).some(function(v){
        return v && (v.file === want || baseName(v.file) === wantBase);
      });
      if(ok) hit = p;
      return ok;
    });
    return hit;
  });
}

/* ---------------------------------------------------------------
   What is the person looking at right now?
--------------------------------------------------------------- */
function currentItem(){
  var q = new URLSearchParams(location.search);
  var type = "page", name = "", title = "";
  if(path === "pdf.html"){ type = "paper"; name = safeDecode(q.get("file") || ""); title = safeDecode(q.get("paper") || ""); }
  else if(path === "image.html"){ type = "image"; name = safeDecode(q.get("image") || ""); title = baseName(name).replace(/\.[a-z0-9]+$/i, ""); }
  else if(path === "video.html"){ type = "video"; name = safeDecode(q.get("video") || q.get("link") || ""); title = safeDecode(q.get("title") || "") || baseName(name).replace(/\.[a-z0-9]+$/i, ""); }
  else { title = (document.title || "").replace(/\s*[-—|].*$/, ""); }
  var u = new URL(location.href);
  u.searchParams.delete("return");
  u.searchParams.delete("t");
  u.searchParams.delete("page");
  u.hash = "";
  var pub = SITE + u.pathname + u.search;
  if(!/lanthanoresearch\.com$/.test(location.hostname)) pub = u.origin + u.pathname + u.search;
  return {type:type, name:name, title:title, url:pub};
}
function liveContext(){
  try{ return (window.LT && typeof window.LT.context === "function") ? (window.LT.context() || {}) : {}; }
  catch(e){ return {}; }
}

/* ---------------------------------------------------------------
   Cite
--------------------------------------------------------------- */
function buildCitations(item, paper){
  var d = parseDate(paper && paper.updated);
  var a = today();
  var title = item.title || "Untitled";
  var paperTitle = paper && paper.title;
  var shown = title;
  var kindWord = item.type === "image" ? "Image" : item.type === "video" ? "Video" : "";
  var container = paperTitle && item.type !== "paper" ? paperTitle : "";
  var author = "Lanthano Research";

  var apaDate = d ? "(" + d.y + (d.m ? ", " + MONTHS[d.m-1] + " " + d.d : "") + ")" : "(n.d.)";
  var apa = author + ". " + apaDate + ". " + shown + (kindWord ? " [" + kindWord + "]" : "") + "." +
    (container ? " In " + container + "." : "") + " Lanthano Research. " + item.url;

  var mlaDate = d ? d.d + " " + MONTHS[d.m-1].slice(0,3) + ". " + d.y : "n.d.";
  var mla = author + ". “" + shown + ".” " + (container ? container + ", " : "") +
    "Lanthano Research, " + mlaDate + ", " + item.url.replace(/^https?:\/\//, "") +
    ". Accessed " + a.d + " " + MONTHS[a.m-1].slice(0,3) + ". " + a.y + ".";

  var key = "lanthano" + (d ? d.y : "") + String(shown).toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 14);
  var bib = "@misc{" + key + ",\n" +
    "  author       = {{Lanthano Research}},\n" +
    "  title        = {" + shown.replace(/[{}]/g, "") + "},\n" +
    (container ? "  booktitle    = {" + container.replace(/[{}]/g, "") + "},\n" : "") +
    (d ? "  year         = {" + d.y + "},\n  month        = {" + MONTHS[d.m-1].toLowerCase().slice(0,3) + "},\n" : "") +
    "  howpublished = {\\url{" + item.url + "}},\n" +
    "  note         = {Accessed: " + a.y + "-" + String(a.m).padStart(2,"0") + "-" + String(a.d).padStart(2,"0") + "}\n}";

  return {APA: apa, MLA: mla, BibTeX: bib, Link: item.url};
}

function sourcesHtml(paper){
  var s = paper && paper.sources;
  if(!s || !s.length) return "";
  return '<div class="ltLabel">Sources</div><ul>' +
    s.map(function(x){
      if(typeof x === "string") return "<li>" + esc(x) + "</li>";
      var t = esc(x.title || x.url || "Source");
      return "<li>" + (x.url ? '<a href="' + esc(x.url) + '" target="_blank" rel="noopener noreferrer">' + t + "</a>" : t) +
        (x.note ? " &mdash; " + esc(x.note) : "") + "</li>";
    }).join("") + "</ul>";
}

function cite(item){
  item = item || currentItem();
  findPaper(item.type, item.name).then(function(paper){
    var cites = buildCitations(item, paper);
    var opts = Object.keys(cites).map(function(n){ return {value:n, label:n}; });
    var cur = "APA";
    var box = modal('<h3>Cite</h3>',
      '<p class="ltSub">' + esc(item.title) + '</p>' +
      '<button type="button" class="ltPickRow" id="ltFmt">' + pickerRowHtml("Format") + '</button>' +
      '<textarea readonly aria-label="Citation"></textarea>' +
      '<button type="button" class="ltPrimary" data-act="copy">Copy</button>' +
      '<button type="button" class="ltCancel" data-act="close">Close</button>' +
      sourcesHtml(paper));
    var ta = box.querySelector("textarea");
    function show(){ ta.value = cites[cur]; }
    bindPicker(box.querySelector("#ltFmt"), opts, function(){ return cur; }, function(v){ cur = v; show(); });
    show();
    box.addEventListener("click", function(e){
      var b = e.target.closest("[data-act]"); if(!b) return;
      if(b.dataset.act === "copy") copy(ta.value);
      else box.__close();
    });
  });
}

/* ---------------------------------------------------------------
   Sources (list only)
--------------------------------------------------------------- */
function sources(item){
  item = item || currentItem();
  findPaper(item.type, item.name).then(function(paper){
    var html = sourcesHtml(paper).replace('<div class="ltLabel">Sources</div>', "");
    var box = modal("<h3>Sources</h3>",
      '<p class="ltSub">' + esc((paper && paper.title) || item.title) + "</p>" +
      (html || '<p>No sources have been listed for this one yet.</p>') +
      '<button type="button" class="ltCancel" data-act="close">Close</button>');
    box.addEventListener("click", function(e){ if(e.target.closest("[data-act]")) box.__close(); });
  });
}

/* ---------------------------------------------------------------
   Report a correction (opens the visitor's own email)
--------------------------------------------------------------- */
function report(item){
  item = item || currentItem();
  var ctx = liveContext();
  var what = item.type === "page" ? "page" : item.type;
  var lines = [
    "Hello,", "",
    "I found something that needs a correction on Lanthano Research.", "",
    "Type: " + what,
    "Title: " + item.title
  ];
  if(ctx.page) lines.push("Page: " + ctx.page);
  if(ctx.time) lines.push("Time in video: " + ctx.time);
  lines.push("Link: " + (ctx.link || item.url), "",
    "What is wrong:", "", "",
    "What it should say (and a source if you have one):", "", ""
  );
  var subject = "Correction: " + (item.title || what);
  var href = "mailto:" + CONTACT + "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(lines.join("\n"));
  var box = modal("<h3>Report a correction</h3>",
    '<p>This opens an email to us about <b style="color:#ddd">' + esc(item.title) + '</b>, with the link already filled in. Just describe what is wrong.</p>' +
    '<a class="ltPrimary" data-act="send" href="' + esc(href) + '">Open email</a>' +
    '<button type="button" class="ltCancel" data-act="close">Cancel</button>');
  box.addEventListener("click", function(e){
    var t = e.target.closest("[data-act]"); if(!t) return;
    if(t.dataset.act === "close") box.__close();
    else setTimeout(box.__close, 50);
  });
}

/* ---------------------------------------------------------------
   Backup / restore (favorites, bookmarks, settings)
--------------------------------------------------------------- */
var SKIP = /^(savedVideoLog|archiveStatsCache|archiveFileSizes|lt_seen|lt_hit)/;
function exportBackup(){
  var data = {};
  try{
    for(var i = 0; i < localStorage.length; i++){
      var k = localStorage.key(i);
      if(SKIP.test(k)) continue;
      data[k] = localStorage.getItem(k);
    }
  }catch(e){}
  var blob = new Blob([JSON.stringify({app:"lanthano-research", version:1, saved:new Date().toISOString(), data:data}, null, 1)], {type:"application/json"});
  var a = el("a", {href:URL.createObjectURL(blob), download:"lanthano-backup-" + new Date().toISOString().slice(0,10) + ".json"});
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function(){ URL.revokeObjectURL(a.href); }, 5000);
  toast("Backup saved - " + Object.keys(data).length + " items");
}
function importBackup(){
  var inp = el("input", {type:"file", accept:"application/json,.json"});
  inp.addEventListener("change", function(){
    var f = inp.files && inp.files[0]; if(!f) return;
    var r = new FileReader();
    r.onload = function(){
      try{
        var j = JSON.parse(r.result);
        if(!j || j.app !== "lanthano-research" || !j.data) throw new Error("bad");
        var n = 0;
        Object.keys(j.data).forEach(function(k){ if(!SKIP.test(k) && typeof j.data[k] === "string"){ set(k, j.data[k]); n++; } });
        toast("Restored " + n + " items - reloading");
        setTimeout(function(){ location.reload(); }, 900);
      }catch(e){ toast("That is not a Lanthano backup file"); }
    };
    r.readAsText(f);
  });
  inp.click();
}

/* ---------------------------------------------------------------
   Theme + text size rows (used on the Settings page)
--------------------------------------------------------------- */
var deferredInstall = null;
window.addEventListener("beforeinstallprompt", function(e){ e.preventDefault(); deferredInstall = e; });

var THEMES = [{value:"dark", label:"Dark"}, {value:"light", label:"Light"}, {value:"auto", label:"Auto"}];
var SIZES = [{value:"0.9", label:"Small"}, {value:"1", label:"Normal"}, {value:"1.15", label:"Large"}, {value:"1.3", label:"Larger"}];

function themeValue(){ return get("lt_theme") || "dark"; }
function sizeValue(){
  var z = String(parseFloat(get("lt_text")) || 1);
  return SIZES.some(function(o){ return o.value === z; }) ? z : "1";
}
function setTheme(v){ set("lt_theme", v); applyTheme(); }
function setSize(v){ set("lt_text", v); applyText(); }

/* Rows for any container; returns nothing. */
function addAppearanceRows(container){
  var t = el("button", {type:"button", "class":"ltPickRow videoPickerRow"}, pickerRowHtml("Theme"));
  var z = el("button", {type:"button", "class":"ltPickRow videoPickerRow"}, pickerRowHtml("Text size"));
  container.appendChild(t);
  container.appendChild(z);
  bindPicker(t, THEMES, themeValue, setTheme);
  bindPicker(z, SIZES, sizeValue, setSize);
}

/* ---------------------------------------------------------------
   Small popup menu (anchored to a button) + a choice prompt
   Same look as the site's option popups and the "Resume" prompt.
--------------------------------------------------------------- */
/* items: [{label, note, onClick}] */
function menu(anchor, items){
  var host = document.getElementById("optionPopup");
  if(host) host.classList.remove("open");
  var was = popup && popup.row === anchor;
  closePopup();
  if(was) return;
  var pop = el("div", {"class":"ltPopup videoOptionPopup open", role:"menu"});
  pop.style.width = "230px";
  items.forEach(function(it){
    var b = el("button", {type:"button", "class":"ltOpt", role:"menuitem"},
      '<span>' + esc(it.label) + '</span>' + (it.note ? '<span class="ltOptNote">' + esc(it.note) + '</span>' : ''));
    b.addEventListener("click", function(ev){
      ev.stopPropagation();
      closePopup();
      it.onClick();
    });
    pop.appendChild(b);
  });
  pop.addEventListener("click", function(ev){ ev.stopPropagation(); });
  document.body.appendChild(pop);
  var r = anchor.getBoundingClientRect(), w = Math.min(230, window.innerWidth - 24);
  pop.style.left = Math.max(12, Math.min(r.right - w, window.innerWidth - w - 12)) + "px";
  var below = window.innerHeight - r.bottom - 8, above = r.top - 8;
  if(below >= 150 || below >= above){ pop.style.top = (r.bottom + 8) + "px"; }
  else{ pop.style.bottom = (window.innerHeight - r.top + 8) + "px"; }
  anchor.classList.add("open");
  anchor.setAttribute("aria-expanded", "true");
  popup = {el:pop, row:anchor};
}

/* A centred prompt with a few choices. buttons: [{label, primary, onClick}] */
function ask(title, text, buttons){
  var box = modal('<h3>' + esc(title) + '</h3>', '<p>' + esc(text) + '</p>');
  buttons.forEach(function(b){
    var n = el("button", {type:"button", "class": b.primary ? "ltPrimary" : "ltPickRow"}, b.primary ? esc(b.label) : '<span>' + esc(b.label) + '</span>');
    if(b.primary) n.style.marginBottom = "8px";
    n.addEventListener("click", function(){ box.__close(); b.onClick(); });
    box.appendChild(n);
  });
  var c = el("button", {type:"button", "class":"ltCancel"}, "Cancel");
  c.addEventListener("click", function(){ box.__close(); });
  box.appendChild(c);
}

/* ---------------------------------------------------------------
   Per-paper download menu: the PDF, all images (.zip), all videos
--------------------------------------------------------------- */
function realList(a){
  return (a || []).filter(function(x){
    var f = typeof x === "string" ? x : (x && x.file);
    return typeof f === "string" && f.trim() && f.trim().indexOf("#$") !== 0;
  });
}
function saveBlob(blob, name){
  var a = el("a", {href:URL.createObjectURL(blob), download:name});
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function(){ URL.revokeObjectURL(a.href); }, 60000);
}
function encPath(p){ return p.split("/").map(encodeURIComponent).join("/"); }

function downloadPdf(paper){
  var a = el("a", {href:encPath(paper.url), download:baseName(paper.url)});
  document.body.appendChild(a); a.click(); a.remove();
}

var videosBusy = false;
function downloadVideos(paper){
  if(videosBusy) return;
  var list = realList(paper.videos);
  if(!list.length){ toast("This paper has no videos"); return; }
  videosBusy = true;
  var note = el("div", {"class":"ltToast"}, "");
  document.body.appendChild(note);
  var ok = 0, failed = 0;
  function one(v){
    var file = v.file.trim(), name = baseName(file);
    if(v.source === "site"){
      return fetch(encPath(file)).then(function(r){
        if(!r.ok) throw 0;
        return r.blob();
      }).then(function(b){ saveBlob(b, name); ok++; });
    }
    return fetch(API + "/ticket?f=" + encodeURIComponent(file), {cache:"no-store"}).then(function(r){
      if(!r.ok) throw 0;
      return r.json();
    }).then(function(j){
      return fetch(API + "/play?t=" + encodeURIComponent(j.t));
    }).then(function(r){
      if(!r.ok) throw 0;
      return r.blob();
    }).then(function(b){ saveBlob(b, name); ok++; });
  }
  function next(i){
    if(i >= list.length) return Promise.resolve();
    note.textContent = "Downloading video " + (i + 1) + " of " + list.length + "…";
    return one(list[i]).catch(function(){ failed++; }).then(function(){ return next(i + 1); });
  }
  return next(0).then(function(){
    note.remove();
    toast(failed ? "Downloaded " + ok + " of " + list.length + " videos (" + failed + " could not be loaded)"
                 : "Downloaded " + ok + " video" + (ok === 1 ? "" : "s"));
    videosBusy = false;
  });
}

/* paper: {title, url, images:[], videos:[{file, source}]} */
function downloadMenu(anchor, paper){
  var imgs = realList(paper.images).length, vids = realList(paper.videos).length;
  var items = [{label:"PDF", note:".pdf", onClick:function(){ downloadPdf(paper); }}];
  if(imgs) items.push({label:"All images (" + imgs + ")", note:".zip", onClick:function(){ zipImages(paper); }});
  if(vids) items.push({label:"All videos (" + vids + ")", note:"one by one", onClick:function(){ downloadVideos(paper); }});
  menu(anchor, items);
}

/* ---------------------------------------------------------------
   Download all of a paper's images as one .zip (built in the browser)
--------------------------------------------------------------- */
var CRC_TABLE = null;
function crc32(buf){
  if(!CRC_TABLE){
    CRC_TABLE = new Uint32Array(256);
    for(var n = 0; n < 256; n++){
      var c = n;
      for(var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c >>> 0;
    }
  }
  var crc = 0xFFFFFFFF;
  for(var i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 255] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
/* files: [{name, data: Uint8Array}] -> Blob (no compression: images are
   already compressed, so storing them is just as small and much faster) */
function makeZip(files){
  var enc = new TextEncoder(), d = new Date();
  var time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  var date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  var parts = [], central = [], offset = 0, centralSize = 0;
  files.forEach(function(f){
    var nm = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
    var h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true);
    h.setUint16(8, 0, true); h.setUint16(10, time, true); h.setUint16(12, date, true);
    h.setUint32(14, crc, true); h.setUint32(18, size, true); h.setUint32(22, size, true);
    h.setUint16(26, nm.length, true); h.setUint16(28, 0, true);
    parts.push(h.buffer, nm, f.data);
    var c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true); c.setUint16(12, time, true); c.setUint16(14, date, true);
    c.setUint32(16, crc, true); c.setUint32(20, size, true); c.setUint32(24, size, true);
    c.setUint16(28, nm.length, true); c.setUint32(42, offset, true);
    central.push(c.buffer, nm);
    centralSize += 46 + nm.length;
    offset += 30 + nm.length + size;
  });
  var e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, centralSize, true); e.setUint32(16, offset, true);
  return new Blob(parts.concat(central, [e.buffer]), {type:"application/zip"});
}

var zipBusy = false;
function zipImages(paper){
  if(zipBusy) return;
  var list = ((paper && paper.images) || []).filter(function(i){
    return typeof i === "string" && i.trim() && i.trim().indexOf("#$") !== 0;
  });
  if(!list.length){ toast("This paper has no images"); return; }
  zipBusy = true;
  var note = el("div", {"class":"ltToast"}, "Preparing images…");
  document.body.appendChild(note);
  var files = [], used = {}, failed = 0, done = 0;
  function next(i){
    if(i >= list.length) return Promise.resolve();
    var src = list[i];
    return fetch(src.split("/").map(encodeURIComponent).join("/")).then(function(r){
      var type = r.headers.get("content-type") || "";
      if(!r.ok || /text\/html/i.test(type)) throw new Error("missing");
      return r.arrayBuffer();
    }).then(function(buf){
      var name = baseName(src), base = name, n = 1;
      while(used[name.toLowerCase()]){ n++; name = base.replace(/(\.[^.]*)?$/, " (" + n + ")$1"); }
      used[name.toLowerCase()] = 1;
      files.push({name:name, data:new Uint8Array(buf)});
    }).catch(function(){ failed++; }).then(function(){
      done++;
      note.textContent = "Preparing images… " + done + " of " + list.length;
      return next(i + 1);
    });
  }
  return next(0).then(function(){
    note.remove();
    if(!files.length){ toast("Could not load any images"); return; }
    var blob = makeZip(files);
    var safe = String((paper && paper.title) || "images").replace(/[\\/:*?"<>|]+/g, "-").trim();
    var a = el("a", {href:URL.createObjectURL(blob), download:safe + " - images.zip"});
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function(){ URL.revokeObjectURL(a.href); }, 20000);
    toast(failed ? "Saved " + files.length + " of " + list.length + " images (" + failed + " could not be loaded)" : "Saved " + files.length + " images");
  }).then(function(){ zipBusy = false; }, function(){ zipBusy = false; note.remove(); });
}

/* ---------------------------------------------------------------
   Wire up any button marked data-lt="cite|report|sources"
--------------------------------------------------------------- */
document.addEventListener("click", function(e){
  var b = e.target.closest && e.target.closest("[data-lt]");
  if(!b) return;
  var a = b.getAttribute("data-lt");
  if(a !== "cite" && a !== "report" && a !== "sources" && a !== "zip") return;
  e.preventDefault();
  var menu = document.getElementById("menu"); if(menu) menu.style.display = "none";
  var item = null;
  if(b.dataset.title){
    item = {type:b.dataset.type || "paper", name:b.dataset.name || "", title:b.dataset.title,
            url: b.dataset.url || (SITE + "/")};
  }
  if(a === "zip"){
    var zi = item || currentItem();
    findPaper(zi.type, zi.name).then(function(p){ if(p) zipImages(p); else toast("Could not find this paper's images"); });
    return;
  }
  if(a === "cite") cite(item); else if(a === "report") report(item); else sources(item);
}, true);

window.LT = window.LT || {};
window.LT.cite = cite;
window.LT.report = report;
window.LT.sources = sources;
window.LT.zipImages = zipImages;
window.LT.makeZip = makeZip;
window.LT.toast = toast;
window.LT.copy = copy;
window.LT.item = currentItem;
window.LT.exportBackup = exportBackup;
window.LT.importBackup = importBackup;
window.LT.bindPicker = bindPicker;
window.LT.pickerRowHtml = pickerRowHtml;
window.LT.addAppearanceRows = addAppearanceRows;
window.LT.menu = menu;
window.LT.hasSources = function(){
  var it = currentItem();
  return findPaper(it.type, it.name).then(function(p){ return !!(p && p.sources && p.sources.length); });
};
window.LT.ask = ask;
window.LT.downloadMenu = downloadMenu;
window.LT.downloadPdf = downloadPdf;
window.LT.downloadVideos = downloadVideos;
window.LT.install = function(){ if(!deferredInstall) return false; deferredInstall.prompt(); deferredInstall = null; return true; };
window.LT.canInstall = function(){ return !!deferredInstall; };

function ready(){
  try{ window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", applyTheme); }catch(e){}
}
if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready); else ready();

})();
