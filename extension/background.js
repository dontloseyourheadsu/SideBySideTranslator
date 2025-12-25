import { pipeline, env } from "./lib/transformers.min.js";
import Tesseract from "./lib/tesseract.esm.min.js";

const browserAPI = self.browser || self.chrome;

// Configuration
env.allowLocalModels = false;
env.useBrowserCache = true; // IMPORTANT: Caches model after first download
// Configure local paths for ONNX Runtime Web
env.backends.onnx.wasm.wasmPaths = browserAPI.runtime.getURL("lib/");

let translator = null;
let translatorPromise = null;
let tesseractWorker = null;
let currentTesseractLang = null;

const tesseractLangMap = {
  en: "eng",
  es: "spa",
  fr: "fra",
  it: "ita",
  ja: "jpn",
  de: "deu",
  pt: "por",
  ru: "rus",
  zh: "chi_sim",
};

// Initialize Tesseract (OCR)
async function initOCR(langCode) {
  const tessLang = tesseractLangMap[langCode] || "eng";
  console.log(`Initializing OCR for language: ${langCode} -> ${tessLang}`);

  // If language changed, terminate old worker to re-initialize with new language
  if (tesseractWorker && currentTesseractLang !== tessLang) {
    console.log("Language changed, terminating old worker...");
    await tesseractWorker.terminate();
    tesseractWorker = null;
  }

  if (!tesseractWorker) {
    console.log(`Creating new Tesseract worker for ${tessLang}...`);
    try {
      // Preflight: these must exist in the extension bundle
      const workerUrl = browserAPI.runtime.getURL("lib/worker.min.js");
      const coreUrl = browserAPI.runtime.getURL("lib/tesseract-core.wasm.js");
      const preflight = await Promise.allSettled([
        fetch(workerUrl).then((r) => ({
          url: workerUrl,
          ok: r.ok,
          status: r.status,
        })),
        fetch(coreUrl).then((r) => ({
          url: coreUrl,
          ok: r.ok,
          status: r.status,
        })),
      ]);
      console.log("Tesseract preflight:", preflight);

      // Tesseract.js v5+ syntax: createWorker(lang, oem, options)
      tesseractWorker = await Tesseract.createWorker(tessLang, 1, {
        workerPath: workerUrl,
        corePath: coreUrl,
        // Firefox MV3 CSP can block blob: workers; force using workerPath instead.
        workerBlobURL: false,
        logger: (m) => console.log("Tesseract:", m),
        errorHandler: (err) => console.error("Tesseract Worker Error:", err),
      });
      currentTesseractLang = tessLang;
    } catch (err) {
      console.error("Failed to create Tesseract worker:", err);
      const detail =
        err && typeof err === "object"
          ? err.message || JSON.stringify(err)
          : String(err || "Unknown error");
      throw new Error(`Tesseract initialization failed: ${detail}`);
    }
  }

  return tesseractWorker;
}

// Initialize Translator (Only loads when needed)
async function getTranslator(progressCallback) {
  if (translator) {
    console.log("Translator already loaded.");
    return translator;
  }

  if (!translatorPromise) {
    console.log("Loading Model...");
    translatorPromise = (async () => {
      try {
        console.log("Initializing pipeline...");
        const t = await pipeline(
          "translation",
          "Xenova/nllb-200-distilled-600M",
          {
            progress_callback: (data) => {
              console.log("Pipeline progress:", data);
              if (progressCallback) progressCallback(data);
            },
          }
        );
        console.log("Pipeline initialized successfully.");
        translator = t;
        // Mark as downloaded in storage
        await browserAPI.storage.local.set({ model_downloaded: true });
        return t;
      } catch (e) {
        console.error("Failed to load model:", e);
        translatorPromise = null; // Reset on failure
        throw e;
      }
    })();
  }
  return translatorPromise;
}

// Language Mapping (Tesseract Code -> NLLB Code)
const langMap = {
  eng: "eng_Latn",
  fra: "fra_Latn",
  ita: "ita_Latn",
  spa: "spa_Latn",
  jpn: "jpn_Jpan",
};

// Language Mapping (UI Code -> NLLB Code)
// Popup/content send UI codes like "ja", "en", etc.
const uiLangToNllb = {
  en: "eng_Latn",
  fr: "fra_Latn",
  it: "ita_Latn",
  es: "spa_Latn",
  ja: "jpn_Jpan",
};

function toNllbLang(code) {
  if (!code || code === "auto") return null;
  if (uiLangToNllb[code]) return uiLangToNllb[code];

  // Allow callers to pass Tesseract codes directly.
  if (langMap[code]) return langMap[code];

  // Best-effort: UI code -> Tesseract code -> NLLB
  const tess = tesseractLangMap[code];
  if (tess && langMap[tess]) return langMap[tess];

  return null;
}

