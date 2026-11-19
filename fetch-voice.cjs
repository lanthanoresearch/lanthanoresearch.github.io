// Puts Read Aloud's own voice inside the apps.
//
//   node fetch-voice.cjs <site folder>
//
// The apps never go to the internet on their own (Lockdown), so the voice that
// Read Aloud uses on a device with no voices of its own has to be inside the app
// itself. This runs while the app is being built (the build machine does have
// internet) and puts everything the voice needs into "<site folder>/voice":
//
//   ort/                  the engine that runs the voice
//   phonemizer/           turns text into sounds
//   kitten_tts_nano_v0_2.onnx   the voice model
//   voices.npz            the voices
//   voice-pack.json       tells the pages all of this is there
//
// It never stops the build: if anything cannot be downloaded or looks wrong, the
// "voice" folder is removed again, a warning is shown, and the app is built
// without it (Read Aloud then says the voice is missing, instead of failing
// quietly or half-working).
//
// The addresses can be changed with environment variables (used for testing).

"use strict";

const fs = require("fs");
const path = require("path");

const JSDELIVR_DATA = process.env.VOICE_JSDELIVR_DATA || "https://data.jsdelivr.com/v1/packages/npm";
const JSDELIVR_CDN = process.env.VOICE_JSDELIVR_CDN || "https://cdn.jsdelivr.net/npm";
const NPM_REGISTRY = process.env.VOICE_NPM_REGISTRY || "https://registry.npmjs.org";
const HF_BASE = process.env.VOICE_HF_BASE || "https://huggingface.co";

const ORT_VERSION = "1.20.1";
const MODEL_REPO = "KittenML/kitten-tts-nano-0.2";
const MODEL_FILE = "kitten_tts_nano_v0_2.onnx";

const siteDir = process.argv[2];

if(!siteDir){
  console.error("Usage: node fetch-voice.cjs <site folder>");
  process.exit(2);
}

const voiceDir = path.join(siteDir, "voice");

function mb(bytes){
  return (bytes / 1e6).toFixed(1) + " MB";
}

async function sleep(ms){
  return new Promise(resolve => setTimeout(resolve, ms));
}

// A download that tries a few times before giving up.
async function get(url, what){

  let lastError;

  for(let attempt = 1; attempt <= 4; attempt++){

    try{

      const response = await fetch(url, { redirect: "follow" });

      if(!response.ok){
        throw new Error("answered " + response.status);
      }

      return Buffer.from(await response.arrayBuffer());

    }catch(error){
      lastError = error;
      console.log("  " + what + ": attempt " + attempt + " failed (" + (error.message || error) + ")");
      await sleep(1500 * attempt);
    }
  }

  throw new Error("Could not download " + what + " from " + url + ": " + (lastError && lastError.message));
}

async function getJson(url, what){
  return JSON.parse((await get(url, what)).toString("utf8"));
}

