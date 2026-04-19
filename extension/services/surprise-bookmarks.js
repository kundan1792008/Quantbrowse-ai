/**
 * surprise-bookmarks.js — Quantbrowse AI "AI Found This" Surprise Service
 *
 * Monitors browsing patterns and randomly surfaces trending or interesting
 * content as surprise bookmark notifications.  Implements variable-reward
 * mechanics: users receive surprise notifications at irregular intervals
 * (between 4 and 12 hours after a bookmark-worthy item is detected).
 *
 * Storage keys:
 *   surpriseBookmarks — Array of { id, title, url, domain, savedAt, shown, reason }
 *   surpriseSettings  — { enabled: boolean, maxPerDay: number }
 *   surpriseDeliveredToday — number of surprises already delivered today
 *   surpriseLastDate   — YYYY-MM-DD of the last delivery
 *
 * Alarm:
 *   qba-surprise-check — fires every 2 hours to evaluate pending surprises
 */

// ─── Constants ─────────────────────────────────────────────────────────────

const ALARM_NAME = "qba-surprise-check";
const BOOKMARKS_KEY = "surpriseBookmarks";
const SETTINGS_KEY = "surpriseSettings";
const DELIVERED_TODAY_KEY = "surpriseDeliveredToday";
const LAST_DATE_KEY = "surpriseLastDate";
const MAX_BOOKMARKS = 50;

// Category labels for the "reason" field shown in notifications
const REASON_LABELS = {
  trending: "Trending in your interest area",
  revisit: "You might want to revisit this",
  related: "Related to what you've been reading",
  popular: "Highly visited in your browsing history",
  overnight: "Discovered while you were away",
};

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Returns today's date as "YYYY-MM-DD" in local time.
 * @returns {string}
 */
function todayDateStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Loads stored surprise bookmarks.
 * @returns {Promise<Array>}
 */
async function loadBookmarks() {
  return new Promise((resolve) => {
    chrome.storage.local.get(BOOKMARKS_KEY, (r) => resolve(r[BOOKMARKS_KEY] ?? []));
  });
}

/**
 * Saves surprise bookmarks to storage.
 * @param {Array} bookmarks
 */
async function saveBookmarks(bookmarks) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [BOOKMARKS_KEY]: bookmarks }, resolve);
  });
}

/**
 * Loads surprise feature settings.
 * @returns {Promise<{ enabled: boolean, maxPerDay: number }>}
 */
async function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(SETTINGS_KEY, (r) => {
      resolve(r[SETTINGS_KEY] ?? { enabled: true, maxPerDay: 3 });
    });
  });
}

/**
 * Returns the number of surprise notifications delivered today.
 * Resets automatically when the calendar day changes.
 * @returns {Promise<number>}
 */
async function getDeliveredToday() {
  return new Promise((resolve) => {
    chrome.storage.local.get([DELIVERED_TODAY_KEY, LAST_DATE_KEY], (r) => {
      const lastDate = r[LAST_DATE_KEY] ?? "";
      const today = todayDateStr();
      if (lastDate !== today) {
        chrome.storage.local.set({ [DELIVERED_TODAY_KEY]: 0, [LAST_DATE_KEY]: today });
        resolve(0);
      } else {
        resolve(r[DELIVERED_TODAY_KEY] ?? 0);
      }
    });
  });
}

/**
 * Increments the delivered-today counter.
 */
async function incrementDeliveredToday() {
  const current = await getDeliveredToday();
  return new Promise((resolve) => {
    chrome.storage.local.set({
      [DELIVERED_TODAY_KEY]: current + 1,
      [LAST_DATE_KEY]: todayDateStr(),
    }, resolve);
  });
}

/**
 * Generates a cryptographically weak but sufficient random ID.
 * @returns {string}
 */
function randomId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * Picks a random reason label for the variable-reward flavour text.
 * @returns {string}
 */
function randomReason() {
  const keys = Object.keys(REASON_LABELS);
  return REASON_LABELS[keys[Math.floor(Math.random() * keys.length)]];
}

// ─── Article detection ────────────────────────────────────────────────────

/**
 * Scores a history item as a bookmark candidate (0 = skip, >0 = candidate).
 * Higher scores are more likely to become surprises.
 *
 * @param {chrome.history.HistoryItem} item
 * @returns {number}
 */
function scoreItem(item) {
  if (!item.url || !item.title) return 0;
  const url = item.url.toLowerCase();
  const title = item.title.toLowerCase();

  // Skip internal/utility pages
  if (url.startsWith("chrome") || url.startsWith("about:") || url.startsWith("moz-extension")) return 0;
  if (url.includes("login") || url.includes("signin") || url.includes("checkout")) return 0;

  let score = 0;

  // Boost for article-like URLs
  if (/\/(article|post|blog|story|news|read|watch)/.test(url)) score += 3;
  if (item.visitCount && item.visitCount >= 3) score += 2; // revisited
  if (title.length > 30) score += 1; // has a descriptive title

  // Boost for interest keywords in title
  const INTEREST_KEYWORDS = [
    "how", "why", "what", "best", "top", "guide", "tips",
    "ai", "technology", "science", "health", "finance", "tutorial",
  ];
  for (const kw of INTEREST_KEYWORDS) {
    if (title.includes(kw)) { score += 1; break; }
  }

  return score;
}

/**
 * Scans the last 48 h of history and queues new surprise bookmark candidates.
 * @returns {Promise<number>} number of new candidates added
 */
