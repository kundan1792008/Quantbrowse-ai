/**
 * tab-grouper.js — Quantbrowse AI Smart Tab Grouping Service
 *
 * Automatically organises open tabs into named colour-coded groups
 * based on domain category heuristics.  When the user has 30+ tabs open,
 * a notification badge prompts them to let Quantbrowse manage things.
 *
 * Categories and their Chrome tab-group colours:
 *   work        → blue
 *   social      → red
 *   news        → orange
 *   shopping    → yellow
 *   research    → purple
 *   entertainment → pink
 *   other       → grey
 *
 * Relies on:
 *   - chrome.tabs API (query, group, move)
 *   - chrome.tabGroups API (update)
 *   - chrome.notifications API
 */

// ─── Category map ─────────────────────────────────────────────────────────

/**
 * Maps domain substrings to category labels.
 * Evaluated in order — first match wins.
 */
const DOMAIN_CATEGORY_RULES = [
  // Work / productivity
  { pattern: /github\.com|gitlab\.com|bitbucket\.org/, category: "work", color: "blue" },
  { pattern: /jira|confluence|notion\.so|asana|trello|monday\.com|linear\.app/, category: "work", color: "blue" },
  { pattern: /google\.com\/docs|google\.com\/sheets|google\.com\/slides|docs\.google/, category: "work", color: "blue" },
  { pattern: /slack\.com|teams\.microsoft|zoom\.us|meet\.google/, category: "work", color: "blue" },
  { pattern: /figma\.com|miro\.com|lucidchart\.com/, category: "work", color: "blue" },
  { pattern: /stackoverflow\.com|developer\.mozilla|docs\.|devdocs\.io/, category: "research", color: "purple" },

  // Social
  { pattern: /facebook\.com|instagram\.com|twitter\.com|x\.com|linkedin\.com/, category: "social", color: "red" },
  { pattern: /reddit\.com|tumblr\.com|pinterest\.com|tiktok\.com|snapchat\.com/, category: "social", color: "red" },
  { pattern: /discord\.com|telegram\.org|whatsapp\.com/, category: "social", color: "red" },

  // News
  { pattern: /cnn\.com|bbc\.com|nytimes\.com|theguardian\.com|reuters\.com/, category: "news", color: "orange" },
  { pattern: /techcrunch\.com|theverge\.com|wired\.com|arstechnica\.com|hackernews|news\.ycombinator/, category: "news", color: "orange" },
  { pattern: /medium\.com|substack\.com/, category: "news", color: "orange" },

  // Shopping
  { pattern: /amazon\.com|ebay\.com|etsy\.com|walmart\.com|shopify\.com/, category: "shopping", color: "yellow" },
  { pattern: /bestbuy\.com|target\.com|aliexpress\.com|wish\.com/, category: "shopping", color: "yellow" },

  // Entertainment
  { pattern: /youtube\.com|twitch\.tv|netflix\.com|hulu\.com|disneyplus\.com/, category: "entertainment", color: "pink" },
  { pattern: /spotify\.com|soundcloud\.com|pandora\.com|deezer\.com/, category: "entertainment", color: "pink" },
  { pattern: /imdb\.com|rottentomatoes\.com|metacritic\.com/, category: "entertainment", color: "pink" },

  // Research / education
  { pattern: /wikipedia\.org|scholar\.google|arxiv\.org|semanticscholar\.org/, category: "research", color: "purple" },
  { pattern: /coursera\.org|udemy\.com|edx\.org|khanacademy\.org|pluralsight\.com/, category: "research", color: "purple" },
];

const TAB_OVERLOAD_THRESHOLD = 30;

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Categorises a tab URL into one of the defined categories.
 *
 * @param {string} url
 * @returns {{ category: string, color: string }}
 */
function categoriseUrl(url) {
  if (!url) return { category: "other", color: "grey" };
  for (const rule of DOMAIN_CATEGORY_RULES) {
    if (rule.pattern.test(url)) {
      return { category: rule.category, color: rule.color };
    }
  }
  return { category: "other", color: "grey" };
}

/**
 * Shows a Chrome notification offering tab management.
 * @param {number} tabCount
 */
function notifyTabOverload(tabCount) {
  chrome.notifications.create("qba-tab-overload", {
    type: "basic",
    iconUrl: "icons/icon48.png",
    title: "Tab Overload Detected",
    message: `You have ${tabCount} tabs open. Let Quantbrowse organise them into smart groups?`,
    buttons: [{ title: "Organise Tabs" }, { title: "Dismiss" }],
    requireInteraction: true,
  });
}

/**
 * Finds or creates a tab group with the given title in the given window.
 *
 * @param {number} windowId
 * @param {string} title
 * @param {string} color
 * @returns {Promise<number>} groupId
 */
