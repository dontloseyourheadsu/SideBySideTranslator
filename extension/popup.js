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
  const statusDiv = document.getElementById("status");

  function startTranslation() {
    const settings = saveSettings();
    statusDiv.innerText = "Requesting translation...";
    runBtn.disabled = false;

    // Send message to Content Script to start finding images
    browserAPI.tabs.sendMessage(tab.id, {
      action: "START_SCAN",
      settings: settings,
    });
  }

  runBtn.addEventListener("click", startTranslation);

  // Listen for changes to auto-save
  ["sourceLang", "targetLang", "autoTranslate"].forEach((id) => {
    document.getElementById(id).addEventListener("change", saveSettings);
  });
});
