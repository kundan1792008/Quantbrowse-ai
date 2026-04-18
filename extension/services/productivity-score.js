/**
 * productivity-score.js — Quantbrowse AI Weekly Productivity Score Service
 *
 * Calculates a 0–100 score each week based on the user's browsing patterns.
 * Factors:
 *   - Time on productive/work/research domains (+)
 *   - Time on distraction domains (-)
 *   - Diversity of domains visited (+)
 *   - Consistency (browsing on multiple days) (+)
 *   - AI feature usage: commands run, digests read (+)
 *
 * Alarm: "qba-weekly-score" fires every Sunday at 20:00 local time.
 * Storage keys:
 *   weeklyScores   — Array of { week: "YYYY-WW", score, breakdown, computedAt }
 *   aiUsageCount   — number of AI commands run this week
 *   digestReadCount — number of digests read this week
 */

// ─── Constants ─────────────────────────────────────────────────────────────

const ALARM_NAME = "qba-weekly-score";
const SCORES_KEY = "weeklyScores";
const AI_USAGE_KEY = "aiUsageCount";
const DIGEST_READ_KEY = "digestReadCount";
const MAX_STORED_WEEKS = 52; // keep one year of history

// Domains that positively contribute to productivity
const PRODUCTIVE_DOMAINS = new Set([
  "github.com", "gitlab.com", "bitbucket.org",
  "stackoverflow.com", "developer.mozilla.org", "docs.python.org",
  "notion.so", "trello.com", "asana.com", "linear.app",
  "google.com", "docs.google.com", "sheets.google.com",
  "figma.com", "miro.com",
  "coursera.org", "udemy.com", "edx.org", "khanacademy.org",
  "wikipedia.org", "arxiv.org", "scholar.google.com",
  "medium.com", "dev.to", "hashnode.com",
]);

// Domains that negatively contribute (distraction)
const DISTRACTION_DOMAINS = new Set([
  "reddit.com", "twitter.com", "x.com", "facebook.com",
  "instagram.com", "tiktok.com", "youtube.com", "twitch.tv",
  "pinterest.com", "tumblr.com", "9gag.com", "buzzfeed.com",
  "netflix.com", "hulu.com", "disneyplus.com",
]);

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Returns the ISO week string "YYYY-WW" for a given date.
 * Week 1 is the week containing the first Thursday of the year (ISO 8601).
 * @param {Date} [date]
 * @returns {string}
 */
