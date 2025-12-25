const browserAPI = window.browser || window.chrome;

document.addEventListener("DOMContentLoaded", async () => {
  // Default to Japanese -> English if not set
  const sourceSelect = document.getElementById("sourceLang");
  const targetSelect = document.getElementById("targetLang");

  // Set defaults
  sourceSelect.value = "ja";
  targetSelect.value = "en";

  const [tab] = await browserAPI.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (!tab) return;

  const url = new URL(tab.url);
  const domain = url.hostname;

  // Load saved settings for this domain
  const stored = await browserAPI.storage.local.get(domain);
  if (stored[domain]) {
    sourceSelect.value = stored[domain].source || "ja";
    targetSelect.value = stored[domain].target || "en";
    document.getElementById("autoTranslate").checked = stored[domain].auto;
  }

  // Save settings when changed
  function saveSettings() {
    const settings = {
      source: sourceSelect.value,
      target: targetSelect.value,
      auto: document.getElementById("autoTranslate").checked,
    };
    browserAPI.storage.local.set({ [domain]: settings });
    return settings;
  }

  const runBtn = document.getElementById("runBtn");
  const downloadUI = document.getElementById("download-ui");
  const confirmDownloadBtn = document.getElementById("confirmDownloadBtn");
  const progressContainer = document.getElementById("progressContainer");
  const downloadProgress = document.getElementById("downloadProgress");
  const progressText = document.getElementById("progressText");
  const statusDiv = document.getElementById("status");

  // Check status immediately on load
  checkModelStatusOnly();

  async function checkModelStatusOnly() {
    try {
      const response = await browserAPI.runtime.sendMessage({
        type: "CHECK_MODEL_STATUS",
      });
      console.log("Initial model status:", response);
      if (response && response.status === "READY") {
        statusDiv.innerText = "Model Ready";
        statusDiv.style.color = "green";
      } else if (response && response.status === "LOADING") {
        statusDiv.innerText = "Model Loading...";
        statusDiv.style.color = "orange";
      } else if (response && response.status === "NOT_LOADED") {
        statusDiv.innerText = "Model not loaded (Download required)";
        statusDiv.style.color = "red";
      }
    } catch (e) {
      console.error("Failed to check status:", e);
      statusDiv.innerText = "Service Worker not ready";
    }
  }

  async function checkModelAndRun() {
    console.log("checkModelAndRun called");
    runBtn.disabled = true;
    statusDiv.innerText = "Checking model status...";

    try {
      console.log("Sending CHECK_MODEL_STATUS...");
      const response = await browserAPI.runtime.sendMessage({
        type: "CHECK_MODEL_STATUS",
      });
      console.log("Model status response:", response);

      if (response && response.status === "READY") {
        startTranslation();
      } else if (response && response.status === "LOADING") {
        statusDiv.innerText = "Model loading from cache...";
        // Poll for readiness
        setTimeout(checkModelAndRun, 1000);
      } else if (response && response.status === "NOT_LOADED") {
        // Show download UI
        runBtn.style.display = "none";
        downloadUI.style.display = "block";
        statusDiv.innerText = "Model download required.";
      } else {
        statusDiv.innerText = "Error checking model status.";
        runBtn.disabled = false;
      }
    } catch (e) {
      console.error("Error in checkModelAndRun:", e);
      statusDiv.innerText = "Background service not ready.";
      runBtn.disabled = false;
    }
  }

  function startTranslation() {
    const settings = saveSettings();
    statusDiv.innerText = "Requesting translation...";
    runBtn.style.display = "block";
    runBtn.disabled = false;
    downloadUI.style.display = "none";

    // Send message to Content Script to start finding images
    browserAPI.tabs.sendMessage(tab.id, {
      action: "START_SCAN",
      settings: settings,
    });
  }

  runBtn.addEventListener("click", checkModelAndRun);

  confirmDownloadBtn.addEventListener("click", () => {
    console.log("Download confirmed. Sending DOWNLOAD_MODEL...");
    confirmDownloadBtn.style.display = "none";
    progressContainer.style.display = "block";

    browserAPI.runtime.sendMessage({ type: "DOWNLOAD_MODEL" });
  });

  // Listen for progress updates from background
  browserAPI.runtime.onMessage.addListener((msg) => {
    console.log("Popup received message:", msg);
    if (msg.type === "DOWNLOAD_PROGRESS") {
      if (msg.status === "progress") {
        const pct = Math.round(msg.progress || 0);
        downloadProgress.value = pct;
        progressText.innerText = `Downloading... ${pct}% (${msg.file || ""})`;
      } else if (msg.status === "done") {
        progressText.innerText = "Download complete!";
        setTimeout(() => {
          startTranslation();
        }, 1000);
      } else if (msg.status === "error") {
        progressText.innerText = "Error: " + msg.error;
        console.error("Download error:", msg.error);
        confirmDownloadBtn.style.display = "block";
        progressContainer.style.display = "none";
      }
    }
  });

  // Listen for changes to auto-save
  ["sourceLang", "targetLang", "autoTranslate"].forEach((id) => {
    document.getElementById(id).addEventListener("change", saveSettings);
  });

  // Reset button
  document.getElementById("resetBtn").addEventListener("click", async () => {
    if (
      confirm(
        "Are you sure you want to reset the model status? This will force a re-download next time."
      )
    ) {
      await browserAPI.storage.local.remove("model_downloaded");
      statusDiv.innerText = "Reset complete. Please reload extension.";
      setTimeout(() => window.close(), 1500);
    }
  });
});
