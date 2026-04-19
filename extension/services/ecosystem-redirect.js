/**
 * ecosystem-redirect.js — Quantbrowse AI Ecosystem Redirect Service
 *
 * Background-side logic for the ecosystem redirect interceptor.
 * Manages:
 *   1. The competitor → Quant-app mapping table.
 *   2. Per-domain nudge rate-limiting (one nudge per domain per hour).
 *   3. Storage of redirect statistics.
 *   4. Message handler for content-script redirect events.
 *
 * The content-side badge (redirect-badge.js) injects the visual overlay;
 * this module handles the authoritative data and persistence.
 *
 * Storage keys:
 *   redirectStats   — { [competitorDomain]: { nudges, accepted, dismissed, lastNudgeAt } }
 *   redirectEnabled — boolean (default true)
 */

// ─── Competitor → Quant App mapping ───────────────────────────────────────

/**
 * Each entry describes one supported redirect.
 *
 * @typedef {{
 *   competitor: string,       // hostname match (substring)
 *   quantApp: string,         // Quant product name
 *   quantUrl: string,         // base URL of the Quant alternative
 *   feature: string,          // one-line feature pitch
 *   contextMatch?: RegExp,    // optional: only nudge on matching sub-paths
 *   badgeLabel: string,       // short label shown on the badge
 * }} RedirectRule
 */

/** @type {RedirectRule[]} */
const REDIRECT_RULES = [
  {
    competitor: "youtube.com",
    quantApp: "Quanttube",
    quantUrl: "https://quanttube.ai",
    feature: "AI dubbing, ad-free, smart chapters",
    contextMatch: /\/watch/,
    badgeLabel: "Watch on Quanttube",
  },
  {
    competitor: "twitter.com",
    quantApp: "QuantSocial",
    quantUrl: "https://quantsocial.ai",
    feature: "AI-curated feed, no algorithmic noise",
    badgeLabel: "Read on QuantSocial",
  },
  {
    competitor: "x.com",
    quantApp: "QuantSocial",
    quantUrl: "https://quantsocial.ai",
    feature: "AI-curated feed, no algorithmic noise",
    badgeLabel: "Read on QuantSocial",
  },
  {
    competitor: "reddit.com",
    quantApp: "QuantForum",
    quantUrl: "https://quantforum.ai",
    feature: "AI-summarised threads, no doom-scroll",
    badgeLabel: "Discuss on QuantForum",
  },
  {
    competitor: "google.com/search",
    quantApp: "QuantSearch",
    quantUrl: "https://quantsearch.ai",
    feature: "AI-powered answers with citations",
    contextMatch: /\/search/,
    badgeLabel: "Search with QuantSearch",
  },
  {
    competitor: "bing.com",
    quantApp: "QuantSearch",
    quantUrl: "https://quantsearch.ai",
    feature: "AI-powered answers with citations",
    badgeLabel: "Search with QuantSearch",
  },
  {
    competitor: "netflix.com",
    quantApp: "QuantStream",
    quantUrl: "https://quantstream.ai",
    feature: "AI recommendations, subtitle AI, mood match",
    badgeLabel: "Stream on QuantStream",
  },
  {
    competitor: "spotify.com",
    quantApp: "QuantMusic",
    quantUrl: "https://quantmusic.ai",
    feature: "AI DJ, mood-aware playlists",
    badgeLabel: "Listen on QuantMusic",
  },
  {
    competitor: "medium.com",
    quantApp: "QuantRead",
    quantUrl: "https://quantread.ai",
    feature: "AI-summarised articles, no paywall",
    badgeLabel: "Read on QuantRead",
  },
  {
    competitor: "news.google.com",
    quantApp: "QuantNews",
    quantUrl: "https://quantnews.ai",
    feature: "Bias-aware AI news digest",
    badgeLabel: "Read on QuantNews",
  },
  {
    competitor: "amazon.com",
    quantApp: "QuantShop",
    quantUrl: "https://quantshop.ai",
    feature: "AI price comparison & review analysis",
    badgeLabel: "Compare on QuantShop",
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────

const STATS_KEY = "redirectStats";
const ENABLED_KEY = "redirectEnabled";
const NUDGE_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour between nudges on the same domain

/**
 * Loads redirect stats from storage.
 * @returns {Promise<Object>}
 */
async function loadStats() {
  return new Promise((resolve) => {
    chrome.storage.local.get(STATS_KEY, (r) => resolve(r[STATS_KEY] ?? {}));
  });
}

/**
 * Saves redirect stats to storage.
 * @param {Object} stats
 */
async function saveStats(stats) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STATS_KEY]: stats }, resolve);
  });
}

