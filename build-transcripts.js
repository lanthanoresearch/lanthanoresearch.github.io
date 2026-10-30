// Builds the two small files that make video transcripts work:
//
//   transcripts-list.json   which videos have a transcript (so the video
//                           page never asks for one that does not exist)
//   transcripts.json        the transcript text in ~25 second pieces, so
//                           the search on the home page can find words
//                           that are SPOKEN in a video and jump to them
//
// Put one transcript per video in the transcripts/ folder, named after the
// video file (no folder, no extension), as WebVTT (.vtt) or SRT (.srt):
//
//     911/Tower 7 falling.mp4        ->  transcripts/Tower 7 falling.vtt
//     YouTube link youtu.be/abc123   ->  transcripts/yt-abc123.vtt
//
//   node build-transcripts.js
//
// The GitHub Action (.github/workflows/app.yml) runs this for you on every
// push, so you only need to upload the .vtt files.
//
// Making a transcript for a video you have on your computer (free, runs
// locally, nothing is uploaded anywhere):
//     pip install openai-whisper
//     whisper "Tower 7 falling.mp4" --model small --output_format vtt --output_dir transcripts
// Read it over and fix mistakes before you upload it - that is the point
// of keeping it as a plain text file.

const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const DIR = path.join(ROOT, "transcripts");
const CHUNK_SECONDS = 25;

function toSeconds(x) {
  const p = x.replace(",", ".").split(":").map(parseFloat);
  while (p.length < 3) p.unshift(0);
  return p[0] * 3600 + p[1] * 60 + p[2];
}

function clean(t) {
  return t.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

function parse(text) {
  const out = [];
  text.replace(/\r/g, "").replace(/^﻿/, "").split(/\n\s*\n/).forEach((block) => {
    const lines = block.split("\n");
    const i = lines.findIndex((l) => l.indexOf("-->") >= 0);
    if (i < 0) return;
    const m = /([\d:.,]+)\s*-->\s*([\d:.,]+)/.exec(lines[i]);
    if (!m) return;
    const t = clean(lines.slice(i + 1).join(" "));
    if (!t) return;
    const prev = out[out.length - 1];
    if (prev && prev.t === t) return;
    out.push({ s: toSeconds(m[1]), t });
  });
  return out.sort((a, b) => a.s - b.s);
}

if (!fs.existsSync(DIR)) {
  console.log("No transcripts/ folder - nothing to do.");
  process.exit(0);
}

const videos = {};
const names = fs.readdirSync(DIR).filter((f) => /\.(vtt|srt)$/i.test(f)).sort();

for (const f of names) {
  const base = f.replace(/\.(vtt|srt)$/i, "");
  if (videos[base]) continue; // .vtt wins over .srt of the same name
  const cues = parse(fs.readFileSync(path.join(DIR, f), "utf8"));
  if (!cues.length) {
    console.warn("Skipped (no captions found): " + f);
    continue;
  }
  const chunks = [];
  let start = null;
  let text = [];
  for (const c of cues) {
    if (start === null) start = c.s;
    else if (c.s - start >= CHUNK_SECONDS) {
      chunks.push([Math.round(start * 10) / 10, text.join(" ")]);
      start = c.s;
      text = [];
    }
    text.push(c.t);
  }
  if (text.length) chunks.push([Math.round(start * 10) / 10, text.join(" ")]);
  videos[base] = chunks;
}

const list = Object.keys(videos);
fs.writeFileSync(path.join(ROOT, "transcripts-list.json"), JSON.stringify(list));
fs.writeFileSync(path.join(ROOT, "transcripts.json"), JSON.stringify({ v: 1, videos }));
console.log("Transcripts: " + list.length + " video(s).");
