/**
 * daily-digest.js — Quantbrowse AI Daily Digest Service
 *
 * Delivers a morning notification summarising the user's overnight AI
 * activity and surfaced articles.  Uses chrome.alarms to trigger at a
 * configurable hour (default 08:00 local time) every day.
 *
 * Storage keys:
 *   digestArticles  — Array of { title, url, domain, savedAt } — up to 20 items
 *   digestSettings  — { hourLocal: number, enabled: boolean }
 *   lastDigestAt    — epoch ms of the most recent digest delivery
 */

// ─── Constants ─────────────────────────────────────────────────────────────

const ALARM_NAME = "qba-daily-digest";
const ARTICLES_KEY = "digestArticles";
const SETTINGS_KEY = "digestSettings";
const LAST_DIGEST_KEY = "lastDigestAt";
const MAX_ARTICLES = 20;
const DEFAULT_HOUR = 8; // 08:00 local time

// Topics/keywords that indicate an "interesting" article.
// The AI matching is heuristic — based on title keywords from browsing history.
const INTEREST_KEYWORDS = [
  "ai", "artificial intelligence", "machine learning", "deep learning",
  "technology", "science", "research", "study", "analysis",
  "productivity", "growth", "startup", "innovation", "future",
  "health", "fitness", "finance", "investing", "economics",
  "tutorial", "how to", "guide", "tips", "tricks",
  "review", "comparison", "best", "top", "ranked",
];

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Loads stored article candidates.
 * @returns {Promise<Array>}
 */
async function loadArticles() {
  return new Promise((resolve) => {
    chrome.storage.local.get(ARTICLES_KEY, (r) => resolve(r[ARTICLES_KEY] ?? []));
  });
}

/**
 * Saves article candidates to storage.
 * @param {Array} articles
 */
async function saveArticles(articles) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [ARTICLES_KEY]: articles }, resolve);
  });
}

/**
 * Loads digest settings.
 * @returns {Promise<{ hourLocal: number, enabled: boolean }>}
 */
async function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(SETTINGS_KEY, (r) => {
      resolve(r[SETTINGS_KEY] ?? { hourLocal: DEFAULT_HOUR, enabled: true });
    });
  });
}

/**
 * Computes the number of milliseconds until the next occurrence of
 * `hourLocal:00` in the user's local timezone.
 *
 * @param {number} hourLocal  0–23
 * @returns {number} delay in ms (always positive)
 */
function msUntilHour(hourLocal) {
  const now = new Date();
  const target = new Date();
  target.setHours(hourLocal, 0, 0, 0);
  if (target <= now) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime() - now.getTime();
}

/**
 * Checks whether a history item title/url looks "interesting" based on keywords.
 * @param {chrome.history.HistoryItem} item
 * @returns {boolean}
 */
function isInteresting(item) {
  const text = ((item.title ?? "") + " " + (item.url ?? "")).toLowerCase();
  return INTEREST_KEYWORDS.some((kw) => text.includes(kw));
}

// ─── Article indexing ─────────────────────────────────────────────────────

/**
 * Scans the last 24 h of browsing history for interesting articles and
 * appends new entries to the digestArticles store.
 * Called once per day by the alarm handler.
 *
 * @returns {Promise<number>} number of newly added articles
 */
async function indexOvernightArticles() {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  let historyItems = [];
  try {
    historyItems = await chrome.history.search({
      text: "",
      startTime: since,
      maxResults: 200,
    });
  } catch {
    // history permission may not be granted; fail gracefully
    return 0;
  }

  const interesting = historyItems.filter(isInteresting);
  const existing = await loadArticles();
  const existingUrls = new Set(existing.map((a) => a.url));
  const newArticles = interesting
    .filter((item) => item.url && !existingUrls.has(item.url))
    .map((item) => ({
      title: item.title ?? item.url,
      url: item.url,
      domain: (() => {
        try { return new URL(item.url).hostname.replace(/^www\./, ""); } catch { return ""; }
      })(),
      savedAt: Date.now(),
      visitCount: item.visitCount ?? 1,
    }));

  const merged = [...newArticles, ...existing].slice(0, MAX_ARTICLES);
  await saveArticles(merged);
  return newArticles.length;
}

