/* ==========================================================
   assistant-window.js
   Lanthano Research Assistant — Window Manager

   Design goals (in order of priority):
   1. Never invent information — every answer must be traceable
      to descriptions.json. If the archive doesn't cover something,
      say so instead of guessing.
   2. Bounded memory — the assistant remembers only the last few
      exchanges so a visitor can ask a quick follow-up without
      repeating themselves, but a long conversation can never
      "dilute" or override its core rules, because those rules are
      re-injected fresh at the start of every single request.
   3. Clear identity — this is a local search convenience, not an
      authority. It says so, and links back to source documents
      so visitors can verify anything that matters.

   Requires: descriptions.json (required), search-index.json
   (optional) at the site root. The actual search-and-answer logic
   lives in research-assistant-engine.js, imported below — this file
   is the chat widget UI (buttons, modals, download management)
   wrapped around it.
   ========================================================== */

import { ResearchAssistant } from "./research-assistant-engine.js";


const HISTORY_KEY = "lr-ai-history";
const MAX_STORED_MESSAGES = 60;
const MEMORY_ENABLED_KEY = "lr-ai-memory-enabled";
// Must match the mobile breakpoint in assistant.css, where the panel
// switches from a docked side window to a full-screen takeover.
const MOBILE_BREAKPOINT = 768;

// Kept to just one prior exchange, and off by default. A tiny model
// like this one has a small context window, and adding memory back
// in on the second question is very likely what was making it work
// once and then quietly stop: the first question fits fine, the
// second one (now with a whole extra exchange folded in) pushes past
// the limit and fails every time after. Off by default avoids that
// for most people; anyone can turn it on in Settings if they want it.
// Also configures how much history ResearchAssistant.ask() is given
// below, so the UI's own memory toggle and the engine's internal
// trimming stay in agreement.
const MEMORY_EXCHANGES = 1;

function isMemoryEnabled() {
    try {
        return localStorage.getItem(MEMORY_ENABLED_KEY) === "yes";
    } catch (error) {
        console.error("Lanthano Assistant: failed to read memory preference", error);
        return false;
    }
}

function setMemoryEnabled(enabled) {
    try {
        localStorage.setItem(MEMORY_ENABLED_KEY, enabled ? "yes" : "no");
    } catch (error) {
        console.error("Lanthano Assistant: failed to save memory preference", error);
    }
}

const INFO_TEXT = "Runs on your device. Downloads a small AI model once, about 400MB, then works offline. Nothing you type is sent anywhere. It searches this archive and is not an authority, so please check anything important against the original documents.";

/* ----------------------------------------------------------
   Small utilities
   ---------------------------------------------------------- */

function escapeHTML(str) {
    return String(str ?? "").replace(/[&<>"']/g, ch => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    }[ch]));
}

/* ----------------------------------------------------------
   The knowledge base + retrieval logic (search, context building,
   citations, the system prompt) all live in research-assistant-
   engine.js now, imported at the top of this file. One instance is
   created below and reused for every question — see handleSend().
   ---------------------------------------------------------- */

const researchAssistant = new ResearchAssistant({
    descriptionsUrl: "descriptions.json",
    searchIndexUrl: "search-index.json",
    // General site pages (not archive documents) the assistant should
    // also be able to draw on, so "what is this website" or "who runs
    // this" has real content to answer from. Add more here as needed;
    // a missing page is skipped quietly rather than breaking anything.
    sitePages: [
        { url: "about.html", title: "About Lanthano Research" }
    ],
    assistantName: "the Lanthano Research Archive Assistant",
    pdfHref: (url, title) => "pdf.html?file=" + encodeURIComponent(url) + "&paper=" + encodeURIComponent(title),
    imageHref: (imageFile, paperTitle) => "image.html?image=" + encodeURIComponent(imageFile) + "&paper=" + encodeURIComponent(paperTitle),
    memoryExchanges: MEMORY_EXCHANGES
});


/* ----------------------------------------------------------
   On-device model — one path, deliberately.

   Earlier versions tried the browser's built-in AI first and fell
   back to a downloaded model if that failed. Two engines meant two
   sets of detection logic, two failure states, and two things that
   could each go wrong in their own way — which made "it just never
   works" hard to diagnose and, worse, hard to trust. Chrome's
   built-in AI is also rare enough in practice (an experimental
   feature behind flags in most installs) that supporting it added
   real complexity for very little payoff.

   So: one engine. A small model, downloaded once via WebLLM and run
   locally using WebGPU, cached by the browser afterward. Still no
   server, no account, no per-message cost, nothing sent off the
   device — just one path instead of two, so there's exactly one
   thing to get right, and exactly one thing to check if it doesn't.
   ---------------------------------------------------------- */

// Swap this for a smaller/larger model as needed. Smaller = faster
// download, less memory, and much more likely to actually work on a
// phone-class GPU:
//   "Qwen2.5-0.5B-Instruct-q4f16_1-MLC"  ~380MB, lighter (default — safest bet on mobile)
//   "Llama-3.2-1B-Instruct-q4f16_1-MLC"  ~880MB, better answers, needs more memory
// Full list: see prebuiltAppConfig in the WebLLM repo.
const WEBLLM_MODEL_ID = "Qwen2.5-0.5B-Instruct-q4f16_1-MLC";
// Two CDN sources are tried in order — if the first is blocked, down,
// or just slow to resolve in this browser, the second gets a shot
// before giving up entirely. One flaky CDN shouldn't be "the AI never
// works."
const WEBLLM_CDN_URLS = [
    "https://esm.run/@mlc-ai/web-llm",
    "https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm/+esm"
];
const WEBLLM_CONSENT_KEY = "lr-ai-webllm-consent";

let webllmEnginePromise = null;
// True only once a real, working engine actually exists, separate
// from webllmEnginePromise itself. A Promise is truthy the instant
// it's created, not once it resolves, so checking the promise alone
// was treating "still downloading" as "already ready" and unlocking
// the text box before the model was actually usable.
let webllmReady = false;
let webllmDownloading = false;
// Once a download-and-run attempt fails outright, we stop retrying it
// automatically on every single message — that "downloads, fails,
// downloads again" loop is exactly what silently re-triggering a
// multi-hundred-MB download on every question would cause. Instead we
// fail once, remember it, and only try again if the visitor explicitly
// asks to via the Settings button.
let webllmBroken = false;
// A single hiccup on an already-working engine (a one-off timeout, a
// dropped GPU context, etc.) shouldn't permanently give up for the
// rest of the session. Only repeated, consecutive failures count as
// genuinely broken. Any success resets the count back to zero.
const MAX_CONSECUTIVE_FAILURES = 2;
let webllmFailureCount = 0;
let lastEngineError = ""; // surfaced in the settings panel for diagnostics

function resetFailureCounters() {
    webllmFailureCount = 0;
}

function hasWebGPU() {
    return typeof navigator !== "undefined" && !!navigator.gpu;
}

/**
 * navigator.gpu existing only means the browser shipped the WebGPU
 * API surface — it does not mean this device's actual GPU and driver
 * can produce a working adapter. That gap is a real, silent failure
 * mode: CreateMLCEngine would just sit there with zero progress
 * forever, which looks identical to a stalled network but is a
 * completely different, unfixable-by-waiting problem. Checking this
 * directly, before attempting anything else, turns "waited 90
 * seconds and nothing happened" into an immediate, accurate answer.
 */
async function checkWebGPUAdapter() {
    if (!hasWebGPU()) {
        return { ok: false, reason: "WebGPU is not available in this browser." };
    }

    try {
        const adapterPromise = navigator.gpu.requestAdapter();
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error("Checking for a usable GPU took too long.")), 10000);
        });

        const adapter = await Promise.race([adapterPromise, timeoutPromise]);

        if (!adapter) {
            return {
                ok: false,
                reason: "This browser reports WebGPU support, but no usable GPU adapter could be found on this specific device. The AI model needs a working GPU adapter to run at all, and no amount of waiting will change that."
            };
        }

        return { ok: true, adapter };
    } catch (error) {
        return { ok: false, reason: "Checking for a usable GPU failed: " + (error?.message || error) };
    }
}

