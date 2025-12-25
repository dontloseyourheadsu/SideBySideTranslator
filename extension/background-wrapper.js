// Wrapper to load background.js as a module in Firefox
import("./background.js").catch((e) =>
  console.error("Failed to load background.js:", e)
);
