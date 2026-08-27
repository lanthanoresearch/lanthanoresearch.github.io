#!/usr/bin/env node
/**
 * extract-covers.js
 *
 * Reads descriptions.json (a map of key -> PDF metadata, including a
 * relative "url" field), reads each PDF straight from disk (it's already
 * in this repo, checked out alongside this script), renders ONLY page 1
 * to a PNG, and saves it to covers/<key>.png.
 *
 * Note: rather than trying to pull out an embedded image object (fragile
 * in Node -- there's no great PyMuPDF equivalent), this rasterizes the
 * whole first page. Since page 1 is the cover page, the output looks the
 * same in practice and is far more reliable across different PDFs.
 *
 * Design goals:
 * - Runs unattended (cron via GitHub Actions).
 * - Never crashes the whole run because one PDF is missing/broken.
 * - If a PDF can't be read or rendered, it is SKIPPED and the existing
 *   cover file (if any) is left untouched -- no broken output, no deleted
 *   images, no hard failure.
 * - Clear per-item log line so failures are visible in Action logs.
 */

import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { createRequire } from "module";
import { createCanvas } from "canvas";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

const require = createRequire(import.meta.url);

// ---- Configuration ------------------------------------------------------

const DESC_JSON_PATH = process.env.DESC_JSON_PATH || "descriptions.json";
const OUTPUT_DIR = process.env.COVERS_OUTPUT_DIR || "covers";
// Folder where the actual PDF files live. Since descriptions.json stores
// bare filenames (e.g. "9-11.pdf"), this is the folder they're joined onto.
const PDF_DIR = process.env.PDF_DIR || ".";
const MAX_WIDTH = parseInt(process.env.COVER_MAX_WIDTH || "1000", 10);

const pdfjsDistPkgPath = require.resolve("pdfjs-dist/package.json");
const pdfjsDistDir = path.dirname(pdfjsDistPkgPath);

const CMAP_URL = pathToFileURL(path.join(pdfjsDistDir, "cmaps/")).href;
const STANDARD_FONT_DATA_URL = pathToFileURL(
  path.join(pdfjsDistDir, "standard_fonts/")
).href;

function log(msg) {
  console.log(msg);
}

class NodeCanvasFactory {
  create(width, height) {
    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d");
    return { canvas, context };
  }
  reset(canvasAndContext, width, height) {
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  }
  destroy(canvasAndContext) {
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  }
}

async function renderFirstPageToPng(pdfBytes, outPath) {
  const loadingTask = pdfjsLib.getDocument({
    data: pdfBytes,
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
  });
  const doc = await loadingTask.promise;

  try {
    if (doc.numPages < 1) {
      throw new Error("PDF has no pages");
    }
    const page = await doc.getPage(1);

    const baseViewport = page.getViewport({ scale: 1 });
    const scale = Math.min(MAX_WIDTH / baseViewport.width, 4); // never upscale absurdly
    const viewport = page.getViewport({ scale });

    const canvasFactory = new NodeCanvasFactory();
    const canvasAndContext = canvasFactory.create(
      Math.ceil(viewport.width),
      Math.ceil(viewport.height)
    );

    await page.render({
      canvasContext: canvasAndContext.context,
      viewport,
      canvasFactory,
    }).promise;

    const tmpPath = `${outPath}.tmp`;
    const out = fs.createWriteStream(tmpPath);
    const stream = canvasAndContext.canvas.createPNGStream();

    await new Promise((resolve, reject) => {
      stream.pipe(out);
      out.on("finish", resolve);
      out.on("error", reject);
    });

    fs.renameSync(tmpPath, outPath); // atomic-ish swap, avoids half-written files
  } finally {
    await doc.destroy();
  }
}

async function processEntry(key, entry) {
  const relativeUrl = entry.url;
  if (!relativeUrl) {
    log(`[skip] ${key}: no "url" field in descriptions.json`);
    return "skipped";
  }

  const outPath = path.join(OUTPUT_DIR, `${key}.png`);
  const pdfPath = path.join(PDF_DIR, relativeUrl);

  let pdfBytes;
  try {
    pdfBytes = new Uint8Array(fs.readFileSync(pdfPath));
  } catch (err) {
    log(`[skip] ${key}: could not read PDF (${pdfPath}) -- ${err.message}`);
    return "skipped";
  }

  try {
    await renderFirstPageToPng(pdfBytes, outPath);
  } catch (err) {
    log(`[skip] ${key}: could not render page 1 -- ${err.message}`);
    return "skipped";
  }

  log(`[ok]   ${key}: saved cover -> ${outPath}`);
  return "ok";
}

async function main() {
  if (!fs.existsSync(DESC_JSON_PATH)) {
    console.error(`ERROR: description file not found at '${DESC_JSON_PATH}'`);
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(DESC_JSON_PATH, "utf-8"));
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const counts = { ok: 0, skipped: 0 };
  for (const [key, entry] of Object.entries(data)) {
    const result = await processEntry(key, entry);
    counts[result] = (counts[result] || 0) + 1;
  }

  log(
    `\nDone. ${counts.ok || 0} covers updated, ${
      counts.skipped || 0
    } skipped (existing files left untouched).`
  );
}

main().catch((err) => {
  // Even a top-level failure (e.g. malformed descriptions.json) should not
  // wipe out existing covers -- it just means no update happened this run.
  console.error("Fatal error, no covers were touched this run:", err);
  process.exit(0);
});