// hasWebGPU() only proves the browser shipped the API object — it
// says nothing about whether this device's actual GPU and driver can
// produce a working adapter. Gating the download prompt on hasWebGPU()
// alone was the actual dead end: a device with the API present but no
// real adapter would get locked into "must download to type," try
// forever, fail every time (the adapter check above would catch it,
// but only once an attempt actually started), and never unlock.
// This verifies capability once, caches the answer, and is what
// gating decisions should check instead — a device that genuinely
// can't run the model gets treated exactly like one with no WebGPU at
// all: search still works immediately, with no dead-end loop.
let webgpuCapability = null;
async function isWebGPUActuallyCapable() {
    if (webgpuCapability !== null) return webgpuCapability;
    if (!hasWebGPU()) {
        webgpuCapability = false;
        return false;
    }
    const check = await checkWebGPUAdapter();
    webgpuCapability = check.ok;
    return webgpuCapability;
}

/**
 * How long to wait for a progress update before treating a download
 * attempt as genuinely stalled rather than just slow. Scaled up on a
 * connection that self-reports as slow, since a fixed short timeout
 * is exactly what would keep killing and restarting a download that
 * was actually still making progress, just gradually.
 */
function getStallTimeoutMs() {
    const DEFAULT_MS = 90000;

    if (typeof navigator === "undefined" || !navigator.connection) return DEFAULT_MS;

    const conn = navigator.connection;
    if (conn.saveData) return 240000;
    if (conn.effectiveType === "slow-2g" || conn.effectiveType === "2g") return 240000;
    if (conn.effectiveType === "3g") return 150000;
    if (typeof conn.downlink === "number" && conn.downlink > 0 && conn.downlink < 1) return 180000;

    return DEFAULT_MS;
}

/**
 * Resets all engine state so the next call starts completely fresh —
 * used both by an explicit "retry" from Settings and by the full
 * "uninstall" reset.
 */
function resetWebLLMState() {
    webllmEnginePromise = null;
    webllmReady = false;
    webllmDownloading = false;
    webllmBroken = false;
    webllmFailureCount = 0;
    lastEngineError = "";
}

// Set by the AssistantWindow instance so this module-level function
// can show the real, in-widget download modal instead of the
// browser's plain confirm() box. Falls back to confirm() only if
// nothing has registered a handler yet (shouldn't normally happen).
let consentRequestHandler = null;
function setConsentRequestHandler(fn) {
    consentRequestHandler = fn;
}