function parseTsvToLineBlocks(tsv, joiner = " ") {
  if (!tsv || typeof tsv !== "string") return [];

  const rows = tsv.split(/\r?\n/).filter(Boolean);
  if (rows.length < 2) return [];

  const header = rows[0].split("\t");
  const idx = (name) => header.indexOf(name);

  const levelIdx = idx("level");
  const pageIdx = idx("page_num");
  const blockIdx = idx("block_num");
  const parIdx = idx("par_num");
  const lineIdx = idx("line_num");
  const wordIdx = idx("word_num");
  const leftIdx = idx("left");
  const topIdx = idx("top");
  const widthIdx = idx("width");
  const heightIdx = idx("height");
  const confIdx = idx("conf");
  const textIdx = idx("text");

  if (
    [
      levelIdx,
      pageIdx,
      blockIdx,
      parIdx,
      lineIdx,
      wordIdx,
      leftIdx,
      topIdx,
      widthIdx,
      heightIdx,
      confIdx,
      textIdx,
    ].some((v) => v === -1)
  ) {
    return [];
  }

  const groups = new Map();

  for (let i = 1; i < rows.length; i++) {
    const cols = rows[i].split("\t");
    if (cols.length <= textIdx) continue;

    const level = Number(cols[levelIdx]);
    const wordNum = Number(cols[wordIdx]);

    // Prefer word-level rows (level 5) so we can rebuild line text.
    if (level !== 5 || !Number.isFinite(wordNum) || wordNum <= 0) continue;

    const conf = Number(cols[confIdx]);
    if (!Number.isFinite(conf) || conf < 0) continue;

    const text = (cols[textIdx] || "").trim();
    if (!text) continue;

    const left = Number(cols[leftIdx]);
    const top = Number(cols[topIdx]);
    const width = Number(cols[widthIdx]);
    const height = Number(cols[heightIdx]);
    if (
      ![left, top, width, height].every((n) => Number.isFinite(n)) ||
      width <= 0 ||
      height <= 0
    ) {
      continue;
    }

    const key = `${cols[pageIdx]}-${cols[blockIdx]}-${cols[parIdx]}-${cols[lineIdx]}`;
    const x0 = left;
    const y0 = top;
    const x1 = left + width;
    const y1 = top + height;

    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        parts: [text],
        confs: [conf],
        bbox: { x0, y0, x1, y1 },
      });
      continue;
    }

    existing.parts.push(text);
    existing.confs.push(conf);
    existing.bbox.x0 = Math.min(existing.bbox.x0, x0);
    existing.bbox.y0 = Math.min(existing.bbox.y0, y0);
    existing.bbox.x1 = Math.max(existing.bbox.x1, x1);
    existing.bbox.y1 = Math.max(existing.bbox.y1, y1);
  }

  const blocks = [];
  for (const v of groups.values()) {
    const text = v.parts.join(joiner).trim();
    if (!text) continue;

    const confidence =
      v.confs.reduce((sum, c) => sum + c, 0) / (v.confs.length || 1);

    blocks.push({ text, confidence, bbox: v.bbox });
  }

  // Keep reading order roughly top-to-bottom, then left-to-right.
  blocks.sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);
  return blocks;
}

browserAPI.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log("Background received message:", msg);

  if (msg.type === "PROCESS_IMAGE") {
    console.log("Processing image request received for:", msg.src);

    const pipelinePromise = handleImagePipeline(msg, sender.tab.id)
      .then((result) => {
        console.log("Image pipeline completed successfully for:", msg.src);
        return result;
      })
      .catch((e) => {
        console.error("Pipeline failed for:", msg.src, e);
        const errorMessage = e ? e.message || String(e) : "Unknown error";
        return { success: false, error: errorMessage };
      });

    // Firefox supports returning a Promise directly
    if (typeof browser !== "undefined" && browser.runtime) {
      return pipelinePromise;
    }

    // Chrome requires returning true and calling sendResponse
    pipelinePromise.then(sendResponse);
    return true;
  }

  if (msg.type === "CHECK_MODEL_STATUS") {
    checkModelStatus().then((status) => {
      console.log("Model status:", status);
      sendResponse(status);
    });
    return true;
  }

  if (msg.type === "DOWNLOAD_MODEL") {
    console.log("Starting model download...");
    downloadModel();
    return true; // Async response not needed as we send messages back
  }
});

async function checkModelStatus() {
  if (translator) return { status: "READY" };

  // Check if previously downloaded
  const stored = await browserAPI.storage.local.get("model_downloaded");
  if (stored.model_downloaded) {
    // Try to load silently
    getTranslator().catch(console.error);
    return { status: "LOADING" };
  }

  return { status: "NOT_LOADED" };
}

