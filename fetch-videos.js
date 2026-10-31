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

function get(url, extra = {}, hops = 0) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https:") ? https : http;
    const req = lib.get(url, { headers: Object.assign({}, HEADERS, extra) }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 5) {
        res.resume();
        resolve(get(new URL(res.headers.location, url).href, extra, hops + 1));
        return;
      }
      resolve(res);
    });
    req.setTimeout(60000, () => req.destroy(new Error("timed out")));
    req.on("error", reject);
  });
}

async function readText(res, max = Infinity) {
  let text = "";
  res.setEncoding("utf8");
  for await (const chunk of res) {
    text += chunk;
    if (text.length >= max) { res.destroy(); break; }
  }
  return text;
}

/* ---------- curl as a second way to ask ----------
   Some servers treat Node's requests differently from curl's. If Node is
   refused but curl is let through, curl is used for everything after that. */

const { spawnSync } = require("child_process");
let useCurl = false;

function curlArgs(url, extra) {
  const h = Object.assign({}, HEADERS, extra);
  const args = ["-sS", "-L", "-m", "1800", "--retry", "2"];
  Object.keys(h).forEach((k) => args.push("-H", k + ": " + h[k]));
  args.push(url);
  return args;
}

function curlText(url) {
  const r = spawnSync("curl", ["-w", "\n%{http_code}"].concat(curlArgs(url, {})), { encoding: "utf8", maxBuffer: 1 << 26 });
  if (r.error || r.status !== 0) return { status: 0, body: "", error: (r.error && r.error.message) || r.stderr };
  const cut = r.stdout.lastIndexOf("\n");
  return { status: Number(r.stdout.slice(cut + 1)), body: r.stdout.slice(0, cut) };
}

function curlFile(url, file) {
  const r = spawnSync("curl", ["-w", "%{http_code}", "-o", file].concat(curlArgs(url, {})), { encoding: "utf8", maxBuffer: 1 << 20 });
  if (r.error || r.status !== 0) return { status: 0, error: (r.error && r.error.message) || r.stderr };
  return { status: Number(r.stdout.trim()) };
}

/* ---------- what went wrong, in words ---------- */

const reasons = new Map();   // short reason -> how many times

function note(reason) {
  reasons.set(reason, (reasons.get(reason) || 0) + 1);
}

async function describe(res) {
  const body = (await readText(res, 300)).replace(/\s+/g, " ").trim();
  const server = res.headers["server"] || "";
  const ray = res.headers["cf-ray"] ? " cf-ray " + res.headers["cf-ray"] : "";
  return "HTTP " + res.statusCode + " " + (res.headers["content-type"] || "") +
    (server ? " (server: " + server + ray + ")" : "") + (body ? ' - "' + body.slice(0, 200) + '"' : "");
}

/* ---------- one video ---------- */

// Asks for the video in pieces if the server only answers pieces, or all at once
// if it does not do pieces. Returns the bytes saved, or throws with the reason.
async function downloadPlay(ticket, part) {
  const url = API + "/play?t=" + encodeURIComponent(ticket);

  if (useCurl) {
    const r = curlFile(url, part);
    if (r.status !== 200 && r.status !== 206) throw new Error("curl: video answered " + (r.status || r.error));
    return fs.statSync(part).size;
  }

  let have = 0;
  let total = 0;

  for (let round = 0; round < 400; round++) {
    const res = await get(url, { Range: "bytes=" + have + "-" });

    if (res.statusCode !== 200 && res.statusCode !== 206) {
      const why = await describe(res);
      const err = new Error("video answered " + why);
      err.status = res.statusCode;
      throw err;
    }

    const type = String(res.headers["content-type"] || "").toLowerCase();
    if (type && !type.startsWith("video/") && !type.includes("octet-stream")) {
      const why = await describe(res);
      throw new Error("unexpected answer " + why);
    }

    let append = true;
    if (res.statusCode === 200) {
      // the whole video, from the start (the server ignored the range)
      have = 0;
      append = false;
      total = Number(res.headers["content-length"]) || 0;
    } else {
      const m = /bytes (\d+)-(\d+)\/(\d+|\*)/.exec(String(res.headers["content-range"] || ""));
      if (m) {
        if (Number(m[1]) !== have) throw new Error("server answered the wrong part of the video");
        if (m[3] !== "*") total = Number(m[3]);
      }
    }

    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(part, { flags: append ? "a" : "w" });
      res.on("error", reject);
      out.on("error", reject);
      out.on("finish", resolve);
      res.pipe(out);
    });

    have = fs.statSync(part).size;

    if (res.statusCode === 200) {
      if (total && have !== total) throw new Error("incomplete (" + have + " of " + total + " bytes)");
      return have;
    }
    if (total && have >= total) return have;
    if (!total) {
      // no total given: a short answer means that was the end
      const len = Number(res.headers["content-length"]) || 0;
      if (!len || len < 1048576) return have;
    }
  }
  throw new Error("the video kept coming in pieces without ending");
}