async function getWebLLMEngine(onProgress) {
    if (webllmBroken) return null;
    if (webllmEnginePromise) return webllmEnginePromise;

    let consent = null;
    try {
        consent = sessionStorage.getItem(WEBLLM_CONSENT_KEY);
    } catch (error) {
        console.error("Lanthano Assistant: failed to read download consent", error);
    }
    if (consent === "no") return null;

    if (consent !== "yes") {
        const agreed = typeof consentRequestHandler === "function"
            ? await consentRequestHandler()
            : window.confirm("Download a small AI model to answer questions about the archive on this device?");
        try {
            sessionStorage.setItem(WEBLLM_CONSENT_KEY, agreed ? "yes" : "no");
        } catch (error) {
            console.error("Lanthano Assistant: failed to save download consent", error);
        }
        if (!agreed) return null;
    }

    webllmEnginePromise = (async () => {
        webllmDownloading = true;
        try {
            // Check for a real, usable GPU adapter before doing
            // anything else — this is the check that turns "waited the
            // full stall timeout and got nothing" into an immediate,
            // specific answer when the actual problem is that this
            // device's GPU can't run WebGPU at all, despite the browser
            // technically supporting the API.
            const adapterCheck = await checkWebGPUAdapter();
            if (!adapterCheck.ok) {
                throw new Error(adapterCheck.reason);
            }

            let webllm = null;
            let importError = null;

            for (const url of WEBLLM_CDN_URLS) {
                try {
                    webllm = await import(/* webpackIgnore: true */ url);
                    break;
                } catch (error) {
                    console.error("Lanthano Assistant: WebLLM import failed from " + url, error);
                    importError = error;
                }
            }

            if (!webllm) {
                throw importError || new Error("Could not load the WebLLM library from any source.");
            }

            // The download itself (a few hundred MB, in many small pieces)
            // is the single most likely thing to hit a transient network
            // hiccup, like a dropped connection partway through or a
            // request that times out. That is usually self correcting,
            // so it gets a couple of automatic retries before this
            // counts as a real failure, rather than making the visitor
            // manually hit Retry for something that would have just
            // worked on its own a moment later.
            const MAX_LOAD_ATTEMPTS = 3;
            // If nothing has happened for this long, this attempt is
            // treated as stalled rather than left to hang indefinitely.
            // This needs to be generous: on a slow connection, a single
            // chunk can legitimately take a while between progress
            // updates, and a strict timeout would keep killing and
            // restarting a download that was actually still working,
            // which looks exactly like "it never finishes" from the
            // outside. Scaled up further on a connection that reports
            // itself as slow, since that's the exact case this needs
            // to be patient for rather than fighting against.
            const STALL_TIMEOUT_MS = getStallTimeoutMs();
            let lastLoadError = null;

            for (let attempt = 1; attempt <= MAX_LOAD_ATTEMPTS; attempt++) {
                try {
                    let lastProgressAt = Date.now();
                    let stallInterval = null;

                    const enginePromise = webllm.CreateMLCEngine(WEBLLM_MODEL_ID, {
                        initProgressCallback: report => {
                            lastProgressAt = Date.now();
                            if (typeof onProgress === "function") {
                                const fraction = typeof report.progress === "number" ? report.progress : 0;
                                const label = report.text || `Downloading model… (${Math.round(fraction * 100)}%)`;
                                onProgress(attempt > 1 ? `Retrying download… ${label}` : label, fraction);
                            }
                        }
                    });

                    const stallPromise = new Promise((resolve, reject) => {
                        stallInterval = setInterval(() => {
                            if (Date.now() - lastProgressAt > STALL_TIMEOUT_MS) {
                                clearInterval(stallInterval);
                                const stallError = new Error("The download made no progress for a couple of minutes. This looks like a stalled connection, not just a slow one.");
                                // Tagged so the retry logic below can tell
                                // this apart from a real, thrown network
                                // error — see the note there for why that
                                // distinction matters.
                                stallError.isStall = true;
                                reject(stallError);
                            }
                        }, 3000);
                    });

                    let engine;
                    try {
                        engine = await Promise.race([enginePromise, stallPromise]);
                    } finally {
                        clearInterval(stallInterval);
                    }

                    // Verify the engine actually has the API surface we
                    // need before declaring success — catching a
                    // library/version mismatch right here, immediately,
                    // instead of discovering it on the first real chat
                    // message (which is what caused the "downloads, then
                    // never works" symptom).
                    if (!engine || typeof engine?.chat?.completions?.create !== "function") {
                        throw new Error("The downloaded model loaded but is missing its expected chat API.");
                    }

                    return engine;
                } catch (error) {
                    console.error(`Lanthano Assistant: engine load attempt ${attempt} failed`, error);
                    lastLoadError = error;

                    // A stalled attempt is deliberately NOT auto-retried,
                    // even though it's also a network-shaped problem.
                    // Browsers give JS no way to truly cancel an
                    // in-flight model load, so the stalled attempt is
                    // still out there running in the background even
                    // after we give up on waiting for it. Starting a
                    // second CreateMLCEngine call on top of that would
                    // mean two concurrent attempts fighting over the
                    // same GPU, which is more likely to make things
                    // worse on a constrained mobile device than better.
                    // A genuine thrown network error, by contrast,
                    // means the previous attempt has actually finished
                    // (with a failure) before this runs, so retrying
                    // that case is safe.
                    const looksLikeNetworkHiccup = !error?.isStall && /network|fetch|cache/i.test(error?.message || "");
                    if (attempt < MAX_LOAD_ATTEMPTS && looksLikeNetworkHiccup) {
                        if (typeof onProgress === "function") {
                            onProgress("Download was interrupted. Trying again", 0);
                        }
                        await new Promise(resolve => setTimeout(resolve, 1500));
                        continue;
                    }
                    throw error;
                }
            }

            throw lastLoadError || new Error("The model failed to load.");
        } finally {
            webllmDownloading = false;
        }
    })();

    try {
        const engine = await webllmEnginePromise;
        lastEngineError = "";
        webllmReady = true;
        return engine;
    } catch (error) {
        console.error("Lanthano Assistant: WebLLM engine failed to load", error);
        const rawMessage = error?.message || String(error);
        const looksLikeNetworkHiccup = /network|fetch|cache/i.test(rawMessage);
        const looksLikeNoAdapter = /adapter|gpu/i.test(rawMessage);
        lastEngineError = looksLikeNoAdapter
            ? rawMessage
            : looksLikeNetworkHiccup
            ? "The download kept getting interrupted (looks like a connection issue, not a compatibility one). Try switching to Wi-Fi if you're on mobile data, then tap retry. Details: " + rawMessage
            : "The downloadable model failed to load: " + rawMessage;
        webllmEnginePromise = null;
        webllmBroken = true;
        return null;
    }
}

/**
 * The `generate` function handed to ResearchAssistant.ask() — the
 * engine builds the full messages array (system prompt, trimmed
 * history, the question with its context), this just sends that to
 * whichever engine is already downloaded and returns the reply text.
 * By the time this can be called at all, the download-gating flow
 * elsewhere in this file has already made sure a working engine
 * exists, so this stays a thin wrapper rather than re-implementing
 * any of that.
 */
async function generateWithWebLLM(messages, onProgress) {
    if (webgpuCapability === false) {
        throw new Error("This device can't run the AI model (no usable GPU found).");
    }

    const engine = await getWebLLMEngine(onProgress);
    if (!engine) throw new Error(lastEngineError || "The AI model isn't available.");

    try {
        const completion = await engine.chat.completions.create({ messages, temperature: 0.3, max_tokens: 400 });
        const text = completion?.choices?.[0]?.message?.content;

        if (!text) {
            throw new Error("The model returned an empty response.");
        }

        lastEngineError = "";
        webllmFailureCount = 0;
        return text.trim();
    } catch (error) {
        console.error("Lanthano Assistant: model prompt failed", error);
        const rawMessage = error?.message || String(error);
        const looksLikeContextOverflow = /context|token|length|exceed/i.test(rawMessage);
        lastEngineError = looksLikeContextOverflow
            ? "The question (plus archive context) was too long for this model to handle: " + rawMessage
            : "The downloaded model failed to respond: " + rawMessage;
        // The model is already downloaded at this point, so a retry here
        // is cheap (unlike a download failure) — a one-off hiccup
        // shouldn't nuke the whole session. Only give up for good after
        // a couple of failures in a row.
        webllmFailureCount++;
        if (webllmFailureCount >= MAX_CONSECUTIVE_FAILURES) webllmBroken = true;
        throw error;
    }
}