/**
 * Returns whether the redirect feature is enabled.
 * @returns {Promise<boolean>}
 */
async function isRedirectEnabled() {
  return new Promise((resolve) => {
    chrome.storage.local.get(ENABLED_KEY, (r) => {
      resolve(r[ENABLED_KEY] !== false); // default true
    });
  });
}

/**
 * Checks whether the cooldown has elapsed for the given competitor domain.
 * @param {Object} stats
 * @param {string} competitor
 * @returns {boolean} true if a nudge is allowed
 */
function canNudge(stats, competitor) {
  const rec = stats[competitor];
  if (!rec) return true;
  return Date.now() - (rec.lastNudgeAt ?? 0) > NUDGE_COOLDOWN_MS;
}

/**
 * Finds the matching redirect rule for a given URL.
 * @param {string} url
 * @returns {RedirectRule|null}
 */
function findRule(url) {
  try {
    const { hostname, pathname } = new URL(url);
    for (const rule of REDIRECT_RULES) {
      if (!hostname.includes(rule.competitor)) continue;
      if (rule.contextMatch && !rule.contextMatch.test(pathname)) continue;
      return rule;
    }
  } catch {
    // Invalid URL — ignore
  }
  return null;
}

// ─── Message handler ──────────────────────────────────────────────────────

/**
 * Processes messages from the redirect content script.
 * Handled message types:
 *   GET_REDIRECT_RULE   — returns rule if current URL matches, or null
 *   REDIRECT_ACCEPTED   — user clicked "Go to Quant app"
 *   REDIRECT_DISMISSED  — user dismissed the badge
 *
 * @param {object} message
 * @param {chrome.runtime.MessageSender} sender
 * @param {function} sendResponse
 * @returns {boolean} true if async
 */
function handleRedirectMessage(message, sender, sendResponse) {
  const tabUrl = sender.tab?.url ?? "";

  switch (message.type) {
    case "GET_REDIRECT_RULE": {
      (async () => {
        if (!(await isRedirectEnabled())) {
          sendResponse({ rule: null });
          return;
        }
        const stats = await loadStats();
        const rule = findRule(tabUrl);
        if (!rule || !canNudge(stats, rule.competitor)) {
          sendResponse({ rule: null });
          return;
        }
        // Record nudge
        stats[rule.competitor] = {
          ...(stats[rule.competitor] ?? { nudges: 0, accepted: 0, dismissed: 0 }),
          nudges: (stats[rule.competitor]?.nudges ?? 0) + 1,
          lastNudgeAt: Date.now(),
        };
        await saveStats(stats);
        sendResponse({ rule });
      })();
      return true;
    }

    case "REDIRECT_ACCEPTED": {
      (async () => {
        const stats = await loadStats();
        const rule = findRule(tabUrl);
        if (rule) {
          stats[rule.competitor] = {
            ...(stats[rule.competitor] ?? { nudges: 0, accepted: 0, dismissed: 0 }),
            accepted: (stats[rule.competitor]?.accepted ?? 0) + 1,
          };
          await saveStats(stats);
        }
        sendResponse({ ok: true });
      })();
      return true;
    }

    case "REDIRECT_DISMISSED": {
      (async () => {
        const stats = await loadStats();
        const rule = findRule(tabUrl);
        if (rule) {
          stats[rule.competitor] = {
            ...(stats[rule.competitor] ?? { nudges: 0, accepted: 0, dismissed: 0 }),
            dismissed: (stats[rule.competitor]?.dismissed ?? 0) + 1,
            // Extend cooldown by 4h on dismiss to avoid annoying the user
            lastNudgeAt: Date.now() + 3 * NUDGE_COOLDOWN_MS,
          };
          await saveStats(stats);
        }
        sendResponse({ ok: true });
      })();
      return true;
    }

    default:
      return false;
  }
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Returns all redirect rules (used by dashboard).
 * @returns {RedirectRule[]}
 */
function getRedirectRules() {
  return REDIRECT_RULES;
}

/**
 * Returns stored redirect statistics for the dashboard.
 * @returns {Promise<Object>}
 */
async function getRedirectStats() {
  return loadStats();
}

/**
 * Enables or disables the redirect feature.
 * @param {boolean} enabled
 */
async function setRedirectEnabled(enabled) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [ENABLED_KEY]: enabled }, resolve);
  });
}

export {
  handleRedirectMessage,
  getRedirectRules,
  getRedirectStats,
  setRedirectEnabled,
  findRule,
  REDIRECT_RULES,
};
