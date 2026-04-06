/**
 * background.js — Quantbrowse AI Service Worker
 *
 * Receives the user's command and the active tab's DOM content from the
 * popup, calls the /api/browse backend, and relays the AI response back.
 *
 * The backend URL is configurable so developers can point to a local
 * Next.js server (http://localhost:3000) during development.
 */

// Default API base URL used when no override is stored in chrome.storage.
// To point the extension at a production server, call:
//   chrome.storage.local.set({ apiBaseUrl: "https://your-app.vercel.app" })
// from the browser console while the extension is loaded in developer mode.
const DEFAULT_API_BASE_URL = "http://localhost:3000";

/**
 * Resolves the current API base URL from chrome.storage (falls back to default).
 * @returns {Promise<string>}
 */
async function getApiBaseUrl() {
  return new Promise((resolve) => {
    chrome.storage.local.get("apiBaseUrl", ({ apiBaseUrl }) => {
      resolve(
        typeof apiBaseUrl === "string" && apiBaseUrl.trim()
          ? apiBaseUrl.trim()
          : DEFAULT_API_BASE_URL
      );
    });
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== "RUN_AI_COMMAND") return false;

  const { prompt } = message;

  (async () => {
    try {
      // Step 1: Get the active tab
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });

      if (!tab?.id) {
        sendResponse({ success: false, error: "No active tab found." });
        return;
      }

      // Step 2: Extract DOM content from the content script
      let domContent = "";
      try {
        const domResponse = await chrome.tabs.sendMessage(tab.id, {
          type: "EXTRACT_DOM",
        });
        if (domResponse?.success) {
          domContent = domResponse.domContent ?? "";
        } else {
          // Content script might not be injected yet — inject it manually
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ["content.js"],
          });
          const retryResponse = await chrome.tabs.sendMessage(tab.id, {
            type: "EXTRACT_DOM",
          });
          domContent = retryResponse?.domContent ?? "";
        }
      } catch {
        // If content script fails, proceed with empty domContent
        domContent = "";
      }

      // Step 3: Call the backend AI API
      const apiBaseUrl = await getApiBaseUrl();
      const response = await fetch(`${apiBaseUrl}/api/browse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, domContent }),
      });

      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        sendResponse({
          success: false,
          error: errBody?.error ?? `Server error: ${response.status}`,
        });
        return;
      }

      const data = await response.json();
      sendResponse({ success: true, result: data.result });
    } catch (err) {
      sendResponse({ success: false, error: String(err) });
    }
  })();

  // Return true to keep the message channel open for the async response
  return true;
});