/**
 * A plain-text snapshot of everything relevant to why the AI might
 * not be working on this particular device/browser — meant to be
 * copied and shared, since guessing blind at "it doesn't work" from
 * the other end isn't very productive. Nothing here is sent
 * anywhere automatically; it only goes wherever the visitor pastes it.
 */
async function buildDiagnosticsReport() {
    const lines = [];
    lines.push("Lanthano Research Assistant diagnostics");
    lines.push("User agent: " + (typeof navigator !== "undefined" ? navigator.userAgent : "unknown"));
    lines.push("Screen: " + (typeof window !== "undefined" ? `${window.innerWidth}×${window.innerHeight}` : "unknown"));
    lines.push("WebGPU (navigator.gpu) present: " + hasWebGPU());

    const adapterCheck = await checkWebGPUAdapter();
    if (adapterCheck.ok) {
        let infoText = "";
        try {
            const info = adapterCheck.adapter?.info;
            if (info) {
                infoText = ` (${[info.vendor, info.architecture, info.device].filter(Boolean).join(", ")})`;
            }
        } catch (error) {
            console.error("Lanthano Assistant: failed to read adapter info", error);
        }
        lines.push("GPU adapter: found" + infoText);
    } else {
        lines.push("GPU adapter: not usable, " + adapterCheck.reason);
    }

    if (typeof navigator !== "undefined" && navigator.connection) {
        const conn = navigator.connection;
        lines.push(
            "Network: " +
            [conn.effectiveType, conn.downlink != null ? conn.downlink + "Mbps" : null, conn.saveData ? "data-saver on" : null]
                .filter(Boolean)
                .join(", ")
        );
    }

    lines.push("Model marked broken this session: " + webllmBroken + " (failures: " + webllmFailureCount + ")");
    lines.push("Model currently loaded: " + webllmReady);
    lines.push("Model id: " + WEBLLM_MODEL_ID);
    lines.push("Stall timeout used: " + Math.round(getStallTimeoutMs() / 1000) + "s per attempt");
    lines.push("Last error: " + (lastEngineError || "(none recorded)"));

    return lines.join("\n");
}

function getEngineStatusText() {
    if (!hasWebGPU()) return "This browser doesn't support WebGPU, which this assistant needs to run an AI model. You'll still get archive search results without generated answers.";
    if (webgpuCapability === false) return "This device's GPU doesn't support what's needed to run the AI model, even though the browser itself does. You'll still get archive search results without generated answers.";
    if (webllmDownloading) return "Downloading the AI model. This keeps going even if you close this panel or the chat window. It only has to happen once.";
    if (webllmBroken) return "The AI model didn't work last time. It won't keep retrying on its own, use the button below to try again.";
    if (webllmReady) return "AI model downloaded and ready, cached in this browser.";
    return "Not downloaded yet. Tap Download AI model below, or it will ask the first time you send a question.";
}

/* ----------------------------------------------------------
   Chat history persistence
   ---------------------------------------------------------- */