function isoWeek(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-${String(weekNo).padStart(2, "0")}`;
}

/**
 * Clamps a value between min and max.
 * @param {number} v
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

/**
 * Loads stored weekly scores.
 * @returns {Promise<Array>}
 */
async function loadScores() {
  return new Promise((resolve) => {
    chrome.storage.local.get(SCORES_KEY, (r) => resolve(r[SCORES_KEY] ?? []));
  });
}

/**
 * Saves weekly scores (most recent first, capped at MAX_STORED_WEEKS).
 * @param {Array} scores
 */
async function saveScores(scores) {
  return new Promise((resolve) => {
    chrome.storage.local.set(
      { [SCORES_KEY]: scores.slice(0, MAX_STORED_WEEKS) },
      resolve
    );
  });
}

// ─── Score computation ────────────────────────────────────────────────────

/**
 * Computes the productivity score (0–100) from usage data.
 * Returns the score and a detailed breakdown object.
 *
 * @param {Object} usageData — from chrome.storage key "usageData"
 * @param {number} aiUsage   — AI commands run this week
 * @param {number} digestRead — digests read this week
 * @returns {{ score: number, breakdown: Object }}
 */
function computeScore(usageData, aiUsage, digestRead) {
  const domains = Object.keys(usageData);

  // ── Component 1: Productive domain time (max 35 pts) ──────────────────
  let productiveMs = 0;
  let distractionMs = 0;
  let totalMs = 0;
  const activeDays = new Set();

  for (const [domain, rec] of Object.entries(usageData)) {
    totalMs += rec.totalMs ?? 0;
    if (PRODUCTIVE_DOMAINS.has(domain)) productiveMs += rec.totalMs ?? 0;
    if (DISTRACTION_DOMAINS.has(domain)) distractionMs += rec.totalMs ?? 0;
    // Rough day estimation: 1 day per 8 h of browsing per domain
    const estimatedDays = Math.ceil((rec.totalMs ?? 0) / (8 * 3600000));
    for (let i = 0; i < Math.min(estimatedDays, 7); i++) activeDays.add(`${domain}-${i}`);
  }

  const productiveFraction = totalMs > 0 ? productiveMs / totalMs : 0;
  const distractionFraction = totalMs > 0 ? distractionMs / totalMs : 0;
  const productiveScore = clamp(Math.round(productiveFraction * 35), 0, 35);

  // ── Component 2: Low distraction ratio (max 25 pts) ───────────────────
  const distractionPenalty = clamp(Math.round(distractionFraction * 25), 0, 25);
  const distractionScore = 25 - distractionPenalty;

  // ── Component 3: Domain diversity (max 20 pts) ────────────────────────
  const uniqueDomains = domains.length;
  const diversityScore = clamp(Math.round((uniqueDomains / 30) * 20), 0, 20);

  // ── Component 4: Consistency — days browsed (max 10 pts) ──────────────
  const daysActive = Math.min(activeDays.size, 7);
  const consistencyScore = clamp(Math.round((daysActive / 7) * 10), 0, 10);

  // ── Component 5: AI feature usage (max 10 pts) ────────────────────────
  const aiScore = clamp(Math.round(((aiUsage + digestRead * 2) / 20) * 10), 0, 10);

  const total = productiveScore + distractionScore + diversityScore + consistencyScore + aiScore;

  return {
    score: clamp(total, 0, 100),
    breakdown: {
      productive: productiveScore,
      lowDistraction: distractionScore,
      diversity: diversityScore,
      consistency: consistencyScore,
      aiUsage: aiScore,
      totalBrowsingHours: Math.round(totalMs / 3600000 * 10) / 10,
      productivePercent: Math.round(productiveFraction * 100),
      distractionPercent: Math.round(distractionFraction * 100),
      uniqueDomains,
      daysActive: Math.min(daysActive, 7),
    },
  };
}

/**
 * Computes and stores the score for the current week.
 * @returns {Promise<{ score: number, previous: number|null, breakdown: Object }>}
 */
async function computeAndStoreWeeklyScore() {
  const weekKey = isoWeek();

  // Load all necessary data
  const [usageRaw, aiUsageRaw, digestReadRaw, scores] = await Promise.all([
    new Promise((r) => chrome.storage.local.get("usageData", (d) => r(d.usageData ?? {}))),
    new Promise((r) => chrome.storage.local.get(AI_USAGE_KEY, (d) => r(d[AI_USAGE_KEY] ?? 0))),
    new Promise((r) => chrome.storage.local.get(DIGEST_READ_KEY, (d) => r(d[DIGEST_READ_KEY] ?? 0))),
    loadScores(),
  ]);

  const { score, breakdown } = computeScore(usageRaw, aiUsageRaw, digestReadRaw);

  // Find previous week's score
  const previous = scores.length > 0 ? scores[0].score : null;

  const entry = {
    week: weekKey,
    score,
    breakdown,
    computedAt: Date.now(),
  };

  // Replace existing entry for this week or prepend
  const existing = scores.findIndex((s) => s.week === weekKey);
  const updated =
    existing !== -1
      ? [entry, ...scores.slice(0, existing), ...scores.slice(existing + 1)]
      : [entry, ...scores];

  await saveScores(updated);

  // Reset weekly AI counters
  await new Promise((r) => chrome.storage.local.set({ [AI_USAGE_KEY]: 0, [DIGEST_READ_KEY]: 0 }, r));

  return { score, previous, breakdown };
}

// ─── Notification delivery ────────────────────────────────────────────────

/**
 * Fires the weekly productivity score notification.
 */
async function deliverProductivityScore() {
  const { score, previous, breakdown } = await computeAndStoreWeeklyScore();

  let comparisonText = "";
  if (previous !== null) {
    const diff = score - previous;
    if (diff > 0) comparisonText = ` ▲ Up ${diff} pts from last week (${previous})!`;
    else if (diff < 0) comparisonText = ` ▼ Down ${Math.abs(diff)} pts from last week (${previous}).`;
    else comparisonText = " Same as last week.";
  }

  const emoji = score >= 80 ? "🌟" : score >= 60 ? "✅" : score >= 40 ? "⚡" : "💡";

  chrome.notifications.create("qba-weekly-score", {
    type: "basic",
    iconUrl: "icons/icon48.png",
    title: `${emoji} Weekly Productivity Score: ${score}/100`,
    message:
      `Productive time: ${breakdown.productivePercent}% | Distraction: ${breakdown.distractionPercent}%` +
      comparisonText,
    buttons: [{ title: "View Full Report" }, { title: "Dismiss" }],
    requireInteraction: false,
  });
}

// ─── Alarm scheduling ─────────────────────────────────────────────────────

/**
 * Returns ms until the next Sunday at 20:00 local time.
 * @returns {number}
 */
function msUntilSundayEvening() {
  const now = new Date();
  const target = new Date(now);
  const daysUntilSunday = (7 - target.getDay()) % 7 || 7;
  target.setDate(target.getDate() + daysUntilSunday);
  target.setHours(20, 0, 0, 0);
  return Math.max(target.getTime() - now.getTime(), 60000);
}

/**
 * Handles the weekly alarm.  Called from background.js alarm listener.
 * @param {chrome.alarms.Alarm} alarm
 */
async function handleProductivityAlarm(alarm) {
  if (alarm.name !== ALARM_NAME) return;
  await deliverProductivityScore();
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Registers event listeners and alarm.  Call once from background.js.
 */
function initProductivityScore() {
  const delayMs = msUntilSundayEvening();
  chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: Math.ceil(delayMs / 60000),
    periodInMinutes: 7 * 24 * 60,
  });

  // Handle "View Full Report" button
  chrome.notifications.onButtonClicked.addListener((notifId, btnIdx) => {
    if (notifId !== "qba-weekly-score") return;
    chrome.notifications.clear(notifId);
    if (btnIdx === 0) {
      chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html#score") });
    }
  });

  chrome.notifications.onClicked.addListener((notifId) => {
    if (notifId !== "qba-weekly-score") return;
    chrome.notifications.clear(notifId);
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html#score") });
  });
}

/**
 * Increments the AI usage count for the current week.
 * Call from background.js whenever an AI command is successfully executed.
 */
async function incrementAiUsage() {
  return new Promise((resolve) => {
    chrome.storage.local.get(AI_USAGE_KEY, (r) => {
      chrome.storage.local.set({ [AI_USAGE_KEY]: (r[AI_USAGE_KEY] ?? 0) + 1 }, resolve);
    });
  });
}

/**
 * Increments the digest-read count for the current week.
 */
async function incrementDigestRead() {
  return new Promise((resolve) => {
    chrome.storage.local.get(DIGEST_READ_KEY, (r) => {
      chrome.storage.local.set({ [DIGEST_READ_KEY]: (r[DIGEST_READ_KEY] ?? 0) + 1 }, resolve);
    });
  });
}

/**
 * Returns all stored weekly scores for the dashboard.
 * @returns {Promise<Array>}
 */
async function getWeeklyScores() {
  return loadScores();
}

/**
 * Returns the current (in-progress) week's score estimate.
 * Does NOT store the result.
 * @returns {Promise<{ score: number, breakdown: Object }>}
 */
async function getCurrentWeekEstimate() {
  const [usageRaw, aiUsageRaw, digestReadRaw] = await Promise.all([
    new Promise((r) => chrome.storage.local.get("usageData", (d) => r(d.usageData ?? {}))),
    new Promise((r) => chrome.storage.local.get(AI_USAGE_KEY, (d) => r(d[AI_USAGE_KEY] ?? 0))),
    new Promise((r) => chrome.storage.local.get(DIGEST_READ_KEY, (d) => r(d[DIGEST_READ_KEY] ?? 0))),
  ]);
  return computeScore(usageRaw, aiUsageRaw, digestReadRaw);
}

export {
  initProductivityScore,
  handleProductivityAlarm,
  incrementAiUsage,
  incrementDigestRead,
  getWeeklyScores,
  getCurrentWeekEstimate,
  computeAndStoreWeeklyScore,
  ALARM_NAME as PRODUCTIVITY_ALARM_NAME,
};
