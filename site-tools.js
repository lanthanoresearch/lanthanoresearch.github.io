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
   Theme + accent + text size

   Colors are changed the way a designer would: every color the page's
   style sheets use is mapped to the chosen theme (dark grays become
   light ones for Light and Sepia, get a blue or green tint for Midnight
   and Forest), and the accent blue is turned into the chosen accent.
   Pictures, videos and the pages of a PDF are never touched. The three
   viewers (PDF, video, image) follow the theme like every other page.
--------------------------------------------------------------- */
var root = document.documentElement;

var THEME_DEFS = {
  dark:     {light:false, h:0,   s:0},
  light:    {light:true,  h:0,   s:0},
  sepia:    {light:true,  h:38,  s:0.32},
  midnight: {light:false, h:222, s:0.34},
  forest:   {light:false, h:150, s:0.24}
};
var ACCENT_HUE = {"default":null, blue:216, teal:174, green:142, orange:26, red:2, purple:268, pink:328};

function systemLight(){
  try{ return window.matchMedia("(prefers-color-scheme: light)").matches; }catch(e){ return false; }
}
function themeName(){
  var t = get("lt_theme") || "dark";
  if(t === "auto") t = systemLight() ? "light" : "dark";
  return THEME_DEFS[t] ? t : "dark";
}
function accentName(){
  var a = get("lt_accent") || "default";
  return ACCENT_HUE.hasOwnProperty(a) ? a : "default";
}

var TE = {
  store: [], sheets: new WeakSet(), inl: new WeakMap(), attrs: new WeakMap(),
  T: THEME_DEFS.dark, accent: null, tH: 0, tS: 0, active: false, obs: null, hold: null
};

