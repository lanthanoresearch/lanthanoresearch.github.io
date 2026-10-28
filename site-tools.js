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
   Pictures and videos are never touched. The three viewers (PDF, video,
   image) always stay dark, like their own black stage.
--------------------------------------------------------------- */
var root = document.documentElement;

var THEME_DEFS = {
  dark:     {light:false, h:0,   s:0},
  light:    {light:true,  h:0,   s:0},
  sepia:    {light:true,  h:38,  s:0.32},
  midnight: {light:false, h:222, s:0.34},
  forest:   {light:false, h:150, s:0.24}
};
var ACCENT_HUE = {blue:null, teal:174, green:140, orange:26, red:2, purple:268, pink:328};

function systemLight(){
  try{ return window.matchMedia("(prefers-color-scheme: light)").matches; }catch(e){ return false; }
}
function themeName(){
  var t = get("lt_theme") || "dark";
  if(t === "auto") t = systemLight() ? "light" : "dark";
  return THEME_DEFS[t] ? t : "dark";
}
function accentName(){
  var a = get("lt_accent") || "blue";
  return ACCENT_HUE.hasOwnProperty(a) ? a : "blue";
}

var TE = {
  store: [], sheets: new WeakSet(), orig: new WeakMap(), written: new WeakMap(), attrs: new WeakMap(),
  T: THEME_DEFS.dark, accent: null, active: false, obs: null, hold: null
};

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
      l = 1 - l; h = T.h; s = T.s;
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
    if(!T.s) return tok;
    h = T.h; s = T.s * Math.pow(1 - l, 0.8);
  }

  if(!neutral && A != null && hs.c >= 0.25 && hs.h >= 195 && hs.h <= 248) h = A;
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
function applyProps(st, props, sel){
  var T = TE.T;
  if(!TE.active || (/knob/i.test(sel) && /active|\.on\b|checked/i.test(sel))){
    props.forEach(function(p){ if(st.getPropertyValue(p[0]) !== p[1]) st.setProperty(p[0], p[1], p[2]); });
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
    var cx = {shadow:/shadow/.test(p[0]), keepText: bgKept && (p[0] === "color" || p[0] === "-webkit-text-fill-color"), text: p[0] === "color" || p[0] === "--btn-text", kept:false};
    var nv = mapAny(p[0], p[1], cx);
    if(st.getPropertyValue(p[0]) !== nv) st.setProperty(p[0], nv, p[2]);
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
function processSheet(sh){
  if(!sh || TE.sheets.has(sh)) return;
  TE.sheets.add(sh);
  var rules;
  try{ rules = sh.cssRules; }catch(e){ return; }
  if(!rules) return;
  walkRules(rules, function(r){
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

/* style="..." attributes written by the page or by its scripts */
function inlineApply(elm){
  var cur = elm.getAttribute("style");
  if(cur == null) return;
  var w = TE.written.get(elm);
  var o;
  if(w !== undefined && w === cur) o = TE.orig.get(elm);
  else { o = cur; TE.orig.set(elm, cur); }
  if(o === undefined) return;
  if(!TE.active && w === undefined) return;
  if(o !== cur) elm.setAttribute("style", o);
  var props = collectProps(elm.style);
  if(props.length) applyProps(elm.style, props, "");
  TE.written.set(elm, elm.getAttribute("style"));
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

function applyTheme(){
  if(VIEWER) return;
  var name = themeName(), acc = accentName();
  TE.T = THEME_DEFS[name];
  TE.accent = ACCENT_HUE[acc];
  TE.active = name !== "dark" || acc !== "blue";
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

/* Hide the page for a moment (in the right background color) so a
   chosen theme never flashes the dark one first. */
if(!VIEWER){
  var first = THEME_DEFS[themeName()], firstAcc = accentName();
  if(themeName() !== "dark" || firstAcc !== "blue"){
    TE.T = first; TE.accent = ACCENT_HUE[firstAcc]; TE.active = true;
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
  '#menu .moreCaret{display:inline-block;margin-left:8px;border-left:5px solid transparent;border-right:5px solid transparent;' +
    'border-top:6px solid currentColor;vertical-align:middle;opacity:.7;transition:transform .15s ease}' +
  '#menu #moreBtn[aria-expanded="true"] .moreCaret{transform:rotate(180deg)}' +
  '#menu .moreList[hidden]{display:none}' +
  '#menu .moreList{display:flex;flex-direction:column}' +
  '#menu .moreList button{padding-left:30px;font-size:.95em;opacity:.92}' +
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
    var cur = list[0].name;
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
    bindPicker(box.querySelector("#ltFmt"), opts, function(){ return cur; }, function(v){ cur = v; show(); });
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

var THEMES = [
  {value:"dark", label:"Dark"}, {value:"light", label:"Light"}, {value:"sepia", label:"Sepia"},
  {value:"midnight", label:"Midnight"}, {value:"forest", label:"Forest"}, {value:"auto", label:"Automatic"}
];
var ACCENTS = [
  {value:"blue", label:"Blue"}, {value:"teal", label:"Teal"}, {value:"green", label:"Green"},
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
  bindPicker(t, THEMES, themeValue, setTheme);
  bindPicker(c, ACCENTS, accentValue, setAccent);
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
  var items = [{label:"PDF", note:".pdf", onClick:function(){ downloadPdf(paper); }}];
  if(imgs) items.push({label:"All images (" + imgs + ")", note:".zip", onClick:function(){ zipImages(paper); }});
  if(vids) items.push({label:"All videos (" + vids + ")", note:".zip", onClick:function(){ zipVideos(paper); }});
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
window.LT.confirmStep = confirmStep;
window.LT.confirmDelete = confirmDelete;
window.LT.downloadMenu = downloadMenu;
window.LT.downloadPdf = downloadPdf;
window.LT.zipAssets = zipAssets;
window.LT.zipVideos = zipVideos;
window.LT.install = function(){ if(!deferredInstall) return false; deferredInstall.prompt(); deferredInstall = null; return true; };
window.LT.canInstall = function(){ return !!deferredInstall; };

function collapseMore(){
  var b = document.getElementById("moreBtn"), l = document.getElementById("moreList");
  if(b && l){ l.hidden = true; b.setAttribute("aria-expanded", "false"); }
}
function ready(){
  var mb = document.getElementById("moreBtn"), ml = document.getElementById("moreList");
  if(mb && ml){
    mb.addEventListener("click", function(e){
      e.stopPropagation();
      ml.hidden = !ml.hidden;
      mb.setAttribute("aria-expanded", ml.hidden ? "false" : "true");
    });
    // Starts folded every time the menu is opened again.
    var menuEl = document.getElementById("menu");
    if(menuEl && window.MutationObserver){
      new MutationObserver(function(){
        if(getComputedStyle(menuEl).display === "none") collapseMore();
      }).observe(menuEl, {attributes:true, attributeFilter:["style", "class"]});
    }
  }
  try{ window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", applyTheme); }catch(e){}
}
if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready); else ready();

})();
