import dotenv from "../node_modules/dotenv";
dotenv.config();

const OCR_SPACE_KEY = process.env.OCR_SPACE_KEY;
const DEEPL_AUTH_KEY = process.env.DEEPL_AUTH_KEY;

const browserAPI = self.browser || self.chrome;

// Language Mappings
const uiToOcrSpace = {
  en: "eng",
  fr: "fre",
  it: "ita",
  es: "spa",
  ja: "jpn",
  de: "ger",
  pt: "por",
  ru: "rus",
  zh: "chs", // Simplified
};

const uiToDeepL = {
  en: "EN",
  fr: "FR",
  it: "IT",
  es: "ES",
  ja: "JA",
  de: "DE",
  pt: "PT",
  ru: "RU",
  zh: "ZH",
};

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

    if (typeof browser !== "undefined" && browser.runtime) {
      return pipelinePromise;
    }

    pipelinePromise.then(sendResponse);
    return true;
  }
});

// Helper to fetch image with Referer spoofing
async function fetchImageWithReferrer(url, referrer) {
  if (!referrer) return (await fetch(url)).blob();

  const onBeforeSendHeaders = (details) => {
    if (details.url !== url && !details.url.includes(new URL(url).pathname))
      return;
    const headers = details.requestHeaders || [];
    const newHeaders = headers.filter(
      (h) => h.name.toLowerCase() !== "referer"
    );
    newHeaders.push({ name: "Referer", value: referrer });
    return { requestHeaders: newHeaders };
  };

  const onHeadersReceived = (details) => {
    if (details.url !== url && !details.url.includes(new URL(url).pathname))
      return;
    const headers = details.responseHeaders || [];
    headers.push({ name: "Access-Control-Allow-Origin", value: "*" });
    return { responseHeaders: headers };
  };

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
    browserAPI.webRequest.onBeforeSendHeaders.removeListener(
      onBeforeSendHeaders
    );
    browserAPI.webRequest.onHeadersReceived.removeListener(onHeadersReceived);
  }
}

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

async function compressImage(blob) {
  const MAX_SIZE = 1024 * 1024; // 1MB
  if (blob.size <= MAX_SIZE) return blob;

  console.log(`Compressing image (size: ${blob.size})...`);
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);

  let quality = 0.9;
  let compressedBlob = await canvas.convertToBlob({
    type: "image/jpeg",
    quality,
  });

  while (compressedBlob.size > MAX_SIZE && quality > 0.1) {
    quality -= 0.1;
    compressedBlob = await canvas.convertToBlob({
      type: "image/jpeg",
      quality,
    });
  }

  if (compressedBlob.size > MAX_SIZE) {
    // Resize if quality reduction isn't enough
    const scale = Math.sqrt(MAX_SIZE / compressedBlob.size);
    const newWidth = Math.floor(bitmap.width * scale);
    const newHeight = Math.floor(bitmap.height * scale);
    const resizedCanvas = new OffscreenCanvas(newWidth, newHeight);
    const resizedCtx = resizedCanvas.getContext("2d");
    resizedCtx.drawImage(bitmap, 0, 0, newWidth, newHeight);
    compressedBlob = await resizedCanvas.convertToBlob({
      type: "image/jpeg",
      quality: 0.7,
    });
  }

  console.log(`Compressed size: ${compressedBlob.size}`);
  return compressedBlob;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function callOcrApi(base64Image, language) {
  const formData = new FormData();
  formData.append("base64Image", base64Image);
  formData.append("language", uiToOcrSpace[language] || "eng");
  formData.append("isOverlayRequired", "true");
  formData.append("scale", "true");
  formData.append("OCREngine", "2");
  formData.append("detectOrientation", "true");

  const response = await fetch("https://api.ocr.space/parse/image", {
    method: "POST",
    headers: {
      apikey: OCR_SPACE_KEY,
    },
    body: formData,
  });

  const data = await response.json();
  if (data.IsErroredOnProcessing) {
    throw new Error(data.ErrorMessage?.[0] || "OCR API Error");
  }
  return data;
}

async function callDeepLApi(texts, targetLang) {
  const response = await fetch("https://api-free.deepl.com/v2/translate", {
    method: "POST",
    headers: {
      Authorization: `DeepL-Auth-Key ${DEEPL_AUTH_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: texts,
      target_lang: uiToDeepL[targetLang] || "EN",
    }),
  });

  if (!response.ok) {
    throw new Error(`DeepL API Error: ${response.status}`);
  }

  return await response.json();
}

async function handleImagePipeline(msg, tabId) {
  console.log("Starting image pipeline for:", msg.src);
  let currentStep = "Initializing";

  try {
    // 1. Fetch Image
    currentStep = "Fetching Image";
    let blob;
    try {
      blob = await fetchImageWithReferrer(msg.src, msg.pageUrl);
    } catch (e) {
      console.warn("Fetch with referrer failed, trying direct fetch:", e);
      try {
        const response = await fetch(msg.src, { cache: "no-cache" });
        if (!response.ok) throw new Error("Fetch failed");
        blob = await response.blob();
      } catch (directErr) {
        blob = await fetchImageViaContent(tabId, msg.src);
      }
    }

    // 2. Compress if needed
    currentStep = "Compressing Image";
    blob = await compressImage(blob);
    const base64 = await blobToBase64(blob);

    // 3. OCR
    currentStep = "Running OCR";
    const ocrResult = await callOcrApi(base64, msg.sourceLang);

    const parsedResults = ocrResult.ParsedResults?.[0];
    if (!parsedResults || !parsedResults.TextOverlay) {
      console.log("No text found in image.");
      return { success: true, blocks: [], imgWidth: 0, imgHeight: 0 };
    }

    const lines = parsedResults.TextOverlay.Lines;
    const blocks = [];

    for (const line of lines) {
      const words = line.Words;
      if (!words || words.length === 0) continue;

      const text = line.LineText;

      // Calculate bbox for the line
      let x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity;

      for (const word of words) {
        x0 = Math.min(x0, word.Left);
        y0 = Math.min(y0, word.Top);
        x1 = Math.max(x1, word.Left + word.Width);
        y1 = Math.max(y1, word.Top + word.Height);
      }

      const width = x1 - x0;
      const height = y1 - y0;
      // Heuristic for vertical text: height is significantly larger than width
      // and source language is likely to have vertical text (ja, zh, ko)
      // But we can just check aspect ratio for now.
      const isVertical = height > width * 2;

      blocks.push({
        text,
        bbox: { x0, y0, x1, y1 },
        isVertical,
      });
    }

    if (blocks.length === 0) {
      return { success: true, blocks: [], imgWidth: 0, imgHeight: 0 };
    }

    // 4. Translate
    currentStep = "Translating";
    const textsToTranslate = blocks.map((b) => b.text);
    const translationResult = await callDeepLApi(
      textsToTranslate,
      msg.targetLang
    );

    const translations = translationResult.translations;
    if (!translations || translations.length !== blocks.length) {
      throw new Error("Translation count mismatch");
    }

    const translatedBlocks = blocks.map((block, index) => ({
      text: translations[index].text,
      original: block.text,
      bbox: block.bbox,
      isVertical: block.isVertical,
    }));

    const bitmap = await createImageBitmap(blob);

    return {
      success: true,
      originalSrc: msg.src,
      blocks: translatedBlocks,
      imgWidth: bitmap.width,
      imgHeight: bitmap.height,
      base64Image: base64,
    };
  } catch (e) {
    console.error(`Pipeline failed at step '${currentStep}':`, e);
    return { success: false, error: e.message };
  }
}