function loadHistory() {
    try {
        const raw = localStorage.getItem(HISTORY_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch (error) {
        console.error("Lanthano Assistant: failed to read history", error);
        return [];
    }
}

function saveHistory(history) {
    try {
        const trimmed = history.slice(-MAX_STORED_MESSAGES);
        localStorage.setItem(HISTORY_KEY, JSON.stringify(trimmed));
    } catch (error) {
        console.error("Lanthano Assistant: failed to save history", error);
    }
}

/* ----------------------------------------------------------
   Window manager
   ---------------------------------------------------------- */

class AssistantWindow {

    constructor() {
        this.root = document.getElementById("lr-ai-root");
        if (!this.root) {
            console.error("AI root not found.");
            return;
        }

        this.window = document.getElementById("lr-ai-window");
        if (!this.window) {
            this.window = document.createElement("div");
            this.window.id = "lr-ai-window";
            this.root.appendChild(this.window);
        }

        this.isOpen = false;
        this.isBusy = false;
        this.aiInputLocked = false;
        this._downloadGeneration = 0;
        this.history = loadHistory();

        this.build();
        this.bindEvents();
        setConsentRequestHandler(() => this.requestDownloadConsent());
        this.renderHistory();
        this.renderWelcomeIfEmpty();

        // Warm up the knowledge base in the background so the
        // first question doesn't have to wait on it.
        researchAssistant.loadKnowledgeBase();
    }

    renderWelcomeIfEmpty() {
        if (this.history.length) return;
        this.pushMessage({
            role: "notice",
            text: "Hi! I'm a small search tool for this archive. I only answer from what's here and never make things up. Tap Settings for details."
        });
    }

    build() {
        this.window.innerHTML = `
            <div id="lr-ai-header">
                <div id="lr-ai-title">
                    <img src="${new URL("aiimage.png", import.meta.url).href}" alt="AI">
                    <div id="lr-ai-title-text">
                        <strong>Lanthano Research Assistant</strong>
                        <span>A local search tool for this archive</span>
                    </div>
                </div>
                <button id="lr-ai-close" type="button" aria-label="Close">×</button>
            </div>

            <div id="lr-ai-settings-panel">
                <div id="lr-ai-settings-header">
                    <button id="lr-ai-settings-back" type="button">
                        <span id="lr-ai-settings-back-arrow">◀</span> Back to Chat
                    </button>
                    <span id="lr-ai-settings-heading">Settings</span>
                </div>

                <div id="lr-ai-settings-body">
                    <div class="lr-settings-section">
                        <p id="lr-ai-settings-about">${escapeHTML(INFO_TEXT)}</p>
                    </div>

                    <div class="lr-settings-section">
                        <div class="lr-settings-section-title">Conversation</div>

                        <div class="lr-settings-row" id="lr-ai-memory-row">
                            <span>
                                <span class="lr-settings-row-title">Remember recent messages</span>
                                <span class="lr-settings-row-desc">Helps with quick follow ups. Off means each question stands alone.</span>
                            </span>
                            <button id="lr-ai-memory-toggle" class="toggleSwitch" role="switch" aria-checked="false" aria-label="Remember recent messages"><span class="toggleKnob"></span></button>
                        </div>

                        <button id="lr-ai-clear" type="button" class="lr-settings-action">
                            Erase all history
                        </button>
                    </div>

                    <div class="lr-settings-section">
                        <div class="lr-settings-section-title">AI model</div>

                        <div id="lr-ai-engine-status">
                            <div id="lr-ai-engine-status-text"></div>
                            <div id="lr-ai-progress-track">
                                <div id="lr-ai-progress-fill"></div>
                            </div>
                        </div>

                        <button id="lr-ai-download-model" type="button" class="lr-settings-action">
                            Download AI model
                        </button>

                        <button id="lr-ai-cancel-download" type="button" class="lr-settings-action lr-settings-action-danger" hidden>
                            Cancel download
                        </button>

                        <button id="lr-ai-diagnostics" type="button" class="lr-settings-action" hidden>
                            Copy diagnostics report
                        </button>

                        <button id="lr-ai-uninstall" type="button" class="lr-settings-action lr-settings-action-danger">
                            Uninstall AI model
                        </button>
                    </div>
                </div>
            </div>

            <div id="lr-ai-messages"></div>

            <div id="lr-ai-download-bar" hidden><div id="lr-ai-download-bar-fill"></div></div>

            <div id="lr-ai-input-area">
                <button id="lr-ai-settings-btn" type="button" title="Settings" aria-label="Settings"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z"></path></svg></button>
                <input
                    id="lr-ai-input"
                    type="text"
                    autocomplete="off"
                    spellcheck="false"
                    maxlength="300"
                    placeholder="Ask about the archive">
                <button id="lr-ai-send" type="button" aria-label="Send">➤</button>
            </div>

            <div id="lr-ai-modal">
                <div id="lr-ai-modal-card">
                    <h3 id="lr-ai-modal-title"></h3>
                    <p id="lr-ai-modal-message"></p>
                    <textarea id="lr-ai-modal-textarea" readonly hidden></textarea>
                    <div class="choiceModalButtons">
                        <button id="lr-ai-modal-confirm"></button>
                    </div>
                    <button id="lr-ai-modal-cancel"></button>
                </div>
            </div>
        `;

        this.messages = this.window.querySelector("#lr-ai-messages");
        this.input = this.window.querySelector("#lr-ai-input");
        this.sendButton = this.window.querySelector("#lr-ai-send");
        this.closeButton = this.window.querySelector("#lr-ai-close");
        this.clearButton = this.window.querySelector("#lr-ai-clear");
        this.settingsButton = this.window.querySelector("#lr-ai-settings-btn");
        this.settingsPanel = this.window.querySelector("#lr-ai-settings-panel");
        this.settingsBackButton = this.window.querySelector("#lr-ai-settings-back");
        this.downloadModelButton = this.window.querySelector("#lr-ai-download-model");
        this.cancelDownloadButton = this.window.querySelector("#lr-ai-cancel-download");
        this.diagnosticsButton = this.window.querySelector("#lr-ai-diagnostics");
        this.uninstallButton = this.window.querySelector("#lr-ai-uninstall");
        this.memoryToggle = this.window.querySelector("#lr-ai-memory-toggle");
        this.engineStatusEl = this.window.querySelector("#lr-ai-engine-status");
        this.engineStatusTextEl = this.window.querySelector("#lr-ai-engine-status-text");
        this.progressTrackEl = this.window.querySelector("#lr-ai-progress-track");
        this.progressFillEl = this.window.querySelector("#lr-ai-progress-fill");
        this.downloadBar = this.window.querySelector("#lr-ai-download-bar");
        this.downloadBarFill = this.window.querySelector("#lr-ai-download-bar-fill");
        this.modal = this.window.querySelector("#lr-ai-modal");
        this.modalTitleEl = this.window.querySelector("#lr-ai-modal-title");
        this.modalMessageEl = this.window.querySelector("#lr-ai-modal-message");
        this.modalTextareaEl = this.window.querySelector("#lr-ai-modal-textarea");
        this.modalConfirmButton = this.window.querySelector("#lr-ai-modal-confirm");
        this.modalCancelButton = this.window.querySelector("#lr-ai-modal-cancel");

        this.setMemoryToggle(isMemoryEnabled());
    }

    setMemoryToggle(enabled) {
        this.memoryToggle.classList.toggle("active", enabled);
        this.memoryToggle.setAttribute("aria-checked", String(enabled));
    }


    bindEvents() {
        this.closeButton.addEventListener("click", () => this.close());

        this.settingsButton.addEventListener("click", () => this.openSettings());
        this.settingsBackButton.addEventListener("click", () => this.closeSettings());

        this.clearButton.addEventListener("click", async () => {
            if (!this.history.length) return;
            const confirmed = await this.showModal({
                title: "Erase History",
                message: "This erases the entire conversation. This cannot be undone.",
                confirmText: "Erase",
                cancelText: "Cancel",
                danger: true
            });
            if (!confirmed) return;
            this.history = [];
            saveHistory(this.history);
            this.messages.innerHTML = "";
            this.renderWelcomeIfEmpty();
            // Jump back to the chat view so the visitor can immediately
            // see it actually worked, instead of trusting a settings
            // screen with nothing visibly different on it.
            this.closeSettings();
        });

        this.memoryToggle.addEventListener("click", () => {
            const enabled = !this.memoryToggle.classList.contains("active");
            this.setMemoryToggle(enabled);
            setMemoryEnabled(enabled);
        });

        this.downloadModelButton.addEventListener("click", async () => {
            await this.startDownload({ force: true });
        });

        this.cancelDownloadButton.addEventListener("click", () => {
            this.cancelDownload();
        });

        this.modalConfirmButton.addEventListener("click", () => {
            this.modal.classList.remove("open");
            if (this._modalResolve) {
                this._modalResolve(true);
                this._modalResolve = null;
            }
        });

        this.modalCancelButton.addEventListener("click", () => {
            this.modal.classList.remove("open");
            if (this._modalResolve) {
                this._modalResolve(false);
                this._modalResolve = null;
            }
        });

        this.uninstallButton.addEventListener("click", () => this.handleUninstall());

        this.diagnosticsButton.addEventListener("click", async () => {
            const report = await buildDiagnosticsReport();
            try {
                await navigator.clipboard.writeText(report);
                this.setEngineStatus("Diagnostics copied. Paste them wherever you're getting help.", null);
            } catch (error) {
                console.error("Lanthano Assistant: clipboard copy failed", error);
                // Clipboard access can be blocked in some contexts, so
                // fall back to just showing it to select and copy by hand.
                await this.showModal({
                    title: "Diagnostics",
                    message: "Couldn't copy automatically. Select the text below and copy it by hand.",
                    confirmText: "Done",
                    textareaContent: report
                });
            }
        });

        this.sendButton.addEventListener("click", () => this.handleSend());

        this.input.addEventListener("keydown", event => {
            if (event.key === "Enter") {
                event.preventDefault();
                this.handleSend();
            }
        });

        // Blocked while the AI hasn't been downloaded or declined yet
        // this visit — trying to use the box brings the download
        // prompt back up instead of silently doing nothing.
        this.input.addEventListener("mousedown", event => {
            if (this.aiInputLocked) {
                event.preventDefault();
                this.startDownload({ force: true });
            }
        });

        this.input.addEventListener("focus", () => {
            if (this.aiInputLocked) {
                this.input.blur();
                this.startDownload({ force: true });
            }
        });

        // Escape from anywhere in the widget: back out of Settings
        // first if it's open, only closing the whole assistant if it
        // wasn't — so Escape can never skip past an open settings
        // screen straight to closing everything.
        this.window.addEventListener("keydown", event => {
            if (event.key !== "Escape") return;
            if (this.settingsPanel.classList.contains("open")) {
                this.closeSettings();
            } else {
                this.close();
            }
        });
    }

    refreshEngineStatus() {
        this.setEngineStatus(getEngineStatusText(), webllmDownloading ? 0 : (webllmReady ? 1 : null));
        this.refreshDownloadButton();
    }

    /**
     * Diagnostics only need to exist when something's actually wrong —
     * showing it all the time just adds clutter to a screen that's
     * normally nothing to look at. Same idea for the download button's
     * label: "Download" the first time, "Reinstall" once there's
     * already an attempt to replace.
     */
    refreshDownloadButton() {
        this.diagnosticsButton.hidden = !webllmBroken;
        this.downloadModelButton.textContent = webllmEnginePromise || webllmBroken
            ? "Reinstall AI model"
            : "Download AI model";
    }

    /**
     * Shared by the Settings button and the "offer it on open" flow —
     * forces a genuinely fresh attempt (clearing any prior broken
     * state and consent decision) so this always actually retries
     * instead of just returning a cached failure.
     */
    async startDownload(options = {}) {
        const { force = false } = options;

        if (!(await isWebGPUActuallyCapable())) {
            this.setEngineStatus("This device can't run the AI model (no usable GPU found), so it can't be downloaded here.", null);
            this.updateInputLock(false);
            return;
        }

        // Already running from an earlier trigger, don't restart it.
        if (webllmDownloading) {
            this.updateInputLock(true, "downloading");
            return;
        }

        // Genuinely finished and working (not just "a promise exists" —
        // see webllmReady's definition above for why that distinction
        // matters).
        if (webllmReady) {
            this.updateInputLock(false);
            return;
        }

        if (force) {
            resetWebLLMState();
            try {
                sessionStorage.removeItem(WEBLLM_CONSENT_KEY);
            } catch (error) {
                console.error("Lanthano Assistant: failed to clear download consent", error);
            }
        }

        // Identifies this specific attempt, so that if it gets
        // cancelled, any progress callback that still fires afterward
        // (the underlying fetch can't actually be aborted, just
        // abandoned) is recognized as stale and ignored instead of
        // overwriting the "cancelled" status with old progress.
        const myGeneration = ++this._downloadGeneration;

        this.updateInputLock(true, "waiting");
        this.downloadModelButton.disabled = true;
        this.cancelDownloadButton.hidden = false;

        let engine;
        try {
            engine = await getWebLLMEngine((label, fraction) => {
                if (myGeneration !== this._downloadGeneration) return;
                this.setEngineStatus(label, fraction);
                this.updateInputLock(true, "downloading", fraction);
            });
        } finally {
            if (myGeneration === this._downloadGeneration) {
                this.downloadModelButton.disabled = false;
                this.cancelDownloadButton.hidden = true;
            }
        }

        if (myGeneration !== this._downloadGeneration) return; // cancelled while this was running

        this.refreshDownloadButton();

        if (!engine) {
            this.setEngineStatus(lastEngineError || "The download didn't finish. You can try again.", null);
            // Stay locked, whether that was a decline or a real
            // failure. Tapping the box again brings the prompt right
            // back up (see the mousedown/focus guards on the input) so
            // this can be repeated as many times as needed, but typing
            // itself only ever unlocks once the model actually works.
            this.updateInputLock(true, "waiting");
            return;
        }

        this.setEngineStatus("AI model downloaded and ready. It stays saved for next time.", 1);
        this.updateInputLock(false);
    }

    /**
     * Gives up on waiting for the current attempt rather than a true
     * network-level abort (browsers don't expose a clean way to cancel
     * an in-flight fetch buried inside a third-party library like
     * this). The generation counter means any late callback from the
     * abandoned attempt is ignored, and the UI resets immediately so
     * the visitor is never stuck looking at a permanently grayed out
     * button while something they can no longer see is still trying.
     */
    cancelDownload() {
        this._downloadGeneration++;
        resetWebLLMState();
        this.downloadModelButton.disabled = false;
        this.cancelDownloadButton.hidden = true;
        this.refreshDownloadButton();
        this.updateInputLock(true, "waiting");
        this.setEngineStatus("Download cancelled. You can try again anytime.", null);
    }

    /**
     * Shows the custom download card and waits for the visitor's
     * choice, resolving true (Download) or false (Not now). Used by
     * getWebLLMEngine in place of the plain browser confirm() box.
     */
    requestDownloadConsent() {
        return this.showModal({
            title: "Download the AI",
            message: "Answers questions using a small AI model saved on your device. About 400MB, downloaded once. Stay on this page while it downloads.",
            confirmText: "Download",
            cancelText: "Not now"
        });
    }

    /**
     * A custom modal used in place of the browser's own confirm() or
     * prompt() boxes everywhere in the assistant, so every dialog
     * matches the rest of the site instead of looking like a
     * default browser popup. Resolves true on confirm, false on
     * cancel (or once "Done" is pressed for an info-only message,
     * since there's nothing to cancel in that case).
     *
     * options:
     *   title, message: shown in the card
     *   confirmText: label for the primary button
     *   cancelText: label for the secondary button, or omit for a
     *     single-button informational dialog
     *   danger: styles the primary button as a destructive action
     *   textareaContent: shows a read only, selectable text block
     *     under the message, for content meant to be copied by hand
     */
    showModal(options) {
        const { title, message, confirmText = "OK", cancelText = null, danger = false, textareaContent = null } = options;

        this.modalTitleEl.textContent = title;
        this.modalMessageEl.textContent = message;
        this.modalConfirmButton.textContent = confirmText;
        this.modalConfirmButton.classList.toggle("lr-modal-btn-danger", danger);

        if (cancelText) {
            this.modalCancelButton.textContent = cancelText;
            this.modalCancelButton.hidden = false;
        } else {
            this.modalCancelButton.hidden = true;
        }

        if (textareaContent) {
            this.modalTextareaEl.value = textareaContent;
            this.modalTextareaEl.hidden = false;
        } else {
            this.modalTextareaEl.hidden = true;
        }

        return new Promise(resolve => {
            this._modalResolve = resolve;
            this.modal.classList.add("open");
        });
    }

    /**
     * While the AI hasn't been downloaded (or the visitor hasn't
     * explicitly declined it) yet this visit, the text box is
     * read only and tapping it brings the download prompt back up,
     * rather than letting people type into a box that might not do
     * anything yet.
     */
    updateInputLock(locked, mode, percent) {
        this.aiInputLocked = locked;
        this.input.readOnly = locked;
        this.sendButton.disabled = locked;

        if (locked && mode === "downloading") {
            const pct = typeof percent === "number" ? Math.round(percent * 100) : null;
            this.input.placeholder = pct === null ? "Downloading AI" : `Downloading AI ${pct}%`;
            this.downloadBar.hidden = false;
            this.downloadBarFill.style.width = `${pct === null ? 0 : pct}%`;
        } else if (locked) {
            this.input.placeholder = "Download AI";
            this.downloadBar.hidden = true;
        } else {
            this.input.placeholder = "Ask about the archive";
            this.downloadBar.hidden = true;
        }
    }

    /**
     * Settings takes over the entire window — chat and the input bar
     * are hidden while it's open (see .settings-open in the CSS) —
     * so there's no ambiguity about being "in settings" vs "in chat."
     * The only way out is the explicit Back button; closing the
     * whole assistant still needs the × in the header.
     */
    openSettings() {
        this.settingsPanel.classList.add("open");
        this.window.classList.add("settings-open");
        this.refreshEngineStatus();
    }

    closeSettings() {
        this.settingsPanel.classList.remove("open");
        this.window.classList.remove("settings-open");
    }

    /**
     * Updates the settings-panel status line and, when fraction is a
     * number, shows a real progress bar too — so a download in
     * progress is visibly moving, not just a wall of text that might
     * as well be frozen.
     */
    setEngineStatus(text, fraction) {
        this.engineStatusTextEl.textContent = text;
        if (typeof fraction === "number") {
            this.progressTrackEl.style.display = "block";
            this.progressFillEl.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
        } else {
            this.progressTrackEl.style.display = "none";
        }
    }

    /**
     * A full local reset: wipes the saved conversation, the memory and
     * download-consent preferences, and — best effort — any cached
     * on-device model data this browser stored. This can't reach into
     * the browser's own disk cache with full certainty (that part
     * depends on what the browser exposes to a webpage), so it also
     * points people at clearing site data manually for a guaranteed
     * clean slate.
     */
    /**
     * "Uninstall" the AI model specifically — not the conversation.
     * Erasing history is its own separate button now, so this only
     * touches what's actually AI-related: the downloaded model, the
     * download consent decision, and any failure state, so the next
     * attempt starts completely fresh (effectively a "reinstall" if
     * used right before Download AI model again).
     */
    async handleUninstall() {
        const confirmed = await this.showModal({
            title: "Uninstall AI Model",
            message: "This removes the downloaded AI model and its settings from this browser, not your conversation history. You will be asked to download it again next time it is needed.",
            confirmText: "Uninstall",
            cancelText: "Cancel",
            danger: true
        });
        if (!confirmed) return;

        try {
            sessionStorage.removeItem(WEBLLM_CONSENT_KEY);
        } catch (error) {
            console.error("Lanthano Assistant: failed to clear stored preferences", error);
        }

        resetWebLLMState();
        resetFailureCounters();

        let cacheNote = "";
        if (typeof caches !== "undefined" && caches.keys) {
            try {
                const keys = await caches.keys();
                const targets = keys.filter(k => /webllm|mlc/i.test(k));
                await Promise.all(targets.map(k => caches.delete(k)));
                if (!targets.length) {
                    cacheNote = " No separately cached model data was found to remove. If a model was downloaded, your browser may still be holding it, so clearing this site's data from your browser settings will remove it for certain.";
                }
            } catch (error) {
                console.error("Lanthano Assistant: cache cleanup failed", error);
                cacheNote = " Couldn't fully clear cached model data automatically. Clearing this site's data from your browser settings will remove it for certain.";
            }
        }

        this.refreshDownloadButton();
        this.setEngineStatus("AI model uninstalled." + cacheNote, null);
    }

    getRecentExchanges() {
        if (!isMemoryEnabled()) return [];
        const conversational = this.history.filter(m => m.role === "user" || m.role === "assistant");
        return conversational.slice(-MEMORY_EXCHANGES * 2);
    }

    async handleSend() {
        if (this.isBusy) return;

        if (this.aiInputLocked) {
            this.startDownload({ force: true });
            return;
        }

        const rawText = this.input.value.trim();
        if (!rawText) return;

        this.input.value = "";
        this.isBusy = true;
        this.sendButton.disabled = true;

        const recentExchanges = this.getRecentExchanges();
        this.pushMessage({ role: "user", text: rawText });
        const typingEl = this.showTyping();

        try {
            const generate = messages => generateWithWebLLM(messages, label => {
                const el = typingEl.querySelector(".lr-typing-label");
                if (el) el.textContent = label;
            });

            const result = await researchAssistant.ask(rawText, {
                generate,
                history: recentExchanges
            });

            typingEl.remove();

            if (result.text === null) {
                this.pushMessage({
                    role: "assistant",
                    source: "search",
                    text: result.citations.length
                        ? "Couldn't write an answer just now. Here's what's in the archive."
                        : "Couldn't write an answer, and nothing matches in the archive. Try different words.",
                    citations: result.citations
                });
                return;
            }

            this.pushMessage({ role: "assistant", source: "ai", text: result.text, citations: result.citations });

        } catch (error) {
            console.error("Lanthano Assistant: error handling message", error);
            typingEl.remove();
            this.pushMessage({
                role: "assistant",
                text: "Something went wrong answering that. Please try again in a moment."
            });
        } finally {
            this.isBusy = false;
            this.sendButton.disabled = false;
            this.input.focus();
        }
    }

    pushMessage(message) {
        const entry = { ...message, time: Date.now() };
        this.history.push(entry);
        saveHistory(this.history);
        this.renderMessage(entry);
    }

    renderHistory() {
        this.messages.innerHTML = "";
        this.history.forEach(entry => this.renderMessage(entry));
    }

    renderMessage(entry) {
        const wrap = document.createElement("div");
        const roleClass = entry.role === "user" ? "user" : entry.role === "notice" ? "notice" : "ai";
        wrap.className = `lr-msg lr-msg-${roleClass}`;

        // A visible label on the assistant's own replies, so it's
        // never ambiguous whether the AI actually generated this or
        // it's a canned/search-results message standing in for it.
        if (entry.role === "assistant" && entry.source) {
            const badge = document.createElement("div");
            badge.className = `lr-msg-source lr-msg-source-${entry.source}`;
            badge.textContent = entry.source === "ai" ? "AI-generated answer" : "Archive search results";
            wrap.appendChild(badge);
        }

        const bubble = document.createElement("div");
        bubble.className = "lr-msg-bubble";
        bubble.textContent = entry.text;
        wrap.appendChild(bubble);

        if (entry.citations && entry.citations.length) {
            const citeWrap = document.createElement("div");
            citeWrap.className = "lr-citations";
            citeWrap.innerHTML = entry.citations.map(c => `
                <a class="lr-citation" href="${escapeHTML(c.href)}" target="_blank" rel="noopener">
                    <span class="lr-citation-icon">${c.type === "image" ? "🖼️" : c.type === "page" ? "🌐" : "📄"}</span>
                    <span class="lr-citation-text">
                        <span class="lr-citation-title">${escapeHTML(c.title)}</span>
                        ${c.subtitle ? `<span class="lr-citation-subtitle">${escapeHTML(c.subtitle)}</span>` : ""}
                    </span>
                    ${c.warning ? `<span class="lr-citation-warning" title="Graphic content">⚠️</span>` : ""}
                </a>
            `).join("");
            wrap.appendChild(citeWrap);
        }

        this.messages.appendChild(wrap);
        this.messages.scrollTop = this.messages.scrollHeight;
    }

    showTyping() {
        const wrap = document.createElement("div");
        wrap.className = "lr-msg lr-msg-ai lr-typing";
        wrap.innerHTML = `
            <div class="lr-msg-bubble">
                <span class="lr-typing-label">Thinking…</span>
                <span class="lr-typing-dots"><i></i><i></i><i></i></span>
            </div>
        `;
        this.messages.appendChild(wrap);
        this.messages.scrollTop = this.messages.scrollHeight;
        return wrap;
    }

    open() {
        if (this.isOpen) return;

        document.getElementById("lr-ai-button").style.opacity = "0";
        document.getElementById("lr-ai-button").style.pointerEvents = "none";

        this.window.classList.add("open");
        this.isOpen = true;

        this.lockBodyScroll();

        // Default to locked-and-checking rather than briefly unlocked
        // while the real capability check (below) runs, so there's no
        // flash of "you can type" that immediately gets taken away.
        if (!webllmReady) {
            this.updateInputLock(true, "waiting");
        }
        this.maybeOfferDownload();

        requestAnimationFrame(() => {
            if (!this.aiInputLocked) this.input.focus();
        });
    }

    /**
     * Offers to download the AI model as soon as the assistant is
     * opened, not just the first time it's asked a question, and
     * keeps offering on every open until it's actually downloaded.
     * This deliberately overrides a prior decline for this specific
     * flow, so opening the assistant is a standing invitation rather
     * than a one time ask that's easy to accidentally dismiss. The
     * text box stays locked until this resolves one way or another —
     * unless this device genuinely can't run the model at all, in
     * which case it unlocks immediately instead of pretending there's
     * something to wait for.
     */
    async maybeOfferDownload() {
        if (webllmDownloading) {
            this.updateInputLock(true, "downloading");
            return;
        }
        if (webllmReady) {
            this.updateInputLock(false);
            return;
        }

        if (!(await isWebGPUActuallyCapable())) {
            this.updateInputLock(false);
            return;
        }

        this.updateInputLock(true, "waiting");
        this.startDownload({ force: true });
    }

    close() {
        if (!this.isOpen) return;

        document.getElementById("lr-ai-button").style.opacity = "";
        document.getElementById("lr-ai-button").style.pointerEvents = "";

        this.window.classList.remove("open");
        this.isOpen = false;

        this.unlockBodyScroll();

        // Reset back to the chat view for next time, rather than
        // reopening straight into Settings.
        this.closeSettings();
    }

    isMobileViewport() {
        return typeof window !== "undefined" &&
            window.matchMedia &&
            window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`).matches;
    }

    /**
     * On mobile the panel is a full-screen takeover, so the page
     * behind it shouldn't scroll or otherwise be interactive until
     * it's closed — the visitor has to explicitly close it first.
     * Plain `overflow: hidden` on the body isn't fully reliable on
     * iOS Safari (rubber-band scrolling can still leak through), so
     * this also pins the body in place with a fixed position and
     * restores the exact scroll offset on close. Desktop/tablet,
     * where this sits as a side panel instead, is left alone —
     * the background stays fully usable there, matching a normal
     * docked panel rather than a modal takeover.
     */
    lockBodyScroll() {
        if (!this.isMobileViewport()) return;

        this._lockedScrollY = window.scrollY || window.pageYOffset || 0;
        document.body.classList.add("lr-ai-body-locked");
        document.body.style.position = "fixed";
        document.body.style.top = `-${this._lockedScrollY}px`;
        document.body.style.left = "0";
        document.body.style.right = "0";
        document.body.style.width = "100%";
    }

    unlockBodyScroll() {
        if (!document.body.classList.contains("lr-ai-body-locked")) return;

        document.body.classList.remove("lr-ai-body-locked");
        document.body.style.position = "";
        document.body.style.top = "";
        document.body.style.left = "";
        document.body.style.right = "";
        document.body.style.width = "";
        window.scrollTo(0, this._lockedScrollY || 0);
    }

    toggle() {
        this.isOpen ? this.close() : this.open();
    }
}

window.AssistantWindowClass = AssistantWindow;