async function scanForCandidates() {
  let historyItems = [];
  try {
    historyItems = await chrome.history.search({
      text: "",
      startTime: Date.now() - 48 * 60 * 60 * 1000,
      maxResults: 300,
    });
  } catch {
    return 0;
  }

  const existing = await loadBookmarks();
  const existingUrls = new Set(existing.map((b) => b.url));

  const candidates = historyItems
    .map((item) => ({ item, score: scoreItem(item) }))
    .filter(({ score }) => score >= 3)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(({ item }) => item)
    .filter((item) => !existingUrls.has(item.url));

  if (candidates.length === 0) return 0;

  const newBookmarks = candidates.map((item) => ({
    id: randomId(),
    title: item.title ?? item.url,
    url: item.url,
    domain: (() => {
      try { return new URL(item.url).hostname.replace(/^www\./, ""); } catch { return ""; }
    })(),
    savedAt: Date.now(),
    shown: false,
    reason: randomReason(),
    score: scoreItem(item),
  }));

  const merged = [...newBookmarks, ...existing].slice(0, MAX_BOOKMARKS);
  await saveBookmarks(merged);
  return newBookmarks.length;
}

// ─── Notification delivery ────────────────────────────────────────────────

/**
 * Picks an unshown bookmark and delivers a surprise notification.
 * Uses variable timing to create unpredictable (rewarding) delivery.
 *
 * @returns {Promise<boolean>} true if a notification was shown
 */
async function deliverSurprise() {
  const settings = await loadSettings();
  if (!settings.enabled) return false;

  const deliveredToday = await getDeliveredToday();
  if (deliveredToday >= settings.maxPerDay) return false;

  const bookmarks = await loadBookmarks();
  const unshown = bookmarks.filter((b) => !b.shown);
  if (unshown.length === 0) return false;

  // Pick a random unshown item (variable reward — not always the "best")
  const pick = unshown[Math.floor(Math.random() * Math.min(unshown.length, 5))];

  chrome.notifications.create(`qba-surprise-${pick.id}`, {
    type: "basic",
    iconUrl: "icons/icon48.png",
    title: "🤖 AI Found This For You",
    message: `"${pick.title}" — ${pick.reason}`,
    buttons: [{ title: "Open" }, { title: "Bookmark It" }],
    requireInteraction: false,
  });

  // Mark as shown
  const updated = bookmarks.map((b) =>
    b.id === pick.id ? { ...b, shown: true, shownAt: Date.now() } : b
  );
  await saveBookmarks(updated);
  await incrementDeliveredToday();

  // Store the pending URL so the click handler can open it
  await new Promise((resolve) => {
    chrome.storage.local.set({ [`surprisePending_${pick.id}`]: pick.url }, resolve);
  });

  return true;
}

// ─── Alarm handler ────────────────────────────────────────────────────────

/**
 * Handles the periodic alarm.  Called from background.js alarm listener.
 * @param {chrome.alarms.Alarm} alarm
 */
async function handleSurpriseAlarm(alarm) {
  if (alarm.name !== ALARM_NAME) return;
  await scanForCandidates();
  // Only deliver a surprise ~40% of the time for variable reward
  if (Math.random() < 0.4) {
    await deliverSurprise();
  }
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Registers event listeners and alarm.  Call once from background.js.
 */
function initSurpriseBookmarks() {
  // Schedule periodic check every 2 hours
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 120 });

  // Handle notification button clicks
  chrome.notifications.onButtonClicked.addListener(async (notifId, btnIdx) => {
    if (!notifId.startsWith("qba-surprise-")) return;
    const id = notifId.replace("qba-surprise-", "");
    chrome.notifications.clear(notifId);

    const key = `surprisePending_${id}`;
    const result = await new Promise((resolve) => chrome.storage.local.get(key, resolve));
    const url = result[key];
    if (!url) return;

    if (btnIdx === 0) {
      // "Open" — navigate to the article
      chrome.tabs.create({ url });
    } else if (btnIdx === 1) {
      // "Bookmark It" — add to Chrome bookmarks
      try {
        await chrome.bookmarks.create({ title: id, url });
        chrome.notifications.create(`qba-bookmarked-${id}`, {
          type: "basic",
          iconUrl: "icons/icon48.png",
          title: "Bookmarked!",
          message: "Article added to your Chrome bookmarks.",
        });
      } catch {
        // Bookmarks API may not be available
      }
    }

    chrome.storage.local.remove(key);
  });

  // Notification body click → open article
  chrome.notifications.onClicked.addListener(async (notifId) => {
    if (!notifId.startsWith("qba-surprise-")) return;
    const id = notifId.replace("qba-surprise-", "");
    chrome.notifications.clear(notifId);
    const key = `surprisePending_${id}`;
    const result = await new Promise((resolve) => chrome.storage.local.get(key, resolve));
    const url = result[key];
    if (url) {
      chrome.tabs.create({ url });
      chrome.storage.local.remove(key);
    }
  });
}

/**
 * Returns all stored surprise bookmarks for the dashboard.
 * @returns {Promise<Array>}
 */
async function getSurpriseBookmarks() {
  return loadBookmarks();
}

/**
 * Manually triggers a surprise delivery (e.g., from the popup).
 * @returns {Promise<boolean>}
 */
async function triggerSurprise() {
  await scanForCandidates();
  return deliverSurprise();
}

/**
 * Updates surprise feature settings.
 * @param {{ enabled?: boolean, maxPerDay?: number }} updates
 */
async function updateSurpriseSettings(updates) {
  const current = await loadSettings();
  return new Promise((resolve) => {
    chrome.storage.local.set({ [SETTINGS_KEY]: { ...current, ...updates } }, resolve);
  });
}

export {
  initSurpriseBookmarks,
  handleSurpriseAlarm,
  getSurpriseBookmarks,
  triggerSurprise,
  updateSurpriseSettings,
  scanForCandidates,
  ALARM_NAME as SURPRISE_ALARM_NAME,
};
