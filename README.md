# SideBySideTranslator

Local-first browser extension that translates text inside images directly in the page.

## Features

- Client-side OCR with Tesseract.js and translation with NLLB-200 (no server calls).
- Overlay rendering: translated text is drawn on top of the original image, leaving the image untouched.
- Hotlink/CORS friendly fetching with background + content-script fallback.

## How it works

1. Images on the page are queued and sent to the background worker.
2. Background fetches the image (with Referer spoofing); if blocked, it requests the content script to fetch bytes directly from the page context.
3. Tesseract.js extracts lines + bounding boxes.
4. NLLB-200 translates each line.
5. The content script overlays translated text boxes scaled to the displayed image size.

## Usage

1. Load the unpacked extension (see Testing below).
2. Install dependencies in the `extension` folder: `npm install dotenv`
3. Click the popup, pick source/target languages, and start scanning.
4. Translated overlays appear on supported images.

## Troubleshooting image fetch / OCR

- Reload the extension after changes, then refresh the target page.
- If an image still shows "Unknown error", open DevTools → Console (background page) to see the pipeline step where it failed.
- The extension now automatically falls back to a content-script fetch when background fetch is blocked by CORS/hotlinking. No manual toggle needed.
- If hosts block hotlinking entirely, open the image in a new tab and retry so the Referer matches.

## Contributing

1. Fork and clone.
2. Install dependencies: `npm install`
3. Work in the `extension` folder; run lint/tests as needed.
4. Submit a PR.

## Testing

### Chrome / Chromium

1. Go to `chrome://extensions/` → enable **Developer mode**.
2. Click **Load unpacked** → choose the `extension` folder.

### Firefox

1. Go to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on...** → pick `extension/manifest.json`.
