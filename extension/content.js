// Polyfill for Chrome
if (typeof browser === "undefined") {
  var browser = chrome;
}

// Check if we should auto-run on load
const domain = window.location.hostname;
browser.storage.local.get(domain).then((stored) => {
  if (stored[domain] && stored[domain].auto) {
    console.log("Auto-translating images for this domain...");
    scanAndTranslate(stored[domain]);
  }
});

// Listen for manual trigger from Popup
browser.runtime.onMessage.addListener((request) => {
  console.log("Content script received message:", request);
  if (request.action === "START_SCAN") {
    scanAndTranslate(request.settings);
  }
  if (request.type === "FETCH_IMAGE") {
    return (async () => {
      try {
        const resp = await fetch(request.url, { cache: "no-cache" });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const buffer = await resp.arrayBuffer();
        return { ok: true, buffer };
      } catch (err) {
        console.error("Content fetch failed:", err);
        return { ok: false, error: err.message || String(err) };
      }
    })();
  }
});

// Queue system to limit concurrency
const imageQueue = [];
let activeProcessors = 0;
const MAX_CONCURRENT = 1; // Process 1 image at a time to save resources

function processQueue() {
  if (activeProcessors >= MAX_CONCURRENT || imageQueue.length === 0) return;

  activeProcessors++;
  const { img, settings, wrapper, overlay } = imageQueue.shift();

  console.log("Processing image from queue:", img.src);

  sendMessageWithRetry({
    type: "PROCESS_IMAGE",
    src: img.src,
    pageUrl: window.location.href, // Send page URL for Referer spoofing
    sourceLang: settings.source,
    targetLang: settings.target,
  })
    .then((response) => {
      console.log("Background response for", img.src, ":", response);
      if (response && response.success && Array.isArray(response.blocks)) {
        if (response.blocks.length === 0) {
          console.warn(
            "No translated blocks returned (OCR likely filtered everything or produced no bboxes):",
            img.src
          );
          throw new Error("No text blocks found");
        }

        console.log(
          "Translations (first 10):",
          response.blocks.slice(0, 10).map((b) => ({
            original: b.original,
            translated: b.text,
          }))
        );

        overlayTranslations(
          img,
          response.blocks,
          response.imgWidth,
          response.imgHeight
        );
        img.dataset.status = "done";
        overlay.remove(); // Remove the "Queued" overlay
      } else {
        console.error(
          "Background reported error or missing data:",
          response?.error
        );
        throw new Error(response?.error || "Unknown error");
      }
    })
    .catch((err) => {
      console.error("Failed to process image:", img.src, err);
      img.dataset.status = ""; // Reset on failure
      overlay.remove();
      // Unwrap
      if (img.parentElement === wrapper) {
        wrapper.parentNode.insertBefore(img, wrapper);
        wrapper.remove();
      }
    })
    .finally(() => {
      activeProcessors--;
      processQueue(); // Process next item
    });
}

function overlayTranslations(img, blocks, originalWidth, originalHeight) {
  // Ensure the wrapper is positioned correctly
  const wrapper = img.parentElement;

  // Calculate scaling factors (displayed size vs natural size)
  const scaleX = img.width / originalWidth;
  const scaleY = img.height / originalHeight;

  blocks.forEach((block) => {
    const { x0, y0, x1, y1 } = block.bbox;

    const div = document.createElement("div");
    div.innerText = block.text;
    div.title = block.original; // Tooltip shows original text

    // Style the overlay box
    div.style.position = "absolute";
    div.style.left = `${x0 * scaleX}px`;
    div.style.top = `${y0 * scaleY}px`;
    div.style.width = `${(x1 - x0) * scaleX}px`;
    div.style.height = `${(y1 - y0) * scaleY}px`;

    div.style.backgroundColor = "rgba(255, 255, 255, 0.9)";
    div.style.color = "black";
    div.style.fontSize = `${(y1 - y0) * scaleY * 0.8}px`; // 80% of height
    div.style.lineHeight = "1";
    div.style.display = "flex";
    div.style.alignItems = "center";
    div.style.justifyContent = "center";
    div.style.overflow = "hidden";
    div.style.whiteSpace = "nowrap";
    div.style.fontFamily = "Arial, sans-serif";
    div.style.zIndex = "900";
    div.style.pointerEvents = "auto"; // Allow hovering for tooltip
    div.style.cursor = "help";

    wrapper.appendChild(div);
  });

  img.style.border = "3px solid #4CAF50"; // Green border = Success
}

function scanAndTranslate(settings) {
  console.log("scanAndTranslate called with settings:", settings);
  const images = document.querySelectorAll("img");
  console.log(`Found ${images.length} images.`);

  images.forEach((img) => {
    if (img.width < 50 || img.height < 50 || img.dataset.status) return; // Skip small/processed

    console.log("Queueing image:", img.src);
    img.dataset.status = "queued";

    // Add visual indicator
    const wrapper = document.createElement("div");
    wrapper.style.position = "relative";
    wrapper.style.display = "inline-block";
    img.parentNode.insertBefore(wrapper, img);
    wrapper.appendChild(img);

    const overlay = document.createElement("div");
    overlay.innerText = "Queued...";
    overlay.style.position = "absolute";
    overlay.style.top = "0";
    overlay.style.left = "0";
    overlay.style.background = "rgba(0,0,0,0.7)";
    overlay.style.padding = "5px";
    overlay.style.fontSize = "12px";
    overlay.style.borderRadius = "0 0 5px 0";
    overlay.style.zIndex = "1000";
    wrapper.appendChild(overlay);

    imageQueue.push({ img, settings, wrapper, overlay });
  });

  processQueue();
}

async function sendMessageWithRetry(msg, retries = 5, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await browser.runtime.sendMessage(msg);
    } catch (err) {
      if (i === retries - 1) throw err;
      // Wait before retrying
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