// ─── Notification delivery ────────────────────────────────────────────────

/**
 * Fires the morning digest notification.
 * Shows total articles found and the top article title.
 */
async function deliverDigest() {
  const settings = await loadSettings();
  if (!settings.enabled) return;

  const articles = await loadArticles();
  const fresh = articles.filter((a) => a.savedAt > Date.now() - 24 * 60 * 60 * 1000);
  const count = fresh.length;

  let message;
  if (count === 0) {
    message = "No new articles overnight. Browse more today and your AI will learn your interests!";
  } else if (count === 1) {
    message = `Your AI found 1 interesting article overnight: "${fresh[0].title}"`;
  } else {
    message = `Your AI found ${count} interesting articles overnight based on your browsing. Check your digest!`;
  }

  chrome.notifications.create("qba-daily-digest", {
    type: "basic",
    iconUrl: "icons/icon48.png",
    title: "☀️ Good Morning — Quantbrowse Digest",
    message,
    buttons: [{ title: "View Digest" }, { title: "Later" }],
    requireInteraction: false,
  });

  await new Promise((resolve) => {
    chrome.storage.local.set({ [LAST_DIGEST_KEY]: Date.now() }, resolve);
  });
}

// ─── Alarm scheduling ─────────────────────────────────────────────────────

/**
 * Schedules (or re-schedules) the daily digest alarm.
 * @param {number} [hourLocal] Local hour to fire (0–23). Uses stored setting if omitted.
 */
async function scheduleDigestAlarm(hourLocal) {
  const settings = await loadSettings();
  const hour = hourLocal ?? settings.hourLocal;
  const delayMs = msUntilHour(hour);
  const delayMinutes = Math.max(1, Math.ceil(delayMs / 60000));

  await chrome.alarms.clear(ALARM_NAME);
  chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: delayMinutes,
    periodInMinutes: 24 * 60, // re-fires every 24 h
  });
}

/**
 * Handles the alarm event.  Called from background.js's alarm listener.
 * @param {chrome.alarms.Alarm} alarm
 */
async function handleDigestAlarm(alarm) {
  if (alarm.name !== ALARM_NAME) return;
  await indexOvernightArticles();
  await deliverDigest();
}

/**
 * Registers the notification click handler and sets up the alarm.
 * Must be called once from background.js.
 */
function initDailyDigest() {
  // Schedule alarm
  scheduleDigestAlarm();

  // Handle "View Digest" button click
  chrome.notifications.onButtonClicked.addListener((notifId, btnIdx) => {
    if (notifId !== "qba-daily-digest") return;
    chrome.notifications.clear(notifId);
    if (btnIdx === 0) {
      // Open the dashboard / digest page
      chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html#digest") });
    }
  });

  // Also open dashboard when notification body is clicked
  chrome.notifications.onClicked.addListener((notifId) => {
    if (notifId !== "qba-daily-digest") return;
    chrome.notifications.clear(notifId);
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html#digest") });
  });
}

/**
 * Returns the list of recently found articles for display in the dashboard.
 * @returns {Promise<Array>}
 */
async function getDigestArticles() {
  return loadArticles();
}

/**
 * Clears the article list (e.g., when user marks digest as read).
 */
async function clearDigestArticles() {
  await saveArticles([]);
}

/**
 * Updates digest settings (e.g., change notification hour).
 * @param {{ hourLocal?: number, enabled?: boolean }} updates
 */
async function updateDigestSettings(updates) {
  const current = await loadSettings();
  const next = { ...current, ...updates };
  await new Promise((resolve) => {
    chrome.storage.local.set({ [SETTINGS_KEY]: next }, resolve);
  });
  // Re-schedule if hour changed
  if (updates.hourLocal !== undefined) {
    await scheduleDigestAlarm(next.hourLocal);
  }
}

export {
  initDailyDigest,
  handleDigestAlarm,
  getDigestArticles,
  clearDigestArticles,
  updateDigestSettings,
  indexOvernightArticles,
  deliverDigest,
  ALARM_NAME as DIGEST_ALARM_NAME,
};