/* The tint every gray gets: the theme's own (Sepia, Midnight, Forest), or a soft one in the accent's color. */
function setTint(){
  var T = TE.T;
  if(T.s){ TE.tH = T.h; TE.tS = T.s; }
  else if(TE.accent != null){ TE.tH = TE.accent; TE.tS = T.light ? 0.2 : 0.17; }
  else { TE.tH = 0; TE.tS = 0; }
}
function rgb2hsl(r, g, b){
  r /= 255; g /= 255; b /= 255;
  var mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn, h = 0, s = 0;
  if(d){
    s = d / (1 - Math.abs(2 * l - 1));
    if(mx === r) h = ((g - b) / d) % 6; else if(mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
    h *= 60; if(h < 0) h += 360;
  }
  return {h:h, s:Math.min(1, s), l:l, c:d};
}
function hsl2rgb(h, s, l){
  var c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2, r = 0, g = 0, b = 0;
  if(h < 60){ r = c; g = x; } else if(h < 120){ r = x; g = c; } else if(h < 180){ g = c; b = x; }
  else if(h < 240){ g = x; b = c; } else if(h < 300){ r = x; b = c; } else { r = c; b = x; }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}
var NAMED = {white:[255,255,255], black:[0,0,0], gray:[128,128,128], grey:[128,128,128], silver:[192,192,192], lightgray:[211,211,211], darkgray:[169,169,169]};
function parseTok(t){
  t = t.toLowerCase();
  if(NAMED[t]) return {r:NAMED[t][0], g:NAMED[t][1], b:NAMED[t][2], a:1};
  if(t.charAt(0) === "#"){
    var h = t.slice(1);
    if(h.length === 3 || h.length === 4) h = h.split("").map(function(c){ return c + c; }).join("");
    if(h.length === 6) h += "ff";
    if(h.length !== 8) return null;
    return {r:parseInt(h.substr(0,2),16), g:parseInt(h.substr(2,2),16), b:parseInt(h.substr(4,2),16), a:parseInt(h.substr(6,2),16) / 255};
  }
  var m = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(t);
  if(!m) return null;
  var p = m[2].split(/[\s,\/]+/).filter(Boolean);
  if(p.length < 3) return null;
  function pct(x, k){ return x.indexOf("%") > -1 ? parseFloat(x) / 100 * k : parseFloat(x); }
  var a = p.length > 3 ? pct(p[3], 1) : 1;
  var r, g, b;
  if(m[1].charAt(0) === "r"){ r = pct(p[0], 255); g = pct(p[1], 255); b = pct(p[2], 255); }
  else{
    var rgb = hsl2rgb(parseFloat(p[0]), pct(p[1], 1), pct(p[2], 1));
    r = rgb[0]; g = rgb[1]; b = rgb[2];
  }
  if([r, g, b, a].some(function(n){ return isNaN(n); })) return null;
  return {r:r, g:g, b:b, a:a};
}
function outColor(r, g, b, a){
  r = Math.max(0, Math.min(255, Math.round(r))); g = Math.max(0, Math.min(255, Math.round(g))); b = Math.max(0, Math.min(255, Math.round(b)));
  if(a >= 0.999){
    return "#" + [r, g, b].map(function(n){ return (n < 16 ? "0" : "") + n.toString(16); }).join("");
  }
  return "rgba(" + r + ", " + g + ", " + b + ", " + (Math.round(a * 1000) / 1000) + ")";
}

/* ctx: {shadow, keepText, kept (out)} */
function mapTok(tok, ctx){
  var c = parseTok(tok);
  if(!c) return tok;
  var T = TE.T, A = TE.accent;
  var hs = rgb2hsl(c.r, c.g, c.b);
  var h = hs.h, s = hs.s, l = hs.l, neutral = hs.c < 0.12;

  if(ctx.shadow){
    if(T.light){
      if(l > 0.5) return "rgba(0, 0, 0, 0)";
      return outColor(c.r, c.g, c.b, c.a * 0.45);
    }
  }else if(T.light){
    if(neutral){
      if(ctx.keepText) return tok;
      l = 1 - l; h = TE.tH; s = TE.tS;
      if(ctx.text && l > 0.45) l = 0.45;
    }else if(l < 0.32 || l > 0.85){
      l = 1 - l;
    }else if(ctx.text){
      // colored text: dark enough to read on a light page (yellows need to go darker)
      l = (hs.h >= 35 && hs.h <= 75) ? 0.28 : Math.min(l, 0.4);
    }else if(l > 0.68){
      l = 0.42;
    }else{
      ctx.kept = true;
    }
  }else if(neutral){
    if(!TE.tS) return tok;
    h = TE.tH; s = TE.tS * Math.pow(1 - l, 0.8);
  }

  if(!neutral && A != null && hs.c >= 0.25 && hs.h >= 195 && hs.h <= 248){
    h = A;
    // bright accent hues (orange, green, teal) need to be darker behind white text
    if(!ctx.text && !ctx.shadow && A >= 20 && A <= 200){ var cap = A >= 70 ? 0.26 : 0.38; if(l > cap) l = cap; }
  }
  if(!neutral && A == null && !T.light) return tok;
  if(T.light && ctx.text && !neutral && h >= 70 && h <= 200) l = Math.min(l, 0.26);
  var rgb = hsl2rgb(h, Math.max(0, Math.min(1, s)), Math.max(0, Math.min(1, l)));
  return outColor(rgb[0], rgb[1], rgb[2], c.a);
}

var TOKEN_RE = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![0-9a-z])|rgba?\([^)]*\)|hsla?\([^)]*\)|(?<![\w-])(?:white|black|gray|grey|silver|lightgray|darkgray)(?![\w-])/gi;
var HAS_COLOR = /#[0-9a-f]{3,8}(?![0-9a-z])|rgba?\(|hsla?\(|(?<![\w-])(?:white|black|gray|grey|silver|lightgray|darkgray)(?![\w-])/i;
var URL_SPLIT = /(url\((?:"[^"]*"|'[^']*'|[^)]*)\))/i;

function mapValue(v, ctx){
  if(v.toLowerCase().indexOf("url(") === -1) return v.replace(TOKEN_RE, function(t){ return mapTok(t, ctx); });
  return v.split(URL_SPLIT).map(function(part, i){
    return i % 2 ? part : part.replace(TOKEN_RE, function(t){ return mapTok(t, ctx); });
  }).join("");
}

/* props: [[name, value, priority]] on a CSSStyleDeclaration */
function applyProps(st, props, sel, rec){
  var T = TE.T;
  if(!TE.active || (/knob/i.test(sel) && /active|\.on\b|checked/i.test(sel))){
    props.forEach(function(p){
      if(st.getPropertyValue(p[0]) !== p[1]) st.setProperty(p[0], p[1], p[2]);
      if(rec) rec[p[0]] = {o:p[1], m:st.getPropertyValue(p[0])};
    });
    return;
  }
  var bgKept = false;
  if(T.light){
    props.forEach(function(p){
      if(/^background/.test(p[0])){
        var cx = {shadow:false, keepText:false, kept:false};
        mapAny(p[0], p[1], cx);
        if(cx.kept) bgKept = true;
      }
    });
  }
  props.forEach(function(p){
    var cx = {shadow:/shadow/.test(p[0]), keepText: bgKept && (p[0] === "color" || p[0] === "-webkit-text-fill-color"), text: p[0] === "color" || p[0] === "--btn-text" || (T.light && p[0].indexOf("--") === 0), kept:false};
    var nv = mapAny(p[0], p[1], cx);
    if(st.getPropertyValue(p[0]) !== nv) st.setProperty(p[0], nv, p[2]);
    /* remember the value as the browser stores it (it re-formats colors), so the
       next pass recognises its own write instead of mapping it a second time */
    if(rec) rec[p[0]] = {o:p[1], m:st.getPropertyValue(p[0])};
  });
}

/* Some pages keep a color as three bare numbers in a custom property
   (--btn: 255,215,0) and use it as rgba(var(--btn), .12). */
var TRIPLE = /^\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*$/;
function collectProps(st){
  var props = [];
  for(var i = 0; i < st.length; i++){
    var n = st[i], v = st.getPropertyValue(n);
    if(v && (HAS_COLOR.test(v) || (n.indexOf("--") === 0 && TRIPLE.test(v)))) props.push([n, v, st.getPropertyPriority(n)]);
  }
  return props;
}
function mapAny(name, v, cx){
  var t = name.indexOf("--") === 0 && TRIPLE.exec(v);
  if(t){
    if(TE.T.light){
      var th = rgb2hsl(+t[1], +t[2], +t[3]);
      if(th.c >= 0.25 && th.h >= 35 && th.h <= 75) cx.text = true;
    }
    var o = mapTok("rgb(" + t[1] + "," + t[2] + "," + t[3] + ")", cx);
    var q = parseTok(o);
    return q ? Math.round(q.r) + ", " + Math.round(q.g) + ", " + Math.round(q.b) : v;
  }
  return mapValue(v, cx);
}
function walkRules(rules, f){
  for(var i = 0; i < rules.length; i++){
    var r = rules[i];
    if(r.style) f(r);
    if(r.cssRules) walkRules(r.cssRules, f);
  }
}
/* Things that must keep their own colors in every theme: the white paper of a PDF page and what is drawn
   on it, and the black surface a video plays on. */
var PROTECT = path === "pdf.html"
  ? /(^|[\s,>+~(])\.(page|pageCanvas|textLayer|searchHighlightLayer|search-highlight|linkLayer)(?![\w-])/
  : path === "video.html"
    ? /(^|[\s,>+~(])#(video|coverOverlay|videoStage|embedFrame)(?![\w-])/
    : (path === "index.html" || path === "")
      ? /\.research-tools/      // the four home buttons keep their own colors (Papers gold, Media red, Discover purple, Timeline blue)
      : /(?!)/;
function processSheet(sh){
  if(!sh || TE.sheets.has(sh)) return;
  if(sh.ownerNode && /^lt(Accent|Home)Css$/.test(sh.ownerNode.id || "")) return;
  TE.sheets.add(sh);
  var rules;
  try{ rules = sh.cssRules; }catch(e){ return; }
  if(!rules) return;
  walkRules(rules, function(r){
    if(PROTECT.test(r.selectorText || "")) return;
    var props = collectProps(r.style);
    if(!props.length) return;
    var rec = {st:r.style, props:props, sel:r.selectorText || ""};
    TE.store.push(rec);
    if(TE.active) applyProps(rec.st, rec.props, rec.sel);
  });
}
function processAllSheets(){
  for(var i = 0; i < document.styleSheets.length; i++) processSheet(document.styleSheets[i]);
}

/* style="..." attributes written by the page or by its scripts.
   Each color property remembers the page's own value (o) and what was written for it (m), so a
   value the page sets later is mapped fresh, our own writes are recognised and never repeated
   (that is what keeps the page from looping), and switching theme can start from the original. */
function inlineApply(elm){
  var st = elm.style;
  if(!st || !st.length) return;
  var rec = TE.inl.get(elm);
  var props = [];
  for(var i = 0; i < st.length; i++){
    var n = st[i], v = st.getPropertyValue(n);
    if(!v || !(HAS_COLOR.test(v) || (n.indexOf("--") === 0 && TRIPLE.test(v)))) continue;
    var r = rec && rec[n];
    props.push([n, (r && r.m === v) ? r.o : v, st.getPropertyPriority(n)]);
  }
  if(!props.length || (!TE.active && !rec)) return;
  if(!rec){ rec = {}; TE.inl.set(elm, rec); }
  applyProps(st, props, "", rec);
}
var SVG_ATTRS = ["fill", "stroke", "stop-color"];
function attrApply(elm){
  var rec = TE.attrs.get(elm);
  SVG_ATTRS.forEach(function(a){
    if(!elm.hasAttribute || !elm.hasAttribute(a)) return;
    var cur = elm.getAttribute(a);
    if(rec && rec[a] !== undefined && rec["_" + a] === cur){ cur = rec[a]; }
    else{
      if(!HAS_COLOR.test(cur)) return;
      rec = rec || {}; rec[a] = cur;
    }
    var nv = TE.active ? mapValue(cur, {shadow:false, keepText:false, kept:false}) : cur;
    rec["_" + a] = nv;
    TE.attrs.set(elm, rec);
    if(elm.getAttribute(a) !== nv) elm.setAttribute(a, nv);
  });
}
function nodeApply(n){
  if(n.nodeType !== 1) return;
  if(n.hasAttribute("style")) inlineApply(n);
  attrApply(n);
  var kids = n.querySelectorAll("[style],[fill],[stroke],[stop-color]");
  for(var i = 0; i < kids.length; i++){
    if(kids[i].hasAttribute("style")) inlineApply(kids[i]);
    attrApply(kids[i]);
  }
}
function watch(){
  if(TE.obs || !window.MutationObserver) return;
  TE.obs = new MutationObserver(function(list){
    list.forEach(function(m){
      if(m.type === "attributes"){ if(m.target.nodeType === 1) inlineApply(m.target); return; }
      if(m.target && m.target.nodeName === "STYLE") processSheet(m.target.sheet);
      for(var i = 0; i < m.addedNodes.length; i++){
        var n = m.addedNodes[i];
        if(n.nodeName === "STYLE") processSheet(n.sheet);
        else if(n.nodeName === "LINK"){
          if(n.sheet) processSheet(n.sheet);
          else n.addEventListener("load", function(e){ processSheet(e.target.sheet); });
        }else nodeApply(n);
      }
    });
  });
  TE.obs.observe(root, {childList:true, subtree:true, attributes:true, attributeFilter:["style"]});
}


/* ---------------------------------------------------------------
   Stronger accent (optional): carries the accent color onto the research
   list, gallery and viewers - card borders, titles, controls - the way the
   About / Contact / Download pages already have it. Turned off from
   Settings > Appearance, or by removing this block and its one call below.
--------------------------------------------------------------- */
function accentStrong(){ return get("lt_accent_strong") !== "0"; }
function setAccentStrong(on){ set("lt_accent_strong", on ? "1" : "0"); applyTheme(); }

function boostCss(main, edge, soft, A, L){
  var muted = "hsl(" + A + ",32%," + (L ? "34%" : "72%") + ")";
  var line = "hsla(" + A + ",65%," + (L ? "38%" : "62%") + ",.4)";
  var ring = "inset 0 0 0 1px " + edge;
  var css = "";
  var cat = path === "category.html", gal = path === "gallery.html";
  var view = /^(pdf|video|image)\.html$/.test(path);
  if(cat || gal){
    css += ".sort-btn,.settings-btn{box-shadow:" + ring + "}" +
           ".info-bar>p,#paperCount,#imageCount{color:" + muted + " !important}" +
           ".end-of-list{color:" + muted + " !important;opacity:.8}";
  }
  if(cat){
    css += ".view-detailed>.card,.view-compact>.card,.card{box-shadow:" + ring + "}" +
           ".card h2{color:" + main + " !important}" +
           ".read-time-line,.card-date,.card-pages{color:" + muted + " !important}" +
           ".image-details>summary{color:" + muted + " !important}" +
           ".card-cover{box-shadow:0 0 0 1px " + edge + "}";
  }
  if(gal){
    css += ".paper-break{color:" + main + " !important}" +
           ".paper-break::after{background:" + line + " !important}" +
           ".paper-break-count{color:" + muted + " !important}" +
           ".mode-switch{box-shadow:" + ring + "}" +
           ".gallery-image{box-shadow:0 0 0 1px " + edge + "}" +
           ".paper-break-dl{box-shadow:" + ring + "}";
  }
  var home = path === "index.html" || path === "";
  if(home){
    css += ".archive-stats,.featured-card,.featured-video-card,.card:not(.all-research),.sx-gear,.video-credit-button{box-shadow:" + ring + "}.card.all-research{border-color:" + edge + " !important}" +
           ".card{color:" + main + " !important}" +
           ".featured-title,.featured-video-title,.featured-read,.archive-stat-number{color:" + main + " !important}" +
           ".featured-label,.featured-video-label,.featured-category,.category-note,.archive-stat-label,.featured-video-meta{color:" + muted + " !important}" +
           "#searchBox{box-shadow:" + ring + "}" +
           ".footer-links .footer-nav{border-color:" + edge + " !important}";
  }
  if(path === "discover.html"){
    css += ".quiz-card,.result-card,.result-why,.quiz-option-tag,.quiz-option{box-shadow:" + ring + "}" +
           ".result-title,.quiz-question{color:" + main + " !important}" +
           ".discover-header p,.result-category{color:" + muted + " !important}" +
           ".result-why b{color:" + main + " !important}";
  }
  if(path === "research-timeline.html"){
    css += ".paper-card,.category-btn{box-shadow:" + ring + "}.legend{box-shadow:inset 0 1px 0 " + edge + "}" +
           ".paper-description{box-shadow:0 12px 30px rgba(0,0,0,.65)," + ring + "}" +
           ".paper-title,.description-label{color:" + main + " !important}" +
           ".subtitle,.timeline-meta,.paper-count,.list-year,.paper-category{color:" + muted + " !important}";
  }
  if(view){
    css += "#toolbar{box-shadow:inset 0 -1px 0 " + edge + "}" +
           "#titleBar{box-shadow:inset 0 1px 0 " + edge + "}" +
           ".title-text{color:" + main + " !important}" +
           ".toolButton,.zoomControls,.pageControls,.videoNavGroup{box-shadow:" + ring + "}" +
           ".toolButton svg,.videoCtrlBtn:not(#videoPlayPauseBtn) svg{color:" + main + "}" +
           ".videoTimeLabel{color:" + muted + " !important}";
  }
  return css;
}

/* The accent itself: buttons, the selected tab, the back arrow, text selection, focus rings and scroll bars.
   Written after the colors are mapped, so it is never re-mapped. */
function accentCss(){
  var old = document.getElementById("ltAccentCss");
  var A = TE.accent;
  if(A == null){ if(old) old.remove(); return; }
  var L = TE.T.light;
  var main = "hsl(" + A + ",85%," + (L ? "34%" : "64%") + ")";
  var btn = "hsl(" + A + "," + (L ? "75%,86%" : "42%,27%") + ")";
  var btnH = "hsl(" + A + "," + (L ? "75%,80%" : "46%,33%") + ")";
  var edge = "hsl(" + A + "," + (L ? "55%,68%" : "45%,40%") + ")";
  var soft = "hsla(" + A + ",85%," + (L ? "40%" : "60%") + ",.28)";
  var txt = L ? "#1a1a1a" : "#fff";
  var css =
    "html{accent-color:" + main + ";scrollbar-color:" + edge + " transparent}" +
    "::selection{background:" + soft + "}" +
    ".button:not(.danger):not(.secondary),.btn:not(.danger):not(.secondary),.small{background:" + btn + " !important;color:" + txt + " !important;box-shadow:inset 0 0 0 1px " + edge + "}" +
    ".button:not(.danger):not(.secondary):hover,.btn:not(.danger):not(.secondary):hover,.small:hover{background:" + btnH + " !important}" +
    ".mode-pill{background:" + btn + " !important;box-shadow:inset 0 0 0 1px " + edge + " !important}" +
    ".back,.back-arrow{color:" + main + " !important}" +
    ".email a svg{color:" + main + " !important}.email a:hover{border-color:" + edge + " !important}" +
    ".paper-option.active,.sort-option.active,.ltOpt.active{background:" + btn + " !important;color:" + txt + " !important}" +
    ".ltOpt .ltOptCheck,.ltPickCaret{color:" + main + "}" +
    ".ltPickCaret{border-top-color:" + main + "}" +
    ".ltPrimary{background:" + (L ? main : "hsl(" + A + ",70%,46%)") + " !important;border-color:" + main + " !important;color:#fff !important}" +
    ".ltModal a:not(.ltPrimary){color:" + main + " !important}" +
    ".back-link,.home-button{color:" + main + " !important}" +
    ".share-button,.top-button,.quiz-stage button{background:" + btn + " !important;color:" + txt + " !important;box-shadow:inset 0 0 0 1px " + edge + "}" +
    ".share-button:hover,.top-button:hover,.quiz-stage button:hover{background:" + btnH + " !important}" +
    ".progress-fill{background:" + main + " !important}" +
    ".pv-ico,.pv-tick{color:" + main + " !important}.pv-ico{background:" + soft + " !important}" +
    ".download-button{background:" + btn + " !important;color:" + txt + " !important;box-shadow:inset 0 0 0 1px " + edge + "}" +
    ".download-button:hover{background:" + btnH + " !important}" +
    ".progress-percent.finished,.progress-text.finished,.status.finished,.download-warning.finished strong{color:" + main + " !important}" +
    ".download-warning.finished{background:" + soft + " !important;border-color:" + edge + " !important}" +
    ".paper-link{color:" + main + " !important}" +
    (/^(about|contact|download|privacy|settings|storage)\.html$/.test(path) ? ".card h2{color:" + main + " !important}.card{box-shadow:inset 0 0 0 1px " + edge + "}" : "") +
    ":focus-visible{outline-color:" + main + " !important}" +
    ".paper-dl.open,.paper-break-dl.open{color:" + main + " !important}";
  if(accentStrong()) css += boostCss(main, edge, soft, A, L);
  if(!old){ old = document.createElement("style"); old.id = "ltAccentCss"; }
  old.textContent = css;
  (document.head || root).appendChild(old);   // last in the head, so it wins
}
/* The four home buttons keep their own colors in every theme. In the light themes their text needs a darker shade. */
function homeCss(){
  var old = document.getElementById("ltHomeCss");
  if(!(path === "index.html" || path === "") || !TE.T.light){ if(old) old.remove(); return; }
  var b = {favorites:["196,146,0","110,78,0"], media:["214,32,54","158,18,38"], discover:["120,76,224","84,44,176"], timeline:["30,110,230","20,76,170"]};
  var css = "";
  for(var k in b){
    css += ".research-tools ." + k + "-button{--btn:" + b[k][0] + ";--btn-text:" + b[k][1] + "}";
    css += ".research-tools ." + k + "-button:hover,.research-tools ." + k + "-button:focus-visible{background:rgba(var(--btn),.2);" +
      "border-color:rgb(var(--btn));color:rgb(var(--btn-text));box-shadow:0 0 14px rgba(var(--btn),.22)}";
  }
  if(!old){ old = document.createElement("style"); old.id = "ltHomeCss"; }
  old.textContent = css;
  (document.head || root).appendChild(old);
}
function applyTheme(){
  var name = themeName(), acc = accentName();
  TE.T = THEME_DEFS[name];
  TE.accent = ACCENT_HUE[acc];
  TE.active = name !== "dark" || acc !== "default";
  setTint();
  accentCss();
  homeCss();
  root.setAttribute("data-lt-theme", name);
  root.style.colorScheme = TE.T.light ? "light" : "";
  if(TE.active || TE.store.length){
    processAllSheets();
    TE.store.forEach(function(rec){ applyProps(rec.st, rec.props, rec.sel); });
    var all = document.querySelectorAll("[style],[fill],[stroke],[stop-color]");
    for(var i = 0; i < all.length; i++){
      if(all[i].hasAttribute("style")) inlineApply(all[i]);
      attrApply(all[i]);
    }
    watch();
  }
  var meta = document.querySelector('meta[name="theme-color"]');
  if(meta){
    if(!meta.hasAttribute("data-lt-orig")) meta.setAttribute("data-lt-orig", meta.getAttribute("content") || "#111111");
    var base = meta.getAttribute("data-lt-orig");
    meta.setAttribute("content", TE.active ? mapValue(base, {shadow:false, keepText:false, kept:false}) : base);
  }
}
function applyText(){
  if(VIEWER) return;
  var z = parseFloat(get("lt_text")) || 1;
  root.style.zoom = z === 1 ? "" : String(z);
}
applyText();
/* A page restored from the back button, or another open tab changing the setting, picks up the current theme. */
window.addEventListener("pageshow", function(e){
  if(e.persisted){ try{ applyTheme(); applyText(); }catch(x){} }
});
window.addEventListener("storage", function(e){
  if(!e.key || /^lt_(theme|accent|accent_strong|text)$/.test(e.key)){ try{ applyTheme(); applyText(); }catch(x){} }
});

/* Hide the page for a moment (in the right background color) so a
   chosen theme never flashes the dark one first. */
{
  var first = THEME_DEFS[themeName()], firstAcc = accentName();
  if(themeName() !== "dark" || firstAcc !== "default"){
    TE.T = first; TE.accent = ACCENT_HUE[firstAcc]; TE.active = true; setTint();
    var bg = mapValue("#111111", {shadow:false, keepText:false, kept:false});
    TE.hold = document.createElement("style");
    TE.hold.textContent = "html{background:" + bg + " !important}body{visibility:hidden !important}";
    (document.head || root).appendChild(TE.hold);
    root.setAttribute("data-lt-theme", themeName());
    var release = function(){ if(TE.hold){ TE.hold.remove(); TE.hold = null; } };
    var go = function(){ try{ applyTheme(); }catch(e){} release(); };
    if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", go); else go();
    setTimeout(release, 4000);
  }
}

/* One icon set for every menu: each item has its own, drawn from a CSS mask so it follows the text color
   (and the theme) and survives a page rewriting the item's text. */
var ICON_PATHS = {
  download:   '<path d="M12 4v11"/><path d="M7.5 11 12 15.5 16.5 11"/><path d="M5 20h14"/>',
  newtab:     '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  share:      '<path d="M12 15V4"/><path d="M8 8l4-4 4 4"/><path d="M5 13v6h14v-6"/>',
  fullscreen: '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
  link:       '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  doc:        '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/>',
  more:       '<circle cx="5.5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="18.5" cy="12" r="1.4"/>',
  quote:      '<path d="M7 7h4v5c0 2.5-1.5 4.2-4 4.6"/><path d="M14 7h4v5c0 2.5-1.5 4.2-4 4.6"/>',
  flag:       '<path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/>',
  image:      '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M4 18l5-5 4 4 3-3 4.5 4.5"/>',
  video:      '<rect x="3" y="5.5" width="14" height="13" rx="2"/><path d="M17 10.5l4-2.5v8l-4-2.5"/>',
  media:      '<rect x="3.5" y="6.5" width="14" height="12" rx="2"/><path d="M7 3.5h13a1 1 0 0 1 1 1V15"/><path d="M8 15l3-3 2 2 2-2 2.5 3"/>'
};
function iconCss(){
  function url(n){
    return 'url("data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round">' + ICON_PATHS[n] + '</svg>') + '")';
  }
  var map = [
    ["#menu #downloadBtn", "download"], ["#menu #newTabBtn", "newtab"], ["#menu #shareBtn,#menu #copyLinkBtn", "share"],
    ["#menu #fullscreenBtn", "fullscreen"], ["#menu #linkOpenBtn", "link"], ["#menu #pdfButton", "doc"], ["#menu #moreBtn", "more"],
    ["#menu .moreOpt[data-lt=\"cite\"]", "quote"], ["#menu .moreOpt[data-lt=\"report\"]", "flag"],
    [".ltOpt[data-ico=\"pdf\"]", "doc"], [".ltOpt[data-ico=\"images\"]", "image"], [".ltOpt[data-ico=\"videos\"]", "video"], [".ltOpt[data-ico=\"media\"]", "media"]
  ];
  var out = "";
  map.forEach(function(m){
    var sels = m[0].split(",").map(function(x){ return x + "::before"; }).join(",");
    out += sels + "{content:\"\";flex:0 0 auto;display:inline-block;width:18px;height:18px;margin-right:12px;vertical-align:-4px;background:currentColor;opacity:.85;" +
      "-webkit-mask:" + url(m[1]) + " center/contain no-repeat;mask:" + url(m[1]) + " center/contain no-repeat}";
  });
  out += "#menu .moreOpt::before{margin-right:0;vertical-align:baseline}.ltOpt[data-ico]::before{width:16px;height:16px;margin-right:2px;vertical-align:baseline}" +
         ".ltOpt[data-ico]>span:first-of-type{flex:1 1 auto}";
  return out;
}

var css = document.createElement("style");
css.textContent =
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
  /* "More" in the viewers' menus: a row that opens a second panel with its own back row */
  '#menu #moreBtn{display:flex;align-items:center;justify-content:flex-start}' +
  '#menu .moreChev{flex:0 0 auto;width:7px;height:7px;margin:0 3px 0 auto;border-top:2px solid currentColor;border-right:2px solid currentColor;' +
    'transform:rotate(45deg);opacity:.65}' +
  '#menu .moreList{display:none;flex-direction:column}' +
  '#menu.ltSub > :not(#moreList){display:none !important}' +
  '#menu.ltSub .moreList{display:flex}' +
  '#menu .moreHead{display:flex;align-items:center;gap:10px;margin:0 0 6px !important;padding:8px 8px !important;background:transparent !important;' +
    'border:0 !important;box-shadow:none !important;border-radius:8px;font-weight:600;color:inherit}' +
  '#menu .moreHead:hover{background:rgba(128,128,128,.16) !important}' +
  '#menu .moreHead .moreChev{transform:rotate(-135deg);margin:0 0 0 3px}' +
  '#menu .moreOpt{display:flex;align-items:center;gap:12px;padding-top:9px !important;padding-bottom:9px !important}' +
  '#menu .moreTxt{display:flex;flex-direction:column;gap:2px;min-width:0;line-height:1.25}' +
  '#menu .moreTxt b{font-weight:600;font-size:.95em}' +
  '#menu .moreTxt small{font-size:.78em;opacity:.62;font-weight:400}' +
  '.ltDanger{display:block;box-sizing:border-box;width:100%;margin:0 0 8px;padding:11px 10px;border:1px solid #5a2c2c;border-radius:8px;' +
    'background:transparent;color:#ff8080;font:14px Arial,sans-serif;text-align:center;cursor:pointer}' +
  '.ltDanger:hover{background:#301a1a;border-color:#7a3a3a}' +
  '.ltSecondary{display:block;box-sizing:border-box;width:100%;margin:0 0 8px;padding:11px 10px;border:0;border-radius:8px;' +
    'background:#2e2e2e;color:#eee;font:14px Arial,sans-serif;text-align:center;cursor:pointer}' +
  '.ltSecondary:hover{background:#383838}' +
  '.ltCite{box-sizing:border-box;margin:0 0 12px;padding:10px 12px;background:#1d1d1d;color:#eee;border:1px solid #333;border-radius:10px;' +
    'font:13px/1.5 Arial,sans-serif;word-break:break-word;user-select:text;-webkit-user-select:text}' +
  '.ltCite.ltMono{font:12px/1.45 Consolas,Menlo,monospace;white-space:pre-wrap}' +
  '.ltOptNote{color:#777;font-size:12px}' +
  '.ltCancel{display:block;margin:2px auto 0;padding:6px;background:transparent;border:0;color:#999;font:12px Arial,sans-serif;cursor:pointer}' +
  '.ltCancel:hover{color:#ccc}' +

  /* small confirmation message */
  '.ltToast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:9990;max-width:calc(100vw - 32px);' +
    'padding:10px 16px;background:#222;border:1px solid #333;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.5);' +
    'color:#eee;font:13.5px Arial,sans-serif;text-align:center}' + iconCss();
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
function modal(titleHtml, bodyHtml, onClose){
  var back = el("div", {"class":"ltModalBack"});
  var box = el("div", {"class":"ltModal", role:"dialog", "aria-modal":"true"}, titleHtml + bodyHtml);
  back.appendChild(box);
  var closed = false;
  function close(){
    if(closed) return;
    closed = true;
    closePopup(); back.remove(); document.removeEventListener("keydown", onKey, true);
    if(onClose) onClose();
  }
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
/* The text-size setting zooms the whole page, and a fixed popup's left/top are zoomed with it. These give
   positions in the page's own (unzoomed) pixels, so a popup lands exactly on the button that opened it. */
function zoomF(){ var z = parseFloat(root.style.zoom); return z > 0 ? z : 1; }
function cssRect(elm){
  var r = elm.getBoundingClientRect(), z = zoomF();
  return {left:r.left / z, top:r.top / z, right:r.right / z, bottom:r.bottom / z, width:r.width / z, height:r.height / z};
}
function vw(){ return window.innerWidth / zoomF(); }
function vh(){ return window.innerHeight / zoomF(); }
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
    var r = cssRect(row), w = Math.min(190, vw() - 24);
    pop.style.maxWidth = (vw() - 24) + "px";
    var left = Math.max(12, Math.min(r.left + r.width / 2 - w / 2, vw() - w - 12));
    pop.style.left = left + "px";
    var below = vh() - r.bottom - 8, above = r.top - 8;
    if(below >= 160 || below >= above){ pop.style.top = (r.bottom + 8) + "px"; }
    else{ pop.style.bottom = (vh() - r.top + 8) + "px"; }
    row.classList.add("open");
    row.setAttribute("aria-expanded", "true");
    popup = {el:pop, row:row};
  });
  return paint;
}
document.addEventListener("click", function(){ closePopup(); });
/* A page's own buttons stop clicks from travelling on, so also watch in the capture phase:
   a tap on anything except the popup or the button that opened it closes the popup. */
document.addEventListener("click", function(e){
  if(!popup) return;
  var t = e.target;
  if(t && t.nodeType === 1 && (popup.el.contains(t) || popup.row.contains(t))) return;
  closePopup();
}, true);
// Scrolling the page (or anything else) closes an open popup, like tapping elsewhere does.
window.addEventListener("scroll", function(e){
  if(popup && !(e.target && e.target.nodeType === 1 && popup.el.contains(e.target))) closePopup();
}, true);
window.addEventListener("touchmove", function(e){
  if(popup && !popup.el.contains(e.target)) closePopup();
}, {capture:true, passive:true});
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
  var author = "Lanthano Research";
  var kind = item.type === "image" ? "Image" : item.type === "video" ? "Video" : "PDF";
  // Only the paper itself has a known date. A picture or video inside it
  // does not, so those are cited as undated ("n.d.").
  if(item.type !== "paper") d = null;
  var title = String(item.title || "Untitled").replace(/\*/g, "").trim();
  var url = item.url;
  var bare = url.replace(/^https?:\/\//, "");
  function end(t){ return /[.?!]$/.test(t) ? t : t + "."; }
  function pad(n){ return (n < 10 ? "0" : "") + n; }

  var M = MONTHS;
  var MLA_M = ["Jan.","Feb.","Mar.","Apr.","May","June","July","Aug.","Sept.","Oct.","Nov.","Dec."];
  var IEEE_M = ["Jan.","Feb.","Mar.","Apr.","May","Jun.","Jul.","Aug.","Sep.","Oct.","Nov.","Dec."];

  var apaDate = d ? "(" + d.y + ", " + M[d.m-1] + " " + d.d + ")" : "(n.d.)";
  var mlaDate = d ? d.d + " " + MLA_M[d.m-1] + " " + d.y : "";
  var chiDate = d ? M[d.m-1] + " " + d.d + ", " + d.y : "";
  var harDate = d ? String(d.y) : "n.d.";
  var ieeeDate = d ? IEEE_M[d.m-1] + " " + d.d + ", " + d.y : "";
  var accessedLong = a.d + " " + M[a.m-1] + " " + a.y;          // Harvard
  var accessedMla = a.d + " " + MLA_M[a.m-1] + " " + a.y;
  var accessedChi = M[a.m-1] + " " + a.d + ", " + a.y;
  var accessedIeee = IEEE_M[a.m-1] + " " + a.d + ", " + a.y;

  // *text* marks italics.
  var apa = author + ". " + apaDate + ". *" + title + "* [" + kind + "]. " + url;
  var mla = "“" + end(title) + "” *" + author + "*, " + (mlaDate ? mlaDate + ", " : "") + bare + ". Accessed " + accessedMla + ".";
  var chi = author + ". “" + end(title) + "” " + (chiDate ? chiDate + ". " : "") + url + "." + (chiDate ? "" : " Accessed " + accessedChi + ".");
  var har = author + " (" + harDate + ") *" + title + "* [" + kind + "]. Available at: " + url + " (Accessed: " + accessedLong + ").";
  var ieee = author + ", “" + title.replace(/[.,]$/, "") + ",” " + author + (ieeeDate ? ", " + ieeeDate : "") + ". Accessed: " + accessedIeee + ". [Online]. Available: " + url;

  function bibEsc(s){ return String(s).replace(/([&%$#_])/g, "\\$1").replace(/[{}]/g, ""); }
  var key = "lanthano" + (d ? d.y : "nd") + title.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 16);
  var bib = "@misc{" + key + ",\n" +
    "  author       = {{" + author + "}},\n" +
    "  title        = {{" + bibEsc(title) + "}},\n" +
    (d ? "  year         = {" + d.y + "},\n  month        = " + M[d.m-1].slice(0,3).toLowerCase() + ",\n" : "") +
    "  howpublished = {\\url{" + url + "}},\n" +
    "  note         = {" + kind + ". Accessed: " + a.y + "-" + pad(a.m) + "-" + pad(a.d) + "}\n}";

  function rich(s){ return {text: s.replace(/\*/g, ""), html: esc(s).replace(/\*([^*]+)\*/g, "<i>$1</i>")}; }
  return [
    {name:"APA 7", c: rich(apa)},
    {name:"MLA 9", c: rich(mla)},
    {name:"Chicago 17", c: rich(chi)},
    {name:"Harvard", c: rich(har)},
    {name:"IEEE", c: rich(ieee)},
    {name:"BibTeX", c: {text: bib, html: esc(bib), mono: true}},
    {name:"Link", c: {text: url, html: esc(url)}}
  ];
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
    var list = buildCitations(item, paper);
    var opts = list.map(function(x){ return {value:x.name, label:x.name}; });
    /* remember the format you used last, for every paper, picture and video */
    var cur = list[0].name, saved = get("lt_cite_format");
    if(saved && list.some(function(x){ return x.name === saved; })) cur = saved;
    var box = modal('<h3>' + (item.type === "paper" ? "Reference PDF" : item.type === "image" ? "Reference image" : "Reference video") + '</h3>',
      '<p class="ltSub">' + esc(item.title) + '</p>' +
      '<button type="button" class="ltPickRow" id="ltFmt">' + pickerRowHtml("Format") + '</button>' +
      '<div class="ltCite" id="ltCite" tabindex="0" aria-label="Reference"></div>' +
      '<button type="button" class="ltPrimary" data-act="copy">Copy</button>' +
      '<button type="button" class="ltCancel" data-act="close">Close</button>' +
      sourcesHtml(paper));
    var out = box.querySelector("#ltCite");
    function now(){ return list.filter(function(x){ return x.name === cur; })[0].c; }
    function show(){
      var c = now();
      out.innerHTML = c.html;
      out.classList.toggle("ltMono", !!c.mono);
    }
    bindPicker(box.querySelector("#ltFmt"), opts, function(){ return cur; }, function(v){ cur = v; set("lt_cite_format", v); show(); });
    show();
    box.addEventListener("click", function(e){
      var b = e.target.closest("[data-act]"); if(!b) return;
      if(b.dataset.act === "copy") copyRich(now());
      else box.__close();
    });
  });
}
/* Copies plain text, plus the same text with its italics when the
   browser allows it (so a pasted reference in Word keeps them). */
function copyRich(c){
  try{
    if(!c.mono && window.ClipboardItem && navigator.clipboard && navigator.clipboard.write){
      var item = new ClipboardItem({
        "text/plain": new Blob([c.text], {type:"text/plain"}),
        "text/html": new Blob([c.html], {type:"text/html"})
      });
      navigator.clipboard.write([item]).then(function(){ toast("Copied"); }, function(){ copy(c.text); });
      return;
    }
  }catch(e){}
  copy(c.text);
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
var SKIP = /^(savedVideoLog|videoSaveLock|videosWatched|keepAllLast|keepAllLock|archiveStatsCache|archiveFileSizes|lt_seen|lt_hit|lt_last_backup)/;
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
  set("lt_last_backup", new Date().toISOString());
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

var THEMES = [
  {value:"dark", label:"Dark"}, {value:"light", label:"Light"}, {value:"sepia", label:"Sepia"},
  {value:"midnight", label:"Midnight"}, {value:"forest", label:"Forest"}, {value:"auto", label:"Automatic"}
];
var ACCENTS = [
  {value:"default", label:"Default"}, {value:"blue", label:"Blue"}, {value:"teal", label:"Teal"}, {value:"green", label:"Green"},
  {value:"orange", label:"Orange"}, {value:"red", label:"Red"}, {value:"purple", label:"Purple"}, {value:"pink", label:"Pink"}
];
var SIZES = [{value:"0.9", label:"Small"}, {value:"1", label:"Normal"}, {value:"1.15", label:"Large"}, {value:"1.3", label:"Larger"}];

function themeValue(){ return get("lt_theme") || "dark"; }
function accentValue(){ return accentName(); }
function sizeValue(){
  var z = String(parseFloat(get("lt_text")) || 1);
  return SIZES.some(function(o){ return o.value === z; }) ? z : "1";
}
function setTheme(v){ set("lt_theme", v); applyTheme(); }
function setAccent(v){ set("lt_accent", v); applyTheme(); }
function setSize(v){ set("lt_text", v); applyText(); }

/* Rows for any container; returns nothing. */
function addAppearanceRows(container){
  var t = el("button", {type:"button", "class":"ltPickRow videoPickerRow"}, pickerRowHtml("Theme"));
  var c = el("button", {type:"button", "class":"ltPickRow videoPickerRow"}, pickerRowHtml("Accent color"));
  var z = el("button", {type:"button", "class":"ltPickRow videoPickerRow"}, pickerRowHtml("Text size"));
  container.appendChild(t);
  container.appendChild(c);
  container.appendChild(z);
  var paints = [bindPicker(t, THEMES, themeValue, setTheme), bindPicker(c, ACCENTS, accentValue, setAccent), bindPicker(z, SIZES, sizeValue, setSize)];
  repaintAppearance = function(){ paints.forEach(function(f){ f(); }); };
}
var repaintAppearance = function(){};
/* Back to the original look: dark theme, no accent, normal text size. */
function resetAppearance(){
  try{ localStorage.removeItem("lt_theme"); localStorage.removeItem("lt_accent"); localStorage.removeItem("lt_text"); localStorage.removeItem("lt_accent_strong"); }catch(e){}
  applyTheme(); applyText(); repaintAppearance();
  toast("Appearance reset");
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
  /* same size as the pickers in category: as narrow as the entries allow, never wider than 250px */
  pop.style.width = "max-content";
  pop.style.minWidth = "190px";
  items.forEach(function(it){
    var b = el("button", {type:"button", "class":"ltOpt", role:"menuitem", "data-ico": it.icon || ""},
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
  pop.style.maxWidth = Math.min(250, vw() - 28) + "px";
  var r = cssRect(anchor), w = pop.getBoundingClientRect().width / (zoomF ? zoomF() : 1);
  pop.style.left = Math.max(14, Math.min(r.right - w, vw() - w - 14)) + "px";
  var gap = 10, below = vh() - r.bottom - gap, above = r.top - gap;
  if(below >= 150 || below >= above){ pop.style.top = (r.bottom + gap) + "px"; }
  else{ pop.style.bottom = (vh() - r.top + gap) + "px"; }
  anchor.classList.add("open");
  anchor.setAttribute("aria-expanded", "true");
  popup = {el:pop, row:anchor};
  // lets the page close its own panels (settings, sort ...) so only one menu is ever open
  try{ document.dispatchEvent(new CustomEvent("ltpopupopen", {detail:{anchor:anchor}})); }catch(e){}
}

/* A centred prompt with a few choices. buttons: [{label, primary, onClick}] */
function ask(title, text, buttons){
  var box = modal('<h3>' + esc(title) + '</h3>', '<p>' + esc(text) + '</p>');
  buttons.forEach(function(b){
    var n = el("button", {type:"button", "class": b.primary ? "ltPrimary" : "ltSecondary"}, esc(b.label));
    if(b.primary) n.style.marginBottom = "8px";
    n.addEventListener("click", function(){ box.__close(); b.onClick(); });
    box.appendChild(n);
  });
  var c = el("button", {type:"button", "class":"ltCancel"}, "Cancel");
  c.addEventListener("click", function(){ box.__close(); });
  box.appendChild(c);
  return box;
}

/* One confirmation step; resolves true only when the red button is pressed. */
function confirmStep(title, text, label, danger){
  return new Promise(function(resolve){
    var chosen = false;
    var box = modal('<h3>' + esc(title) + '</h3>', '<p>' + esc(text) + '</p>', function(){ if(!chosen) resolve(false); });
    var b = el("button", {type:"button", "class": danger ? "ltDanger" : "ltPrimary"}, esc(label));
    b.addEventListener("click", function(){ chosen = true; box.__close(); resolve(true); });
    box.appendChild(b);
    var c = el("button", {type:"button", "class":"ltCancel"}, "Cancel");
    c.addEventListener("click", function(){ box.__close(); });
    box.appendChild(c);
  });
}
/* Anything that deletes data asks twice, each time in its own popup. */
function confirmDelete(title, text, label){
  return confirmStep(title, text, label, true).then(function(ok){
    if(!ok) return false;
    return confirmStep("Are you sure?", "This permanently removes it from this device and cannot be undone.", "Yes, " + label.charAt(0).toLowerCase() + label.slice(1), true);
  });
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

/* paper: {title, url, images:[], videos:[{file, source}]} */
function downloadMenu(anchor, paper){
  var imgs = realList(paper.images).length, vids = realList(paper.videos).length;
  var items = [{label:"PDF", note:".pdf", icon:"pdf", onClick:function(){ downloadPdf(paper); }}];
  if(imgs) items.push({label:"All images (" + imgs + ")", note:".zip", icon:"images", onClick:function(){ zipImages(paper); }});
  if(vids) items.push({label:"All videos (" + vids + ")", note:".zip", icon:"videos", onClick:function(){ zipVideos(paper); }});
  menu(anchor, items);
}

/* A section of a gallery: one entry, named for what the section holds. */
function mediaMenu(anchor, title, images, videos){
  var ni = realList(images).length, nv = realList(videos).length;
  if(!ni && !nv){ toast("Nothing to download here"); return; }
  var items = [];
  if(ni) items.push({label: nv ? "Images (" + ni + ")" : "Download images (" + ni + ")", note:".zip", icon:"images", onClick:function(){ zipAssets(title, images, []); }});
  if(nv) items.push({label: ni ? "Videos (" + nv + ")" : "Download videos (" + nv + ")", note:".zip", icon:"videos", onClick:function(){ zipAssets(title, [], videos); }});
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

var ZIP_LIMIT = 1.8e9;    // bytes: more than this will not fit in a browser tab
var zipBusy = false;
function safeName(s){ return String(s || "download").replace(/[\\/:*?"<>|]+/g, "-").trim() || "download"; }

/* The bytes of one video: from the site's own folder, or (the usual case)
   through the same short-lived link the video page uses to play it. */
function fetchVideo(v){
  var file = v.file.trim();
  if(v.source === "site"){
    return fetch(encPath(file));
  }
  return fetch(API + "/ticket?f=" + encodeURIComponent(file), {cache:"no-store"}).then(function(r){
    if(!r.ok) throw new Error("ticket");
    return r.json();
  }).then(function(j){ return fetch(API + "/play?t=" + encodeURIComponent(j.t)); });
}

/* images: [path]  videos: [{file, source}]  -> one .zip */
function zipAssets(title, images, videos){
  if(zipBusy){ toast("A download is already in progress"); return; }
  images = realList(images); videos = realList(videos);
  var total = images.length + videos.length;
  if(!total){ toast("Nothing to download here"); return; }
  var both = images.length && videos.length;
  var tasks = [];
  images.forEach(function(p){ tasks.push({folder: both ? "Images/" : "", name: baseName(p), kind:"image", get: function(){ return fetch(encPath(p)); }}); });
  videos.forEach(function(v){ tasks.push({folder: both ? "Videos/" : "", name: baseName(v.file), kind:"video", get: function(){ return fetchVideo(v); }}); });

  zipBusy = true;
  var note = el("div", {"class":"ltToast"}, "Preparing… 0 of " + total);
  document.body.appendChild(note);
  var files = [], used = {}, failed = 0, tooBig = 0, bytes = 0, done = 0;

  function next(i){
    if(i >= tasks.length) return Promise.resolve();
    var t = tasks[i];
    return t.get().then(function(r){
      var type = r.headers.get("content-type") || "";
      if(!r.ok || (t.kind === "image" && /text\/html/i.test(type))) throw new Error("missing");
      var len = parseInt(r.headers.get("content-length") || "0", 10);
      if(len && bytes + len > ZIP_LIMIT){ tooBig++; return null; }
      return r.arrayBuffer();
    }).then(function(buf){
      if(!buf) return;
      if(bytes + buf.byteLength > ZIP_LIMIT){ tooBig++; return; }
      bytes += buf.byteLength;
      var name = t.name, base = name, n = 1;
      while(used[(t.folder + name).toLowerCase()]){ n++; name = base.replace(/(\.[^.]*)?$/, " (" + n + ")$1"); }
      used[(t.folder + name).toLowerCase()] = 1;
      files.push({name: t.folder + name, data: new Uint8Array(buf)});
    }).catch(function(){ failed++; }).then(function(){
      done++;
      note.textContent = "Preparing… " + done + " of " + total;
      return next(i + 1);
    });
  }
  return next(0).then(function(){
    note.remove();
    if(!files.length){ toast(tooBig ? "These files are too large to put in one zip" : "Could not load anything to download"); return; }
    saveBlob(makeZip(files), safeName(title) + " - " + (both ? "media" : images.length ? "images" : "videos") + ".zip");
    var missed = failed + tooBig;
    toast(missed ? "Saved " + files.length + " of " + total + (tooBig ? " (" + tooBig + " too large for one zip)" : " (" + failed + " could not be loaded)")
                 : "Saved " + files.length + " file" + (files.length === 1 ? "" : "s") + " in a zip");
  }).then(function(){ zipBusy = false; }, function(){ zipBusy = false; note.remove(); });
}
function zipImages(paper){ return zipAssets(paper && paper.title, paper && paper.images, []); }
function zipVideos(paper){ return zipAssets(paper && paper.title, [], paper && paper.videos); }

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
  collapseMore();
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

/* ---------------------------------------------------------------
   Saving videos you open (shared by the video page, Storage and every page)
   Only a video you open is kept on this device (nothing else is ever fetched),
   so it doesn't have to load again. The download carries on from whichever
   page is open, so leaving the video page early doesn't lose it: the next page
   picks it up.
   How often it tries (nothing limits how MANY videos get saved):
   - one video at a time, the watched one first;
   - a video that fails is tried again after 5 minutes, then after 1 hour; after
     a third failure it rests for 3 days. Other videos carry on meanwhile;
   - "limit reached" from the video server pauses everything for an hour;
     a full disk pauses for 6 hours;
   - an opened video is saved on any connection (data saver / offline excepted).
--------------------------------------------------------------- */
var VS = {
  CACHE: "lanthano-saved-videos", STATE: "savedVideoLog2", WATCH: "videosWatched", OFF: "savedVideosOff",
  LOCK: "videoSaveLock", API: "https://videos.lanthanoresearch.com",
  HEADROOM: 300 * 1024 * 1024, MAXBYTES: 3 * 1024 * 1024 * 1024, RETRY: [5 * 60000, 60 * 60000], REST: 3 * 86400000,
  catalog: null, running: false
};
function vsOff(){ try{ return localStorage.getItem(VS.OFF) === "1"; }catch(e){ return false; } }
function vsKey(file){ return new URL("/__video/" + encodeURIComponent(file), location.origin).href; }
function vsState(){ try{ return JSON.parse(localStorage.getItem(VS.STATE) || "{}") || {}; }catch(e){ return {}; } }
function vsWrite(s){ try{ localStorage.setItem(VS.STATE, JSON.stringify(s)); }catch(e){} }
function vsWatched(){ try{ return JSON.parse(localStorage.getItem(VS.WATCH) || "{}") || {}; }catch(e){ return {}; } }
function vsOnline(){ return navigator.onLine !== false; }
function vsMetered(){
  var c = navigator.connection;
  return !!(c && (c.saveData || /^(slow-2g|2g)$/.test(c.effectiveType || "") || c.type === "cellular"));
}
function vsCatalog(){
  if(VS.catalog) return Promise.resolve(VS.catalog);
  return fetch("/descriptions.json", {cache:"no-cache"}).then(function(r){ return r.json(); }).then(function(d){
    var list = [], seen = {};
    Object.keys(d).forEach(function(k){
      ((d[k] && d[k].videos) || []).forEach(function(v){
        if(!v || typeof v.file !== "string") return;
        var f = v.file.trim();
        if(!f || f.indexOf("#$") === 0 || seen[f]) return;
        seen[f] = 1;
        list.push({file:f, paper:k, group:v.group || "", title:v.title || f.split("/").pop().replace(/\.[a-z0-9]+$/i, ""), site:v.source === "site", ver:String(v.v === undefined ? "" : v.v), size:Number(v.size) || 0});
      });
    });
    VS.catalog = list;
    return list;
  }).catch(function(){ return []; });
}
/* One video into storage: {size} | "quota" | "stop" | "fail" | "abort" */
async function vsFetch(v, signal, onBytes){
  try{
    var res;
    if(v.site){
      res = await fetch(new URL(v.file.split("/").map(encodeURIComponent).join("/"), location.origin + "/").href, {cache:"no-store", signal:signal});
    }else{
      var tk = await fetch(VS.API + "/ticket?f=" + encodeURIComponent(v.file), {cache:"no-store", signal:signal});
      if(tk.status === 429 || tk.status === 503) return "stop";
      if(!tk.ok) return "fail";
      var t = (await tk.json()).t;
      res = await fetch(VS.API + "/play?t=" + encodeURIComponent(t), {signal:signal});
      if(res.status === 429 || res.status === 503){ try{ res.body && res.body.cancel(); }catch(e){} return "stop"; }
    }
    var drop = function(){ try{ res.body && res.body.cancel(); }catch(e){} };
    if(res.status !== 200){ drop(); return "fail"; }
    var type = (res.headers.get("content-type") || "").toLowerCase();
    var len = Number(res.headers.get("content-length")) || 0;
    if(type && type.indexOf("video/") !== 0 && type.indexOf("octet-stream") < 0){ drop(); return "fail"; }
    if(len > VS.MAXBYTES){ drop(); return "fail"; }
    try{
      var est = await navigator.storage.estimate();
      if(est && est.quota && est.quota - (est.usage || 0) < len + VS.HEADROOM){ drop(); return "quota"; }
    }catch(e){}
    var out = res;
    if(res.body && res.body.getReader){
      var reader = res.body.getReader(), done = 0;
      out = new Response(new ReadableStream({
        pull: async function(ctrl){
          var r = await reader.read();
          if(r.done){ ctrl.close(); return; }
          done += r.value.length;
          try{ localStorage.setItem(VS.LOCK, String(Date.now())); }catch(e){}
          if(onBytes) onBytes(len ? Math.min(1, done / len) : 0);
          ctrl.enqueue(r.value);
        },
        cancel: function(reason){ return reader.cancel(reason); }
      }), {status:200, headers:res.headers});
    }
    var cache = await caches.open(VS.CACHE);
    try{
      await cache.delete(vsKey(v.file));
      await cache.put(vsKey(v.file), out);
    }catch(e){
      try{ await cache.delete(vsKey(v.file)); }catch(x){}
      if(signal.aborted) return "abort";
      return (e && e.name === "QuotaExceededError") ? "quota" : "fail";
    }
    var stored = await cache.match(vsKey(v.file));
    var blob = stored ? await stored.blob() : null;
    if(!blob || blob.size < 1024 || (len && blob.size !== len)){ await cache.delete(vsKey(v.file)); return "fail"; }
    return {size:blob.size};
  }catch(e){
    return signal && signal.aborted ? "abort" : "fail";
  }
}
/* Which videos should be saved right now, in order: the ones that were opened
   (the one just opened first) and aren't saved yet. */
async function vsPlan(focus){
  var cat = await vsCatalog();
  if(!cat.length || !("caches" in window)) return {todo:[], blocked:[]};
  var cache = await caches.open(VS.CACHE), st = vsState(), now = Date.now(), w = vsWatched();
  st.rec = st.rec || {};
  var by = {}; cat.forEach(function(v){ by[v.file] = v; });
  var order = [], seen = {};
  function add(v){ if(v && !seen[v.file]){ seen[v.file] = 1; order.push(v); } }
  var watchedFiles = Object.keys(w).filter(function(f){ return by[f]; }).sort(function(a, b){
    if(a === focus) return -1; if(b === focus) return 1;
    return ((w[b] && w[b].t) || 0) - ((w[a] && w[a].t) || 0);
  });
  watchedFiles.forEach(function(f){ add(by[f]); });   // only videos that were opened
  var todo = [], blocked = [], metered = vsMetered();
  for(var i = 0; i < order.length; i++){
    var v = order[i], rec = st.rec[v.file] || {};
    var have = await cache.match(vsKey(v.file));
    if(have && (rec.ver === undefined || rec.ver === v.ver)) continue;
    if(metered && navigator.connection && navigator.connection.saveData){ blocked.push({v:v, why:"data saver is on"}); continue; }
    if(rec.next && now < rec.next){ blocked.push({v:v, why:"will try again " + (rec.next - now < 3600000 ? "soon" : "later"), next:rec.next}); continue; }
    todo.push(v);
  }
  return {todo:todo, blocked:blocked};
}
/* opts: {focus, signal, auto, onStart(n), onItem(i,n,v,list), onBytes(i,n,f), onSaved(v)}
   Resolves {saved, failed, why: ""|"limit"|"space"|"paused"|"busy"|"stopped"|"off"|"offline"} */
async function vsRun(opts){
  opts = opts || {};
  var out = {saved:0, failed:0, why:""};
  if(vsOff()){ out.why = "off"; return out; }
  if(!vsOnline()){ out.why = "offline"; return out; }
  if(VS.running){ out.why = "busy"; return out; }
  try{ var lock = Number(localStorage.getItem(VS.LOCK)) || 0; if(Date.now() - lock < 60000){ out.why = "busy"; return out; } }catch(e){}
  if(!("caches" in window) || !navigator.storage){ return out; }
  var st = vsState();
  if(st.pauseUntil && Date.now() < st.pauseUntil){ out.why = (st.pauseWhy === "space") ? "space" : "limit"; return out; }
  VS.running = true;
  var signal = opts.signal || new AbortController().signal;
  var beat = function(){ try{ localStorage.setItem(VS.LOCK, String(Date.now())); }catch(e){} };
  try{
    beat();
    var plan = await vsPlan(opts.focus);
    var todo = plan.todo;
    if(opts.onStart) opts.onStart(todo.length);
    if(todo.length){ try{ if(navigator.storage.persist) navigator.storage.persist(); }catch(e){} }
    for(var i = 0; i < todo.length; i++){
      if(signal.aborted){ out.why = "stopped"; break; }
      if(vsOff()){ out.why = "off"; break; }
      var v = todo[i];
      if(opts.onItem) opts.onItem(i, todo.length, v, todo);
      var r = await vsFetch(v, signal, function(f){ if(opts.onBytes) opts.onBytes(i, todo.length, f); });
      if(r === "abort"){ out.why = "stopped"; break; }
      st = vsState(); st.rec = st.rec || {};
      var rec = st.rec[v.file] || (st.rec[v.file] = {}), now = Date.now();
      if(r === "quota"){ rec.last = {t:now, r:"space"}; st.pauseUntil = now + 6 * 3600000; st.pauseWhy = "space"; vsWrite(st); out.why = "space"; break; }
      if(r === "stop"){ rec.last = {t:now, r:"limit"}; st.pauseUntil = now + 3600000; st.pauseWhy = "limit"; vsWrite(st); out.why = "limit"; break; }
      if(r === "fail"){
        rec.fails = (rec.fails || 0) + 1;
        rec.last = {t:now, r:"fail"};
        if(rec.fails >= 3){ rec.next = now + VS.REST; rec.fails = 0; }
        else rec.next = now + VS.RETRY[rec.fails - 1];
        vsWrite(st); out.failed++;
        continue;   // other videos carry on
      }
      st.rec[v.file] = {ok:now, ver:v.ver, size:r.size, fails:0, next:0, last:{t:now, r:"ok"}};
      vsWrite(st);
      out.saved++;
      if(opts.onSaved) opts.onSaved(v);
      await new Promise(function(res){ setTimeout(res, 300); });
    }
  }catch(e){
  }finally{
    VS.running = false;
    try{ localStorage.removeItem(VS.LOCK); }catch(e){}
  }
  return out;
}
/* Other pages pick up anything that is still waiting (a video left early, a
   failed one that is due again), a few seconds after they open. */
function vsAutoStart(){
  if(/\/video\.html$/i.test(location.pathname) || /\/storage\.html$/i.test(location.pathname)) return;
  setTimeout(function(){
    if(vsOff() || VS.running || !Object.keys(vsWatched()).length) return;
    vsRun({auto:true});
  }, 8000);
}
window.LT = window.LT || {};
window.LT.videoSaver = {run:vsRun, plan:vsPlan, catalog:vsCatalog, state:vsState, watched:vsWatched, off:vsOff, key:vsKey, isRunning:function(){ return VS.running; }};
vsAutoStart();

/* ---------------------------------------------------------------
   Keep pictures / PDFs (switches on the Storage page)
   The service worker keeps pictures and PDFs as they are opened. These
   switches tell it whether to keep new ones. A worker can't read
   localStorage, so every page leaves a small marker in the cache for it.
--------------------------------------------------------------- */
var FP = {images:"keepImagesOff", pdfs:"keepPdfsOff", pages:"keepPagesOff"};
function fpOn(kind){ try{ return localStorage.getItem(FP[kind]) !== "1"; }catch(e){ return true; } }
function fpMirror(kind){
  if(!window.caches) return Promise.resolve();
  return caches.open("lanthano-prefs").then(function(c){
    var key = "/__pref/" + kind + "-off";
    return fpOn(kind) ? c.delete(key) : c.put(key, new Response("1"));
  }).catch(function(){});
}
function fpSet(kind, on){
  try{ if(on) localStorage.removeItem(FP[kind]); else localStorage.setItem(FP[kind], "1"); }catch(e){}
  return fpMirror(kind);
}
fpMirror("images"); fpMirror("pdfs"); fpMirror("pages");

/* Offline saving: every page also keeps what it is made of. The service worker
   already keeps whatever a page loads; this adds the pictures, styles and
   scripts the page points to but hasn't loaded yet (pictures further down,
   for instance). It only asks for same-site files that are not saved yet, a
   few at a time, a few seconds after the page opens. */
function sweepOffline(){
  try{
    if(!window.caches || !navigator.serviceWorker || !navigator.serviceWorker.controller) return;
    if(navigator.onLine === false) return;
    var c = navigator.connection; if(c && c.saveData) return;
    if(!fpOn("pages") && !fpOn("images")) return;
    var found = {};
    function add(u){
      if(!u) return;
      try{
        var x = new URL(u, location.href);
        if(x.origin !== location.origin || /^(mp4|webm|m4v|mov|3gp)$/i.test((x.pathname.split(".").pop() || ""))) return;
        if(/\/__video\//.test(x.pathname)) return;
        found[x.href] = 1;
      }catch(e){}
    }
    [].forEach.call(document.querySelectorAll("img[src],img[data-src],source[src],script[src],video[poster]"), function(n){
      add(n.getAttribute("src")); add(n.getAttribute("data-src")); add(n.getAttribute("poster"));
    });
    [].forEach.call(document.querySelectorAll("link[href]"), function(n){
      if(/stylesheet|icon|manifest|preload/i.test(n.getAttribute("rel") || "")) add(n.getAttribute("href"));
    });
    var urls = Object.keys(found).slice(0, 80), i = 0;
    function next(){
      if(i >= urls.length) return;
      var u = urls[i++];
      caches.match(u).then(function(hit){
        if(hit) return;
        return fetch(u).then(function(r){ try{ if(r.body && r.status !== 200) r.body.cancel(); }catch(e){} });
      }).catch(function(){}).then(function(){ setTimeout(next, 120); });
    }
    next(); next();
  }catch(e){}
}
window.addEventListener("load", function(){ setTimeout(sweepOffline, 4000); });
/* Ask the browser not to throw saved things away on its own. */
function keepPersistent(){
  try{ if(navigator.storage && navigator.storage.persist) navigator.storage.persist(); }catch(e){}
}
window.addEventListener("load", function(){
  setTimeout(function(){ if(fpOn("images") || fpOn("pdfs") || fpOn("pages")) keepPersistent(); }, 6000);
});
/* Make sure a whole PDF is kept: the viewer reads PDFs in pieces, which the
   service worker can't keep, so (once the PDF has opened) it is fetched whole
   from the site once. Already-kept PDFs are skipped. */
function keepPdf(url){
  try{
    if(!fpOn("pdfs") || !window.caches || !url) return;
    var u = new URL(url, location.href);
    if(u.origin !== location.origin || !/\.pdf$/i.test(u.pathname)) return;
    caches.match(u.href).then(function(hit){
      if(hit) return;
      return fetch(u.href).then(function(r){ if(r.body && r.status !== 200){ try{ r.body.cancel(); }catch(e){} } });
    }).catch(function(){});
  }catch(e){}
}
window.LT = window.LT || {};
window.LT.cite = cite;
window.LT.filePrefs = {on:fpOn, set:fpSet};
window.LT.keepPdf = keepPdf;
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
window.LT.accentStrong = accentStrong;
window.LT.setAccentStrong = setAccentStrong;
window.LT.menu = menu;
window.LT.hasSources = function(){
  var it = currentItem();
  return findPaper(it.type, it.name).then(function(p){ return !!(p && p.sources && p.sources.length); });
};
window.LT.ask = ask;
window.LT.zoom = zoomF;
window.LT.rect = cssRect;
window.LT.vw = vw;
window.LT.vh = vh;
window.LT.resetAppearance = resetAppearance;
window.LT.closePopup = closePopup;
window.LT.mediaMenu = mediaMenu;
window.LT.confirmStep = confirmStep;
window.LT.confirmDelete = confirmDelete;
window.LT.downloadMenu = downloadMenu;
window.LT.downloadPdf = downloadPdf;
window.LT.zipAssets = zipAssets;
window.LT.zipVideos = zipVideos;
window.LT.install = function(){ if(!deferredInstall) return false; deferredInstall.prompt(); deferredInstall = null; return true; };
window.LT.canInstall = function(){ return !!deferredInstall; };

/* ---------- Locked until the item has loaded ----------
   In the PDF, video and image viewers the tools that act on the content (zoom,
   search, reading aloud, the video controls...) stay switched off while the
   loading screen is up. Things that do not touch the content - Back, the
   three-line menu (download, new tab, fullscreen, share, reference, report),
   reading mode and Sources - keep working. */
var LOCK_SELECTORS = {
  "pdf.html":   "#toolbar > *:not(#sourcesButton), #tocButton, #readAloudFloat",
  "video.html": "#toolbar > *:not(#sourcesButton), #videoProgressRow, #videoControlsMain > *:not(#videoFullscreenBtn)",
  "image.html": "#toolbar > *:not(#sourcesButton)"
};
function initLoadLock(){
  var sel = LOCK_SELECTORS[path], ov = document.getElementById("loadingOverlay");
  if(!sel || !ov) return;
  function shown(){
    if(!ov.isConnected) return false;
    try{ return getComputedStyle(ov).display !== "none"; }catch(e){ return false; }
  }
  if(!shown()) return;
  var st = el("style"); st.textContent = ".ltLocked{opacity:.4 !important;pointer-events:none !important;cursor:default !important}";
  document.head.appendChild(st);
  var locked = [];
  document.body.classList.add("ltLoadingMedia");
  function lockNew(){
    Array.prototype.forEach.call(document.querySelectorAll(sel), function(n){
      if(n.classList.contains("ltLocked")) return;
      n.classList.add("ltLocked"); n.setAttribute("inert", ""); locked.push(n);
    });
  }
  function unlock(){
    clearInterval(timer); if(mo) mo.disconnect();
    locked.forEach(function(n){ n.classList.remove("ltLocked"); n.removeAttribute("inert"); });
    locked = [];
    document.body.classList.remove("ltLoadingMedia");
    if(st.parentNode) st.remove();
  }
  function check(){ if(!shown()) unlock(); else lockNew(); }
  lockNew();
  var mo = window.MutationObserver ? new MutationObserver(check) : null;
  if(mo) mo.observe(ov, {attributes:true, attributeFilter:["style", "class"]});
  var timer = setInterval(check, 400);
}

/* ---------- App updates ----------
   Keeps the installed app (PWA) current. The service worker (sw.js) fetches
   fresh copies; here we just ask it to look for a new version when the app is
   opened or comes back to the front, and offer a one-tap refresh when a new
   version has landed. Nothing here needs any setup. */
var hadController = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
var updateShown = false, lastUpdateCheck = 0;
function showUpdateBanner(){
  if(updateShown || !document.body) return;
  updateShown = true;
  var b = el("div", {"class":"ltUpdate", role:"status"});
  b.style.cssText = "position:fixed;left:50%;transform:translateX(-50%);bottom:18px;z-index:99990;display:flex;align-items:center;gap:12px;padding:10px 14px;border-radius:999px;background:#1d1d1d;color:#eee;border:1px solid #444;font:14px Arial,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.45);max-width:calc(100vw - 24px)";
  b.innerHTML = '<span>A new version is ready</span>';
  var go = el("button", {type:"button"}, "Refresh");
  go.style.cssText = "border:0;border-radius:999px;padding:6px 14px;background:#2f7cff;color:#fff;font:inherit;cursor:pointer";
  var x = el("button", {type:"button", "aria-label":"Dismiss"}, "×");
  x.style.cssText = "border:0;background:none;color:inherit;font-size:18px;line-height:1;cursor:pointer;padding:0 2px;opacity:.7";
  go.onclick = function(){ location.reload(); };
  x.onclick = function(){ b.remove(); };
  b.appendChild(go); b.appendChild(x);
  document.body.appendChild(b);
}
function checkForUpdate(force){
  if(!("serviceWorker" in navigator) || location.protocol === "file:") return Promise.resolve(false);
  var now = Date.now();
  if(!force && now - lastUpdateCheck < 60000) return Promise.resolve(false);
  lastUpdateCheck = now;
  return navigator.serviceWorker.getRegistration().then(function(reg){
    if(!reg) return false;
    return reg.update().then(function(){ return !!reg.waiting; }, function(){ return false; });
  }).catch(function(){ return false; });
}
function updateApp(){
  /* Replace every saved page, script, style and data file with the live
     version (in place, so offline copies are never lost), then reload.
     Videos, pictures and PDFs are not touched. Used by Settings > Update. */
  var TEXT = /\.(html|js|mjs|css|json)$/i;
  var clear = (window.caches && caches.keys) ? caches.keys().then(function(names){
    var jobs = [];
    return Promise.all(names.filter(function(n){ return n !== "lanthano-saved-videos" && n !== "lanthano-prefs"; }).map(function(n){
      return caches.open(n).then(function(c){
        return c.keys().then(function(keys){
          keys.forEach(function(r){
            var p = new URL(r.url).pathname;
            if(TEXT.test(p) || /\/$/.test(p)) jobs.push({c:c, r:r});
          });
        });
      });
    })).then(function(){
      var i = 0, failed = false;
      function worker(){
        if(i >= jobs.length || failed) return Promise.resolve();
        var j = jobs[i++];
        return fetch(j.r.url, {cache:"reload", headers:{"x-lt-check":"1"}}).then(function(res){
          if(res.status === 200) return j.c.put(j.r, res);
          if(res.status === 404) return j.c.delete(j.r);
        }).catch(function(e){ failed = true; throw e; }).then(worker);
      }
      return Promise.all([worker(), worker(), worker(), worker()]);
    });
  }) : Promise.resolve();
  return clear.then(function(){
    return checkForUpdate(true);
  }).then(function(){
    return navigator.serviceWorker && navigator.serviceWorker.getRegistration();
  }).then(function(reg){
    if(reg && reg.waiting) reg.waiting.postMessage({type:"skip-waiting"});
    setTimeout(function(){ location.reload(); }, 350);
  });
}
if("serviceWorker" in navigator && location.protocol !== "file:"){
  navigator.serviceWorker.addEventListener("message", function(e){
    if(e.data && e.data.type === "lt-updated" && hadController) showUpdateBanner();
  });
  navigator.serviceWorker.addEventListener("controllerchange", function(){ if(hadController) showUpdateBanner(); });
  document.addEventListener("visibilitychange", function(){ if(!document.hidden) checkForUpdate(false); });
  window.addEventListener("online", function(){ checkForUpdate(false); });
  window.addEventListener("load", function(){ setTimeout(function(){ checkForUpdate(false); }, 1500); });
}
window.LT.checkForUpdate = checkForUpdate;
window.LT.updateApp = updateApp;

function collapseMore(){
  var m = document.getElementById("menu"), b = document.getElementById("moreBtn"), l = document.getElementById("moreList");
  // only touch what is actually changing: even an unchanged write counts as a change to a mutation observer
  if(m && m.classList.contains("ltSub")) m.classList.remove("ltSub");
  if(m && m.style.minWidth) m.style.minWidth = "";
  if(l && !l.hidden) l.hidden = true;
  if(b && b.getAttribute("aria-expanded") !== "false") b.setAttribute("aria-expanded", "false");
}
var SUBS = {cite:"Copy a citation (APA, MLA and more)", report:"Tell us about a mistake"};
function ready(){
  try{ initLoadLock(); }catch(e){}
  var mb = document.getElementById("moreBtn"), ml = document.getElementById("moreList"), menuEl = document.getElementById("menu");
  // markup that spreads an item's text over several lines would leave a gap after its icon
  if(menuEl) [].forEach.call(menuEl.querySelectorAll(":scope > button, :scope > a"), function(it){
    if(!it.children.length && /^\s|\s$/.test(it.textContent)) it.textContent = it.textContent.trim();
  });
  if(mb && ml && menuEl){
    mb.innerHTML = '<span>More</span><span class="moreChev" aria-hidden="true"></span>';
    // each option: icon, title and a short line about what it does
    [].forEach.call(ml.querySelectorAll("button[data-lt]"), function(btn){
      var k = btn.getAttribute("data-lt");
      btn.classList.add("moreOpt");
      btn.innerHTML = '<span class="moreTxt"><b>' + esc(btn.textContent.trim()) + '</b><small>' + esc(SUBS[k] || "") + '</small></span>';
    });
    var back = el("button", {type:"button", "class":"moreHead", "aria-label":"Back to menu"}, '<span class="moreChev" aria-hidden="true"></span><span>More</span>');
    ml.insertBefore(back, ml.firstChild);
    mb.addEventListener("click", function(e){
      e.stopPropagation();
      menuEl.style.minWidth = menuEl.getBoundingClientRect().width / zoomF() + "px";   // the second panel keeps the first one's width
      menuEl.classList.add("ltSub");
      ml.hidden = false;
      mb.setAttribute("aria-expanded", "true");
    });
    back.addEventListener("click", function(e){ e.stopPropagation(); collapseMore(); });
    // Starts on the main list every time the menu is opened again.
    if(window.MutationObserver){
      new MutationObserver(function(){
        if(getComputedStyle(menuEl).display === "none") collapseMore();
      }).observe(menuEl, {attributes:true, attributeFilter:["style", "class"]});
    }
  }
  try{ window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", applyTheme); }catch(e){}
}
if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready); else ready();

})();
