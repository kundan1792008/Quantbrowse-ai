/**
 * background.js — Quantbrowse AI Service Worker (Ambient Intelligence Edition)
 *
 * Central service worker that:
 *  1. Handles AI browse commands (original functionality)
 *  2. Wires the Usage Tracker service
 *  3. Wires the Tab Grouper service
 *  4. Wires the Daily Digest service
 *  5. Wires the Surprise Bookmark service
 *  6. Wires the Productivity Score service
 *  7. Wires the Ecosystem Redirect interceptor
 *
 * The backend URL is configurable; call:
 *   chrome.storage.local.set({ apiBaseUrl: "https://your-app.vercel.app" })
 * from the DevTools console while the extension is loaded in developer mode.
 */

import {
  initUsageTracker,
  getTodayUsage,
  getAllTimeUsage,
  getTodaySummaryMessage,
  resetDailyCounters,
  getDistractionRatio,
  flushActiveSession,
} from "./services/usage-tracker.js";

import {
  initTabGrouper,
  autoGroupAllTabs,
  collapseInactiveGroups,
  checkTabOverload,
  getTabSummary,
} from "./services/tab-grouper.js";

import {
  initDailyDigest,
  handleDigestAlarm,
  getDigestArticles,
  clearDigestArticles,
  updateDigestSettings,
  DIGEST_ALARM_NAME,
} from "./services/daily-digest.js";

import {
  initSurpriseBookmarks,
  handleSurpriseAlarm,
  getSurpriseBookmarks,
  triggerSurprise,
  updateSurpriseSettings,
  SURPRISE_ALARM_NAME,
} from "./services/surprise-bookmarks.js";

import {
  initProductivityScore,
  handleProductivityAlarm,
  incrementAiUsage,
  incrementDigestRead,
  getWeeklyScores,
  getCurrentWeekEstimate,
  PRODUCTIVITY_ALARM_NAME,
} from "./services/productivity-score.js";

import {
  handleRedirectMessage,
  getRedirectRules,
  getRedirectStats,
  setRedirectEnabled,
} from "./services/ecosystem-redirect.js";

// ─── Constants ────────────────────────────────────────────────────────────

const DEFAULT_API_BASE_URL = "http://localhost:3000";

// ─── Service initialisation ────────────────────────────────────────────────

// Each init function registers its own Chrome event listeners and alarms.
initUsageTracker();
initTabGrouper();
initDailyDigest();
initSurpriseBookmarks();
initProductivityScore();

// ─── Helpers ──────────────────────────────────────────────────────────────

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

/**
 * Attempts to retrieve the page's visible text from the content script.
 * Falls back to injecting content.js if not already present.
 *
 * @param {number} tabId
 * @returns {Promise<string>}
 */
async function getDomContent(tabId) {
  try {
    const resp = await chrome.tabs.sendMessage(tabId, { type: "EXTRACT_DOM" });
    if (resp?.success) return resp.domContent ?? "";
  } catch {
    // Content script not running — fall through to injection
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    const resp = await chrome.tabs.sendMessage(tabId, { type: "EXTRACT_DOM" });
    return resp?.domContent ?? "";
  } catch {
    return "";
  }
}

// ─── Alarm dispatcher ──────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  switch (alarm.name) {
    case DIGEST_ALARM_NAME:
      await handleDigestAlarm(alarm);
      break;

    case SURPRISE_ALARM_NAME:
      await handleSurpriseAlarm(alarm);
      break;

    case PRODUCTIVITY_ALARM_NAME:
      await handleProductivityAlarm(alarm);
      break;

    case "qba-daily-reset":
      await resetDailyCounters();
      break;

    default:
      // Unknown alarm — ignore
  }
});