function save(relativePath, bytes){
  const target = path.join(voiceDir, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
}

// The names of the voices inside voices.npz (a zip of .npy files).
function npzNames(buffer){

  const names = [];

  if(buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50){
    throw new Error("voices.npz is not a zip file.");
  }

  let position = buffer.length - 22;

  while(position >= 0 && buffer.readUInt32LE(position) !== 0x06054b50){
    position--;
  }

  if(position < 0){
    throw new Error("voices.npz has no zip directory.");
  }

  const count = buffer.readUInt16LE(position + 10);
  let offset = buffer.readUInt32LE(position + 16);

  for(let i = 0; i < count; i++){

    if(buffer.readUInt32LE(offset) !== 0x02014b50){
      break;
    }

    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);

    names.push(buffer.toString("utf8", offset + 46, offset + 46 + nameLength).replace(/\.npy$/, ""));

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return names;
}

async function flatFiles(pkg, version){
  const listing = await getJson(JSDELIVR_DATA + "/" + pkg + "@" + version + "?structure=flat", pkg + " file list");
  return (listing.files || []).map(f => f.name);
}

// True when a complete voice pack is already in place (for example the one
// kept in the repository), so nothing has to be downloaded again.
function packAlreadyThere(){
  try{
    const pack = JSON.parse(fs.readFileSync(path.join(voiceDir, "voice-pack.json"), "utf8"));
    return ["ort", "model", "voices", "phonemizer"].every(key => {
      const file = path.join(siteDir, pack[key] || "");
      return pack[key] && fs.existsSync(file) && fs.statSync(file).size > 0;
    });
  }catch(error){
    return false;
  }
}

async function main(){

  if(packAlreadyThere()){
    console.log("Read Aloud voice: already in " + voiceDir + " - nothing to download.");
    return;
  }

  fs.rmSync(voiceDir, { recursive: true, force: true });
  fs.mkdirSync(voiceDir, { recursive: true });

  let total = 0;

  // ---- 1. The engine (onnxruntime-web) ----
  console.log("Read Aloud voice: the engine (onnxruntime-web " + ORT_VERSION + ")");

  const ortNames = (await flatFiles("onnxruntime-web", ORT_VERSION))
    .filter(name => /^\/dist\/(ort\.min\.js|ort-wasm[^/]*\.(wasm|mjs))$/.test(name) && !/jsep|training/.test(name));

  if(!ortNames.includes("/dist/ort.min.js")){
    throw new Error("ort.min.js is not in the onnxruntime-web package.");
  }

  for(const name of ortNames){
    const bytes = await get(JSDELIVR_CDN + "/onnxruntime-web@" + ORT_VERSION + name, name);
    save("ort/" + path.basename(name), bytes);
    total += bytes.length;
    console.log("  " + path.basename(name) + "  " + mb(bytes.length));
  }

  if(!ortNames.some(name => /\.wasm$/.test(name))){
    throw new Error("No .wasm file in the onnxruntime-web package.");
  }

  // ---- 2. The phonemizer ----
  console.log("Read Aloud voice: the phonemizer");

  const registry = await getJson(NPM_REGISTRY + "/phonemizer/latest", "phonemizer details");
  const phonemizerVersion = registry.version;

  let entry = registry.module || null;

  if(!entry && registry.exports){
    const root = registry.exports["."] !== undefined ? registry.exports["."] : registry.exports;
    const pick = value => {
      if(typeof value === "string"){
        return value;
      }
      if(value && typeof value === "object"){
        for(const key of ["import", "browser", "module", "default"]){
          if(value[key]){
            const found = pick(value[key]);
            if(found){
              return found;
            }
          }
        }
      }
      return null;
    };
    entry = pick(root);
  }

  if(!entry){
    entry = registry.main || "index.js";
  }

  entry = String(entry).replace(/^\.\//, "").replace(/^\//, "");

  const phonemizerNames = (await flatFiles("phonemizer", phonemizerVersion))
    .filter(name => !/\.(map|ts|md)$/.test(name) && !/^\/(test|tests|docs|examples)\//.test(name));

  if(!phonemizerNames.includes("/" + entry)){
    throw new Error("The phonemizer's entry file (" + entry + ") is not in its package.");
  }

  for(const name of phonemizerNames){
    const bytes = await get(JSDELIVR_CDN + "/phonemizer@" + phonemizerVersion + name, name);
    save("phonemizer" + name, bytes);
    total += bytes.length;
    if(bytes.length > 1e6){
      console.log("  " + name.slice(1) + "  " + mb(bytes.length));
    }
  }

  // ---- 3. The voice model and the voices ----
  console.log("Read Aloud voice: the voice model");

  const model = await get(HF_BASE + "/" + MODEL_REPO + "/resolve/main/" + MODEL_FILE, MODEL_FILE);

  if(model.length < 5e6 || model.slice(0, 15).toString("latin1").toLowerCase().includes("<!doctype")){
    throw new Error(MODEL_FILE + " does not look like a model (" + model.length + " bytes).");
  }

  save(MODEL_FILE, model);
  total += model.length;
  console.log("  " + MODEL_FILE + "  " + mb(model.length));

  const voices = await get(HF_BASE + "/" + MODEL_REPO + "/resolve/main/voices.npz", "voices.npz");
  const voiceNames = npzNames(voices);

  if(!voiceNames.length){
    throw new Error("voices.npz holds no voices.");
  }

  save("voices.npz", voices);
  total += voices.length;
  console.log("  voices.npz  " + mb(voices.length) + "  (" + voiceNames.join(", ") + ")");

  // ---- 4. Tell the pages it is all here ----
  save("voice-pack.json", JSON.stringify({
    version: 1,
    ort: "voice/ort/ort.min.js",
    ortBase: "voice/ort/",
    model: "voice/" + MODEL_FILE,
    voices: "voice/voices.npz",
    phonemizer: "voice/phonemizer/" + entry,
    voiceNames
  }, null, 2));

  console.log("Read Aloud voice: built in (" + mb(total) + ").");
}

main().catch(error => {
  fs.rmSync(voiceDir, { recursive: true, force: true });
  console.log("::warning title=Read Aloud voice not built in::" + (error && error.message ? error.message : error) + " The app is built without the voice.");
  process.exit(0);
});
