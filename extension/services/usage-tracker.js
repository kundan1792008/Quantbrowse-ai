/**
 * usage-tracker.js — Quantbrowse AI Usage Tracker Service
 *
 * Tracks time spent on each domain across all browser tabs.
 * Persists cumulative totals in chrome.storage.local under the key
 * "usageData".  Data structure:
 *
 *   usageData: {
 *     [domain]: {
 *       totalMs: number,           // all-time milliseconds
 *       todayMs: number,           // milliseconds since midnight
 *       lastReset: number,         // epoch ms of last daily reset
 *       visits: number,            // all-time page-load count
 *       todayVisits: number        // visits since midnight
 *     }
 *   }
 *
 * Responsibilities:
 *  1. Track the active tab's start time when focus changes.
 *  2. Flush elapsed time to storage on focus-change and tab removal.
 *  3. Reset "today" counters at midnight (via the alarm "qba-daily-reset").
 *  4. Expose helper methods used by background.js and the dashboard.
 */

// ─── Constants ────────────────────────────────────────────────────────────

const STORAGE_KEY = "usageData";
const QUANTBROWSE_SPEED_FACTOR = 0.25; // We claim to save 25 % of time on a site

// Domains considered "distraction" for the productivity score
const DISTRACTION_DOMAINS = new Set([
  "reddit.com",
  "twitter.com",
  "x.com",
  "facebook.com",
  "instagram.com",
  "tiktok.com",
  "youtube.com",
  "twitch.tv",
  "pinterest.com",
  "tumblr.com",
  "9gag.com",
  "buzzfeed.com",
]);

// ─── Module-level state (not persisted; reconstructed on service-worker wake) ──

/** @type {{ tabId: number|null, domain: string|null, startMs: number|null }} */
let activeSession = { tabId: null, domain: null, startMs: null };

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Extracts the registrable domain (hostname without www.) from a URL string.
 * Returns null for chrome://, extension pages, and blank tabs.
 *
 * @param {string} url
 * @returns {string|null}
 */
function domainFromUrl(url) {
  try {
    const { hostname, protocol } = new URL(url);
    if (!["http:", "https:"].includes(protocol)) return null;
    return hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * Returns midnight (00:00:00.000) of today in local time as epoch ms.
 * @returns {number}
 */
function todayMidnight() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Loads the full usage map from storage.
 * @returns {Promise<Object>}
 */
async function loadUsageData() {
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEY, (result) => {
      resolve(result[STORAGE_KEY] ?? {});
    });
  });
}

/**
 * Saves the full usage map to storage.
 * @param {Object} data
 * @returns {Promise<void>}
 */
async function saveUsageData(data) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY]: data }, resolve);
  });
}

/**
 * Adds elapsed milliseconds to a domain's usage record.
 * Handles midnight crossover by capping today's increment.
 *
 * @param {Object} usageData  Mutable usage map
 * @param {string} domain
 * @param {number} elapsedMs
 */
function accumulateTime(usageData, domain, elapsedMs) {
  if (!usageData[domain]) {
    usageData[domain] = {
      totalMs: 0,
      todayMs: 0,
      lastReset: todayMidnight(),
      visits: 0,
      todayVisits: 0,
    };
  }
  const rec = usageData[domain];
  // Reset "today" counters if the calendar day has changed
  const midnight = todayMidnight();
  if (rec.lastReset < midnight) {
    rec.todayMs = 0;
    rec.todayVisits = 0;
    rec.lastReset = midnight;
  }
  rec.totalMs += elapsedMs;
  rec.todayMs += elapsedMs;
}

// ─── Core tracker logic ───────────────────────────────────────────────────

/**
 * Flushes the currently active session to storage and resets activeSession.
 * Safe to call when there is no active session.
 */
async function flushActiveSession() {
  if (!activeSession.domain || activeSession.startMs === null) return;
  const elapsed = Date.now() - activeSession.startMs;
  if (elapsed < 500) {
    activeSession = { tabId: null, domain: null, startMs: null };
    return;
  }
  const usageData = await loadUsageData();
  accumulateTime(usageData, activeSession.domain, elapsed);
  await saveUsageData(usageData);
  activeSession = { tabId: null, domain: null, startMs: null };
}

/**
 * Starts a new tracking session for the given tab/url.
 * Flushes any previous session first.
 *
 * @param {number} tabId
 * @param {string} url
 */
async function startSession(tabId, url) {
  await flushActiveSession();
  const domain = domainFromUrl(url);
  if (!domain) return;
  // Increment visit counter
  const usageData = await loadUsageData();
  if (!usageData[domain]) {
    usageData[domain] = {
      totalMs: 0,
      todayMs: 0,
      lastReset: todayMidnight(),
      visits: 0,
      todayVisits: 0,
    };
  }
  const midnight = todayMidnight();
  if (usageData[domain].lastReset < midnight) {
    usageData[domain].todayMs = 0;
    usageData[domain].todayVisits = 0;
    usageData[domain].lastReset = midnight;
  }
  usageData[domain].visits += 1;
  usageData[domain].todayVisits += 1;
  await saveUsageData(usageData);
  activeSession = { tabId, domain, startMs: Date.now() };
}

// ─── Chrome event listeners ───────────────────────────────────────────────

