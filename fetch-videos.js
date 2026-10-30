// Gets the videos that live on the video server, so they can be put inside the
// installed apps (computer and Android) and work with no internet at all.
//
//   node fetch-videos.js <folder>      download every video that is not in it yet
//   node fetch-videos.js --key         print a short code that changes when the list
//                                      of videos changes (used to remember the download)
//
// The GitHub Actions run this. A video that is already in the folder is not
// downloaded again, so only new ones are fetched.
//
// The video server hands out a short-lived ticket for each video and then plays
// the video for that ticket, exactly as the website's video page does.

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const crypto = require("crypto");

const ROOT = __dirname;
const API = (process.env.VIDEO_API || "https://videos.lanthanoresearch.com").replace(/\/+$/, "");
const ORIGIN = process.env.VIDEO_ORIGIN || "https://lanthanoresearch.com";
const STRICT = process.env.STRICT === "1";
const STEP = Number(process.env.RETRY_MS) || 5000;   // pause between attempts

function videos() {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, "descriptions.json"), "utf8"));
  const seen = new Map();

  (function walk(o) {
    if (Array.isArray(o)) o.forEach(walk);
    else if (o && typeof o === "object") {
      if (typeof o.file === "string" && o.file && o.source !== "site" && !seen.has(o.file)) {
        seen.set(o.file, o);
      }
      Object.values(o).forEach(walk);
    }
  })(data);

  return [...seen.values()];
}

if (process.argv.includes("--key")) {
  const lines = videos()
    .map((v) => v.file + "|" + (v.size || "") + "|" + (v.v === undefined ? "" : v.v))
    .sort();
  console.log(crypto.createHash("sha1").update(lines.join("\n")).digest("hex").slice(0, 16));
  process.exit(0);
}

const outDir = path.resolve(process.argv[2] || "");
if (!process.argv[2]) {
  console.error("Usage: node fetch-videos.js <folder>");
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });

const HEADERS = {
  Origin: ORIGIN,
  Referer: ORIGIN + "/",
  Accept: "*/*",
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
};

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function get(url, hops = 0) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https:") ? https : http;
    const req = lib.get(url, { headers: HEADERS }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 5) {
        res.resume();
        resolve(get(new URL(res.headers.location, url).href, hops + 1));
        return;
      }
      resolve(res);
    });
    req.setTimeout(60000, () => req.destroy(new Error("timed out")));
    req.on("error", reject);
  });
}

async function readText(res) {
  let text = "";
  res.setEncoding("utf8");
  for await (const chunk of res) text += chunk;
  return text;
}

async function fetchOne(video, target) {
  const part = target + ".part";

  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const ticketRes = await get(API + "/ticket?f=" + encodeURIComponent(video.file));

      if (ticketRes.statusCode === 429 || ticketRes.statusCode === 503) {
        ticketRes.resume();
        console.log("  the video server asked to slow down, waiting...");
        await wait(STEP * 6 * attempt);
        continue;
      }

      if (ticketRes.statusCode !== 200) {
        ticketRes.resume();
        throw new Error("ticket answered " + ticketRes.statusCode);
      }

      const ticket = JSON.parse(await readText(ticketRes)).t;
      const res = await get(API + "/play?t=" + encodeURIComponent(ticket));

      if (res.statusCode === 429 || res.statusCode === 503) {
        res.resume();
        console.log("  the video server asked to slow down, waiting...");
        await wait(STEP * 6 * attempt);
        continue;
      }

      if (res.statusCode !== 200) {
        res.resume();
        throw new Error("video answered " + res.statusCode);
      }

      const type = String(res.headers["content-type"] || "").toLowerCase();
      if (type && !type.startsWith("video/") && !type.includes("octet-stream")) {
        res.resume();
        throw new Error("unexpected type " + type);
      }

      const expected = Number(res.headers["content-length"]) || 0;
      fs.mkdirSync(path.dirname(target), { recursive: true });

      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(part);
        res.on("error", reject);
        out.on("error", reject);
        out.on("finish", resolve);
        res.pipe(out);
      });

      const got = fs.statSync(part).size;
      if (!got || (expected && got !== expected)) {
        throw new Error("incomplete (" + got + " of " + expected + " bytes)");
      }

      fs.renameSync(part, target);
      return got;
    } catch (e) {
      try { fs.rmSync(part, { force: true }); } catch (x) {}
      console.log("  attempt " + attempt + " failed: " + e.message);
      await wait(STEP * attempt);
    }
  }

  return 0;
}

(async () => {
  const list = videos();
  let got = 0;
  let kept = 0;
  const failed = [];

  console.log(list.length + " videos on the video server");

  for (const video of list) {
    const target = path.join(outDir, ...video.file.split("/"));

    if (fs.existsSync(target) && fs.statSync(target).size > 0) {
      kept++;
      continue;
    }

    console.log("downloading " + video.file);
    const bytes = await fetchOne(video, target);

    if (bytes) {
      got++;
      console.log("  " + Math.round(bytes / 1e6) + " MB");
    } else {
      failed.push(video.file);
      console.log("::warning::Could not download " + video.file);
    }

    await wait(400);
  }

  console.log("done: " + got + " downloaded, " + kept + " already there, " + failed.length + " failed");

  if (failed.length) {
    console.log("These videos will still need the internet in the app:\n  " + failed.join("\n  "));
    if (STRICT) process.exit(1);
  }
})();