async function downloadModel() {
  try {
    await getTranslator((data) => {
      // Forward progress to popup
      browserAPI.runtime
        .sendMessage({
          type: "DOWNLOAD_PROGRESS",
          status: data.status,
          progress: data.progress,
          file: data.file,
        })
        .catch(() => {}); // Ignore errors if popup closed
    });

    browserAPI.runtime.sendMessage({
      type: "DOWNLOAD_PROGRESS",
      status: "done",
    });
  } catch (e) {
    console.error("Download failed", e);
    browserAPI.runtime.sendMessage({
      type: "DOWNLOAD_PROGRESS",
      status: "error",
      error: e.message,
    });
  }
}

// Helper to fetch image with Referer spoofing using webRequest (Firefox reliable method)
async function fetchImageWithReferrer(url, referrer) {
  // If no referrer needed, just fetch
  if (!referrer) return (await fetch(url)).blob();

  const onBeforeSendHeaders = (details) => {
    // Relaxed matching: Check if it's the same URL or if it contains the filename (to handle minor encoding diffs)
    if (details.url !== url && !details.url.includes(new URL(url).pathname))
      return;

    console.log(`[WebRequest] Intercepted Request: ${details.url}`);
    const headers = details.requestHeaders || [];
    // Remove existing Referer
    const newHeaders = headers.filter(
      (h) => h.name.toLowerCase() !== "referer"
    );
    // Add new Referer
    newHeaders.push({ name: "Referer", value: referrer });
    console.log(`[WebRequest] Set Referer to: ${referrer}`);
    return { requestHeaders: newHeaders };
  };

  const onHeadersReceived = (details) => {
    if (details.url !== url && !details.url.includes(new URL(url).pathname))
      return;

    console.log(`[WebRequest] Intercepted Response: ${details.url}`);
    const headers = details.responseHeaders || [];
    // Add CORS headers to allow the fetch to succeed
    headers.push({ name: "Access-Control-Allow-Origin", value: "*" });
    console.log(`[WebRequest] Injected Access-Control-Allow-Origin: *`);
    return { responseHeaders: headers };
  };

  // Add listeners
  // Note: "extraHeaders" is needed in Chrome for some headers, but harmless in Firefox
  browserAPI.webRequest.onBeforeSendHeaders.addListener(
    onBeforeSendHeaders,
    { urls: ["<all_urls>"] },
    ["blocking", "requestHeaders"]
  );
  browserAPI.webRequest.onHeadersReceived.addListener(
    onHeadersReceived,
    { urls: ["<all_urls>"] },
    ["blocking", "responseHeaders"]
  );

  try {
    const response = await fetch(url, { cache: "no-cache" });
    if (!response.ok) {
      throw new Error(`Failed to fetch: ${response.status}`);
    }
    return await response.blob();
  } finally {
    // Clean up listeners immediately
    browserAPI.webRequest.onBeforeSendHeaders.removeListener(
      onBeforeSendHeaders
    );
    browserAPI.webRequest.onHeadersReceived.removeListener(onHeadersReceived);
  }
}

// Fallback: ask the content script (in the page context) to fetch the image and return its bytes
async function fetchImageViaContent(tabId, url) {
  console.log("Falling back to content-script fetch for:", url);
  const response = await browserAPI.tabs.sendMessage(tabId, {
    type: "FETCH_IMAGE",
    url,
  });

  if (!response || !response.ok || !response.buffer) {
    const msg = response?.error || "Unknown content fetch error";
    throw new Error(msg);
  }

  return new Blob([new Uint8Array(response.buffer)]);
}