/**
 * Called when the user switches active tabs.
 * @param {{ tabId: number }} info
 */
async function onTabActivated({ tabId }) {
  await flushActiveSession();
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.url) await startSession(tabId, tab.url);
  } catch {
    // Tab may have been closed already
  }
}

/**
 * Called when the URL of an existing tab changes (navigation).
 * @param {{ tabId: number, url: string, frameId: number }} details
 */
async function onNavCompleted({ tabId, url, frameId }) {
  if (frameId !== 0) return; // Only care about top-level frame
  // Only flush and restart if this is the currently active tracked tab
  if (activeSession.tabId === tabId || activeSession.tabId === null) {
    try {
      const [activeTab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (activeTab?.id === tabId) {
        await startSession(tabId, url);
      }
    } catch {
      // Ignore errors from restricted pages
    }
  }
}

/**
 * Called when a tab is closed.
 * @param {number} tabId
 */
async function onTabRemoved(tabId) {
  if (activeSession.tabId === tabId) {
    await flushActiveSession();
  }
}

/**
 * Called when the browser window loses focus (user switches apps).
 * @param {number} windowId
 */
async function onWindowFocusChanged(windowId) {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    await flushActiveSession();
  } else {
    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        windowId,
      });
      if (tab?.id && tab?.url) await startSession(tab.id, tab.url);
    } catch {
      // Ignore
    }
  }
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Registers all Chrome event listeners.
 * Must be called once from background.js during service-worker startup.
 */
function initUsageTracker() {
  chrome.tabs.onActivated.addListener(onTabActivated);
  chrome.webNavigation.onCompleted.addListener(onNavCompleted);
  chrome.tabs.onRemoved.addListener(onTabRemoved);
  chrome.windows.onFocusChanged.addListener(onWindowFocusChanged);
}

/**
 * Returns today's per-domain usage sorted by time spent (descending).
 *
 * @returns {Promise<Array<{domain: string, todayMs: number, todayVisits: number, savedMs: number}>>}
 */
async function getTodayUsage() {
  const usageData = await loadUsageData();
  const midnight = todayMidnight();
  return Object.entries(usageData)
    .map(([domain, rec]) => {
      const todayMs = rec.lastReset >= midnight ? rec.todayMs : 0;
      return {
        domain,
        todayMs,
        todayVisits: rec.lastReset >= midnight ? rec.todayVisits : 0,
        savedMs: Math.round(todayMs * QUANTBROWSE_SPEED_FACTOR),
        isDistraction: DISTRACTION_DOMAINS.has(domain),
      };
    })
    .filter((r) => r.todayMs > 0)
    .sort((a, b) => b.todayMs - a.todayMs);
}

/**
 * Returns all-time per-domain usage sorted by total time (descending).
 * @returns {Promise<Array>}
 */
async function getAllTimeUsage() {
  const usageData = await loadUsageData();
  return Object.entries(usageData)
    .map(([domain, rec]) => ({
      domain,
      totalMs: rec.totalMs,
      visits: rec.visits,
      savedMs: Math.round(rec.totalMs * QUANTBROWSE_SPEED_FACTOR),
      isDistraction: DISTRACTION_DOMAINS.has(domain),
    }))
    .sort((a, b) => b.totalMs - a.totalMs);
}

/**
 * Returns a human-readable summary string for the top domain today.
 * Used by the daily digest notification.
 * @returns {Promise<string>}
 */
async function getTodaySummaryMessage() {
  const usage = await getTodayUsage();
  if (usage.length === 0) return "No browsing data yet today.";
  const top = usage[0];
  const totalTodayMs = usage.reduce((s, r) => s + r.todayMs, 0);
  const totalSavedMs = usage.reduce((s, r) => s + r.savedMs, 0);
  const topMins = Math.round(top.todayMs / 60000);
  const savedMins = Math.round(totalSavedMs / 60000);
  return (
    `You spent ${topMins} min on ${top.domain} today. ` +
    `Quantbrowse could have saved you ${savedMins} minutes across all sites.`
  );
}

/**
 * Resets today's counters for all domains.
 * Called by the "qba-daily-reset" alarm handler.
 */
async function resetDailyCounters() {
  const usageData = await loadUsageData();
  const midnight = todayMidnight();
  for (const domain of Object.keys(usageData)) {
    usageData[domain].todayMs = 0;
    usageData[domain].todayVisits = 0;
    usageData[domain].lastReset = midnight;
  }
  await saveUsageData(usageData);
}

/**
 * Returns the fraction of today's time spent on distraction domains (0–1).
 * @returns {Promise<number>}
 */
async function getDistractionRatio() {
  const usage = await getTodayUsage();
  const total = usage.reduce((s, r) => s + r.todayMs, 0);
  if (total === 0) return 0;
  const distraction = usage
    .filter((r) => r.isDistraction)
    .reduce((s, r) => s + r.todayMs, 0);
  return distraction / total;
}

export {
  initUsageTracker,
  getTodayUsage,
  getAllTimeUsage,
  getTodaySummaryMessage,
  resetDailyCounters,
  getDistractionRatio,
  flushActiveSession,
  domainFromUrl,
  DISTRACTION_DOMAINS,
};