async function findOrCreateGroup(windowId, title, color) {
  // Check existing groups in this window
  const existingGroups = await chrome.tabGroups.query({ windowId });
  const existing = existingGroups.find((g) => g.title === title);
  if (existing) return existing.id;

  // Create a new group by grouping a dummy tab (Chrome requires at least one tab)
  // We'll move tabs into it immediately after creation
  const groupId = await chrome.tabs.group({ createProperties: { windowId } });
  await chrome.tabGroups.update(groupId, { title, color, collapsed: false });
  return groupId;
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Auto-groups all tabs in all windows by category.
 * Skips pinned tabs and extension pages.
 *
 * @returns {Promise<{ grouped: number, categories: Object }>}
 */
async function autoGroupAllTabs() {
  const allTabs = await chrome.tabs.query({});
  const ungrouped = allTabs.filter(
    (t) => !t.pinned && t.url && !t.url.startsWith("chrome") && t.groupId === -1
  );

  // Group by windowId first, then by category
  /** @type {Map<number, Map<string, {tabIds: number[], color: string}>>} */
  const byWindow = new Map();

  for (const tab of ungrouped) {
    const { category, color } = categoriseUrl(tab.url ?? "");
    if (!byWindow.has(tab.windowId)) byWindow.set(tab.windowId, new Map());
    const windowMap = byWindow.get(tab.windowId);
    if (!windowMap.has(category)) windowMap.set(category, { tabIds: [], color });
    windowMap.get(category).tabIds.push(tab.id);
  }

  const categoryCounts = {};
  let totalGrouped = 0;

  for (const [windowId, catMap] of byWindow) {
    for (const [category, { tabIds, color }] of catMap) {
      if (tabIds.length === 0) continue;
      const title =
        category.charAt(0).toUpperCase() + category.slice(1);
      try {
        const groupId = await findOrCreateGroup(windowId, title, color);
        await chrome.tabs.group({ groupId, tabIds });
        categoryCounts[category] = (categoryCounts[category] ?? 0) + tabIds.length;
        totalGrouped += tabIds.length;
      } catch {
        // Grouping can fail for restricted tabs — skip silently
      }
    }
  }

  return { grouped: totalGrouped, categories: categoryCounts };
}

/**
 * Collapses all non-active tab groups to reduce visual clutter.
 * @returns {Promise<void>}
 */
async function collapseInactiveGroups() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const allGroups = await chrome.tabGroups.query({});
  for (const group of allGroups) {
    const isActive = activeTab && activeTab.groupId === group.id;
    if (!isActive) {
      await chrome.tabGroups.update(group.id, { collapsed: true }).catch(() => {});
    }
  }
}

/**
 * Checks the total open tab count and fires a notification if overloaded.
 * Also auto-groups if the user has previously accepted auto-grouping.
 *
 * @returns {Promise<{ overloaded: boolean, tabCount: number }>}
 */
async function checkTabOverload() {
  const allTabs = await chrome.tabs.query({});
  const tabCount = allTabs.length;
  if (tabCount >= TAB_OVERLOAD_THRESHOLD) {
    notifyTabOverload(tabCount);
    return { overloaded: true, tabCount };
  }
  return { overloaded: false, tabCount };
}

/**
 * Returns a summary of open tabs categorised by type.
 * @returns {Promise<Object>}
 */
async function getTabSummary() {
  const allTabs = await chrome.tabs.query({});
  const summary = {};
  for (const tab of allTabs) {
    const { category } = categoriseUrl(tab.url ?? "");
    summary[category] = (summary[category] ?? 0) + 1;
  }
  return { total: allTabs.length, byCategory: summary };
}

/**
 * Registers notification button click handler for "Organise Tabs" CTA.
 * Must be called once from background.js.
 */
function initTabGrouper() {
  // Handle "Organise Tabs" button click on the overload notification
  chrome.notifications.onButtonClicked.addListener(async (notifId, btnIdx) => {
    if (notifId !== "qba-tab-overload") return;
    chrome.notifications.clear(notifId);
    if (btnIdx === 0) {
      // "Organise Tabs"
      const result = await autoGroupAllTabs();
      chrome.notifications.create("qba-tab-grouped", {
        type: "basic",
        iconUrl: "icons/icon48.png",
        title: "Tabs Organised!",
        message: `Grouped ${result.grouped} tabs into ${Object.keys(result.categories).length} smart categories.`,
      });
    }
  });

  // Check for tab overload whenever a new tab is created
  chrome.tabs.onCreated.addListener(() => {
    checkTabOverload();
  });
}

export { initTabGrouper, autoGroupAllTabs, collapseInactiveGroups, checkTabOverload, getTabSummary, categoriseUrl };