async function handleImagePipeline(msg, tabId) {
  console.log("Starting image pipeline for:", msg.src);
  let currentStep = "Initializing";
  try {
    // Ensure translator is loaded (will load from cache if available)
    currentStep = "Loading Translator";
    const translatorPipe = await getTranslator();
    console.log("Translator ready.");

    // 1. Fetch Image
    currentStep = "Fetching Image";
    console.log("Fetching image:", msg.src);

    let blob;
    try {
      blob = await fetchImageWithReferrer(msg.src, msg.pageUrl);
    } catch (e) {
      console.warn("Fetch with referrer failed, trying direct fetch:", e);
      try {
        const response = await fetch(msg.src, { cache: "no-cache" });
        if (!response.ok) {
          throw new Error(
            `Failed to fetch image: ${response.status} ${response.statusText}`
          );
        }
        blob = await response.blob();
      } catch (directErr) {
        console.warn(
          "Direct fetch failed, using content-script fallback:",
          directErr
        );
        blob = await fetchImageViaContent(tabId, msg.src);
      }
    }

    console.log("Image fetched, size:", blob.size);

    currentStep = "Creating Bitmap";
    const bitmap = await createImageBitmap(blob);
    console.log("Bitmap created:", bitmap.width, "x", bitmap.height);

    // 2. OCR (Get Text + Bounding Box)
    currentStep = "Initializing OCR";
    console.log("Starting OCR...");
    const worker = await initOCR(msg.sourceLang);
    console.log("OCR Worker initialized");

    currentStep = "Running OCR";
    // Use 'lines' for better context than 'words'
    const { data } = await worker.recognize(
      blob,
      {},
      {
        text: true,
        tsv: true,
        blocks: true,
        paragraphs: true,
        lines: true,
        words: true,
      }
    );
    console.log("OCR result keys:", Object.keys(data || {}));
    console.log(
      "OCR Complete. Found text length:",
      data?.text ? data.text.length : 0
    );

    // 3. Translation
    currentStep = "Translating";
    const translateParams = {
      src_lang: toNllbLang(msg.sourceLang) || "eng_Latn", // Defaults if 'auto'
      tgt_lang: toNllbLang(msg.targetLang) || "eng_Latn",
    };
    console.log("Translating with params:", translateParams);

    // 4. Prepare Data for Overlay (No Canvas Drawing)
    const translatedBlocks = [];

    const MIN_CONFIDENCE = 30;

    // Prefer line/word outputs, but fall back to TSV (reliable bboxes)
    let ocrBlocks =
      (Array.isArray(data?.lines) && data.lines.length ? data.lines : null) ||
      (Array.isArray(data?.words) && data.words.length ? data.words : null) ||
      (Array.isArray(data?.blocks) && data.blocks.length ? data.blocks : null);

    if (!ocrBlocks) {
      const joiner = msg.sourceLang === "ja" ? "" : " ";
      ocrBlocks = parseTsvToLineBlocks(data?.tsv, joiner);
    }

    if (!ocrBlocks || !ocrBlocks[Symbol.iterator]) {
      throw new Error(
        "OCR returned no usable blocks (lines/words/blocks empty, and TSV parse produced none)."
      );
    }

    console.log(
      "OCR blocks extracted:",
      Array.isArray(ocrBlocks) ? ocrBlocks.length : "(iterable)"
    );
    if (Array.isArray(ocrBlocks) && ocrBlocks.length) {
      const preview = ocrBlocks.slice(0, 5).map((b) => ({
        text: (typeof b?.text === "string" ? b.text : "").slice(0, 60),
        confidence:
          typeof b?.confidence === "number"
            ? b.confidence
            : typeof b?.conf === "number"
            ? b.conf
            : undefined,
        bbox: b?.bbox,
      }));
      console.log("OCR preview (first 5):", preview);
    }

    let skippedLowConfidence = 0;
    let skippedNoText = 0;
    let skippedNoBbox = 0;
    let translatedLogged = 0;

    for (const block of ocrBlocks) {
      const confidence =
        typeof block?.confidence === "number"
          ? block.confidence
          : typeof block?.conf === "number"
          ? block.conf
          : 0;

      if (confidence < MIN_CONFIDENCE) {
        skippedLowConfidence++;
        continue;
      }

      const rawText = typeof block?.text === "string" ? block.text : "";
      const text = rawText.trim();
      if (!text) {
        skippedNoText++;
        continue;
      }

      const bbox =
        block?.bbox &&
        typeof block.bbox.x0 === "number" &&
        typeof block.bbox.y0 === "number" &&
        typeof block.bbox.x1 === "number" &&
        typeof block.bbox.y1 === "number"
          ? block.bbox
          : null;

      if (!bbox) continue;
      if (!bbox) {
        skippedNoBbox++;
        continue;
      }

      // Translate the line
      const out = await translatorPipe(text, translateParams);
      const translatedText = out[0].translation_text;

      if (translatedLogged < 10) {
        console.log("Translation:", {
          original: text,
          translated: translatedText,
        });
        translatedLogged++;
      }

      translatedBlocks.push({
        text: translatedText,
        original: text,
        bbox, // {x0, y0, x1, y1}
      });
    }

    console.log(
      `Processed ${translatedBlocks.length} text blocks. Skipped: lowConf=${skippedLowConfidence}, noText=${skippedNoText}, noBbox=${skippedNoBbox}`
    );

    // 5. Return Data Result
    return {
      success: true,
      originalSrc: msg.src,
      blocks: translatedBlocks,
      imgWidth: bitmap.width,
      imgHeight: bitmap.height,
    };
  } catch (e) {
    console.error(`Pipeline failed at step '${currentStep}':`, e);
    // Ensure we propagate a useful error message
    const errDetail = e instanceof Error ? e.message : JSON.stringify(e);
    throw new Error(`[${currentStep}] ${errDetail || "Unknown error"}`);
  }
}
