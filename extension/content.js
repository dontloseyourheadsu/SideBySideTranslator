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

        return replaceImageWithTranslation(
          img,
          response.blocks,
          response.imgWidth,
          response.imgHeight,
          response.base64Image
        ).then(() => {
          img.dataset.status = "done";
          overlay.remove(); // Remove the "Queued" overlay
          // Unwrap
          const wrapper = img.parentElement;
          if (wrapper && wrapper.style.position === "relative") {
            wrapper.parentNode.insertBefore(img, wrapper);
            wrapper.remove();
          }
        });
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

function replaceImageWithTranslation(
  img,
  blocks,
  originalWidth,
  originalHeight,
  base64Image
) {
  return new Promise((resolve) => {
    const canvas = document.createElement("canvas");
    canvas.width = originalWidth;
    canvas.height = originalHeight;
    const ctx = canvas.getContext("2d");

    const image = new Image();
    image.onload = () => {
      ctx.drawImage(image, 0, 0);

      blocks.forEach((block) => {
        const { x0, y0, x1, y1 } = block.bbox;
        const width = x1 - x0;
        const height = y1 - y0;

        // Draw background box
        ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
        ctx.fillRect(x0, y0, width, height);

        // Draw text
        ctx.fillStyle = "black";
        ctx.textBaseline = "middle";
        ctx.textAlign = "center";

        let fontSize;
        if (block.isVertical) {
          // For vertical text converted to horizontal (e.g. JP -> EN)
          // We use the width of the vertical column as a base for font size,
          // but ensure it's readable.
          // Since we are writing horizontally over a vertical strip, we center it.
          fontSize = Math.max(14, width * 0.6); // Heuristic
          ctx.font = `bold ${fontSize}px Arial`;

          // We don't constrain width for vertical-to-horizontal replacement
          // to allow it to overflow horizontally if needed.
          ctx.fillText(block.text, x0 + width / 2, y0 + height / 2);
        } else {
          // Horizontal text
          // Font size based on height, but clamped
          fontSize = Math.max(12, height * 0.8);
          ctx.font = `${fontSize}px Arial`;

          // Allow some overflow by not passing maxWidth, or passing a generous one
          // The user said "display it even if it overflows a little"
          // So we just draw it centered.
          ctx.fillText(block.text, x0 + width / 2, y0 + height / 2);
        }
      });

      img.src = canvas.toDataURL("image/jpeg");
      img.style.border = "3px solid #4CAF50"; // Green border = Success
      resolve();
    };
    image.src = base64Image;
  });
}

function scanAndTranslate(settings) {
  console.log("scanAndTranslate called with settings:", settings);
  const images = document.querySelectorAll("img");
  console.log(`Found ${images.length} images.`);

  images.forEach((img) => {
    if (img.width < 64 || img.height < 64 || img.dataset.status) return; // Skip small/processed

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