// ─── Main message handler ──────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // ── Ecosystem Redirect messages (from redirect-badge.js) ───────────────
  if (
    message.type === "GET_REDIRECT_RULE" ||
    message.type === "REDIRECT_ACCEPTED" ||
    message.type === "REDIRECT_DISMISSED"
  ) {
    return handleRedirectMessage(message, sender, sendResponse);
  }

  switch (message.type) {

    // ── Original AI browse command ─────────────────────────────────────
    case "RUN_AI_COMMAND": {
      const { prompt } = message;

      if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
        sendResponse({ success: false, error: "A non-empty prompt is required." });
        return false;
      }
      if (prompt.length > 2000) {
        sendResponse({ success: false, error: "Prompt exceeds the 2,000-character limit." });
        return false;
      }

      (async () => {
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!tab?.id) {
            sendResponse({ success: false, error: "No active tab found." });
            return;
          }
          const domContent = await getDomContent(tab.id);
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
          await incrementAiUsage(); // Track AI usage for productivity score
          sendResponse({ success: true, result: data.result });
        } catch (err) {
          sendResponse({ success: false, error: String(err) });
        }
      })();
      return true; // async response
    }

    // ── Usage dashboard data ──────────────────────────────────────────
    case "GET_TODAY_USAGE": {
      getTodayUsage().then((usage) => sendResponse({ success: true, usage }));
      return true;
    }

    case "GET_ALL_TIME_USAGE": {
      getAllTimeUsage().then((usage) => sendResponse({ success: true, usage }));
      return true;
    }

    case "GET_TODAY_SUMMARY": {
      getTodaySummaryMessage().then((msg) => sendResponse({ success: true, message: msg }));
      return true;
    }

    case "GET_DISTRACTION_RATIO": {
      getDistractionRatio().then((ratio) => sendResponse({ success: true, ratio }));
      return true;
    }

    // ── Tab grouper ───────────────────────────────────────────────────
    case "AUTO_GROUP_TABS": {
      autoGroupAllTabs().then((result) => sendResponse({ success: true, ...result }));
      return true;
    }

    case "COLLAPSE_INACTIVE_GROUPS": {
      collapseInactiveGroups().then(() => sendResponse({ success: true }));
      return true;
    }

    case "CHECK_TAB_OVERLOAD": {
      checkTabOverload().then((result) => sendResponse({ success: true, ...result }));
      return true;
    }

    case "GET_TAB_SUMMARY": {
      getTabSummary().then((summary) => sendResponse({ success: true, summary }));
      return true;
    }

    // ── Daily digest ──────────────────────────────────────────────────
    case "GET_DIGEST_ARTICLES": {
      (async () => {
        const articles = await getDigestArticles();
        await incrementDigestRead(); // count as a read for productivity score
        sendResponse({ success: true, articles });
      })();
      return true;
    }

    case "CLEAR_DIGEST_ARTICLES": {
      clearDigestArticles().then(() => sendResponse({ success: true }));
      return true;
    }

    case "UPDATE_DIGEST_SETTINGS": {
      updateDigestSettings(message.settings ?? {}).then(() =>
        sendResponse({ success: true })
      );
      return true;
    }

    // ── Surprise bookmarks ────────────────────────────────────────────
    case "GET_SURPRISE_BOOKMARKS": {
      getSurpriseBookmarks().then((bookmarks) =>
        sendResponse({ success: true, bookmarks })
      );
      return true;
    }

    case "TRIGGER_SURPRISE": {
      triggerSurprise().then((shown) => sendResponse({ success: true, shown }));
      return true;
    }

    case "UPDATE_SURPRISE_SETTINGS": {
      updateSurpriseSettings(message.settings ?? {}).then(() =>
        sendResponse({ success: true })
      );
      return true;
    }

    // ── Productivity score ────────────────────────────────────────────
    case "GET_WEEKLY_SCORES": {
      getWeeklyScores().then((scores) => sendResponse({ success: true, scores }));
      return true;
    }

    case "GET_CURRENT_ESTIMATE": {
      getCurrentWeekEstimate().then((estimate) =>
        sendResponse({ success: true, ...estimate })
      );
      return true;
    }

    // ── Ecosystem redirect ────────────────────────────────────────────
    case "GET_REDIRECT_RULES": {
      sendResponse({ success: true, rules: getRedirectRules() });
      return false;
    }

    case "GET_REDIRECT_STATS": {
      getRedirectStats().then((stats) => sendResponse({ success: true, stats }));
      return true;
    }

    case "SET_REDIRECT_ENABLED": {
      setRedirectEnabled(message.enabled).then(() =>
        sendResponse({ success: true })
      );
      return true;
    }

    // ── Flush active session (called when popup opens) ────────────────
    case "FLUSH_SESSION": {
      flushActiveSession().then(() => sendResponse({ success: true }));
      return true;
    }

    // ── Open dashboard tab ────────────────────────────────────────────
    case "OPEN_DASHBOARD": {
      const hash = message.hash ? `#${message.hash}` : "";
      chrome.tabs.create({ url: chrome.runtime.getURL(`dashboard.html${hash}`) });
      sendResponse({ success: true });
      return false;
    }

    default:
      return false;
  }
});