async function getTicket(video) {
  const url = API + "/ticket?f=" + encodeURIComponent(video.file);

  if (useCurl) {
    const r = curlText(url);
    if (r.status !== 200) {
      const err = new Error("curl: ticket answered " + (r.status || r.error));
      err.status = r.status;
      throw err;
    }
    return JSON.parse(r.body).t;
  }

  const res = await get(url);

  if (res.statusCode === 429 || res.statusCode === 503) {
    res.resume();
    const err = new Error("slow down");
    err.status = res.statusCode;
    throw err;
  }
  if (res.statusCode !== 200) {
    const err = new Error("ticket answered " + (await describe(res)));
    err.status = res.statusCode;
    throw err;
  }
  return JSON.parse(await readText(res)).t;
}

async function fetchOne(video, target) {
  const part = target + ".part";

  for (let attempt = 1; attempt <= 6; attempt++) {
    try { fs.rmSync(part, { force: true }); } catch (x) {}

    try {
      const ticket = await getTicket(video);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const got = await downloadPlay(ticket, part);

      if (!got) throw new Error("empty");
      fs.renameSync(part, target);
      return got;
    } catch (e) {
      try { fs.rmSync(part, { force: true }); } catch (x) {}

      if (e.message === "slow down") {
        console.log("  the video server asked to slow down, waiting...");
        await wait(STEP * 6 * attempt);
        continue;
      }

      console.log("  attempt " + attempt + " failed: " + e.message);
      note(e.message.replace(/\d{3,}/g, "#").slice(0, 160));

      // Refused outright (not busy): another try will not change that.
      if (e.status === 401 || e.status === 403) {
        fetchOne.refused = (fetchOne.refused || 0) + 1;
        return 0;
      }
      await wait(STEP * attempt);
    }
  }

  return 0;
}

/* Before downloading everything: can the video server be reached at all, from
   here? If Node is refused but curl is let through, switch to curl. */
async function probe(video) {
  const url = API + "/ticket?f=" + encodeURIComponent(video.file);
  let nodeWhy = "";
  try {
    const res = await get(url);
    if (res.statusCode === 200) { res.resume(); return; }
    nodeWhy = await describe(res);
  } catch (e) {
    nodeWhy = String(e.message);
  }
  console.log("The video server did not accept the first request from Node: " + nodeWhy);
  const c = curlText(url);
  if (c.status === 200) {
    console.log("curl was let through, so curl is used for the videos.");
    useCurl = true;
  } else {
    console.log("curl was not let through either (" + (c.status || c.error) + "): " + String(c.body || "").replace(/\s+/g, " ").slice(0, 200));
  }
}

(async () => {
  const list = videos();
  let got = 0;
  let kept = 0;
  const failed = [];

  console.log(list.length + " videos on the video server");

  const todo = list.filter((v) => {
    const t = path.join(outDir, ...v.file.split("/"));
    return !(fs.existsSync(t) && fs.statSync(t).size > 0);
  });
  kept = list.length - todo.length;
  if (todo.length) await probe(todo[0]);

  let refusedInARow = 0;

  for (const video of todo) {
    const target = path.join(outDir, ...video.file.split("/"));

    console.log("downloading " + video.file);
    const before = fetchOne.refused || 0;
    const bytes = await fetchOne(video, target);

    if (bytes) {
      got++;
      refusedInARow = 0;
      console.log("  " + Math.round(bytes / 1e6) + " MB");
    } else {
      failed.push(video.file);
      console.log("::warning::Could not download " + video.file);
      refusedInARow = (fetchOne.refused || 0) > before ? refusedInARow + 1 : 0;
    }

    // The server is saying "no" to every request: stop instead of waiting for all of them.
    if (refusedInARow >= 3 && got === 0) {
      console.log("The video server refuses these requests, so the rest are skipped.");
      break;
    }

    await wait(400);
  }

  // The server may only have been busy: wait a little and try the ones that failed once more.
  if (failed.length && refusedInARow < 3 && !process.env.NO_SECOND_PASS) {
    console.log("trying the " + failed.length + " that failed once more after a pause...");
    await wait(Number(process.env.SECOND_PASS_MS) || 90000);
    for (const file of failed.slice()) {
      const target = path.join(outDir, ...file.split("/"));
      const bytes = await fetchOne({ file }, target);
      if (bytes) {
        got++;
        failed.splice(failed.indexOf(file), 1);
        console.log("  " + file + ": " + Math.round(bytes / 1e6) + " MB");
      }
      await wait(400);
    }
  }

  const missing = list.filter((v) => {
    const t = path.join(outDir, ...v.file.split("/"));
    return !(fs.existsSync(t) && fs.statSync(t).size > 0);
  });

  console.log("done: " + got + " downloaded, " + kept + " already there, " + missing.length + " missing");

  if (missing.length) {
    const why = [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map((r) => r[0]).join(" | ");
    console.log("::error title=Videos are missing from the app::" + missing.length + " of " + list.length +
      " videos could not be downloaded, so they will not be inside the app. Reason: " + (why || "unknown"));
    console.log("These videos will not be inside the app:\n  " + missing.map((v) => v.file).join("\n  "));
    if (STRICT) process.exit(1);
  }
})();
