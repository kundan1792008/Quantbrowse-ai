/**
 * background.js — Quantbrowse Ambient Intelligence & OS Shell Service Worker
 *
 * Handles usage tracking, smart tab grouping, daily digests, surprise AI
 * bookmarks, productivity scoring, and ecosystem redirect nudges. Also manages
 * the SwarmCoordinator, cross-tab relay, and AI command orchestration.
 */

const DEFAULT_API_BASE_URL = "http://localhost:3000";
const STORAGE_VERSION = 1;
const NOTIFICATION_ICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAZUlEQVR42u3QQREAAAQAMF3d6S8BOZw9VmCR1fNZCBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAfctS5+Shk5p5qQAAAAASUVORK5CYII=";
const MAX_SURPRISE_CHANCE = 0.85;

// ─── SwarmCoordinator ──────────────────────────────────────────────────────

/**
 * In-memory coordinator for all agent tasks spawned across tabs.
 *
 * Design goals:
 *  - O(1) enqueue / update / get via Map
 *  - Bounded memory: evicts oldest completed task when MAX_TASKS is reached
 *  - Immutable task IDs — callers can always query a past task by id
 *
 * @typedef {{ id: string, tabId: number, prompt: string,
 *             status: "pending"|"running"|"complete"|"failed",
 *             result: string|null, error: string|null,
 *             createdAt: number, updatedAt: number }} AgentTask
 */
class SwarmCoordinator {
  static MAX_TASKS = 1000; // Cap to bound memory; linear eviction is acceptable at this size.

  /** @type {Map<string, AgentTask>} */
  #tasks = new Map();

  /** Auto-incrementing counter for unique task IDs. */
  #counter = 0;

  /**
   * Adds a new task to the swarm queue.
   * Evicts the oldest completed/failed task if the queue is full.
   *
   * @param {number} tabId   Originating Chrome tab ID
   * @param {string} prompt  User's natural-language command
   * @returns {AgentTask}
   */
  enqueue(tabId, prompt) {
    if (this.#tasks.size >= SwarmCoordinator.MAX_TASKS) {
      this.#evictOldestCompleted();
    }

    const id = `task-${++this.#counter}`;
    const now = Date.now();

    /** @type {AgentTask} */
    const task = {
      id,
      tabId,
      prompt,
      status: "pending",
      result: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };

    this.#tasks.set(id, task);
    return task;
  }

  /**
   * Updates the status (and optional fields) of an existing task.
   *
   * @param {string} id
   * @param {"running"|"complete"|"failed"} status
   * @param {Partial<AgentTask>} [patch]
   */
  update(id, status, patch = {}) {
    const task = this.#tasks.get(id);
    if (!task) return;
    Object.assign(task, { status, updatedAt: Date.now(), ...patch });
  }

  /**
   * Retrieves a task by its ID.
   * @param {string} id
   * @returns {AgentTask|undefined}
   */
  get(id) {
    return this.#tasks.get(id);
  }

  /**
   * Returns a summary of the swarm's current state.
   * @returns {{ total: number, pending: number, running: number, complete: number, failed: number }}
   */
  stats() {
    let pending = 0;
    let running = 0;
    let complete = 0;
    let failed = 0;
    for (const task of this.#tasks.values()) {
      if (task.status === "pending") pending += 1;
      else if (task.status === "running") running += 1;
      else if (task.status === "complete") complete += 1;
      else failed += 1;
    }
    return { total: this.#tasks.size, pending, running, complete, failed };
  }

  /** Removes the single oldest completed/failed task to free one slot. */
  #evictOldestCompleted() {
    // Linear scan is sufficient given the MAX_TASKS bound.
    let oldest = null;
    for (const task of this.#tasks.values()) {
      if (task.status !== "complete" && task.status !== "failed") continue;
      if (!oldest || task.createdAt < oldest.createdAt) oldest = task;
    }
    if (oldest) this.#tasks.delete(oldest.id);
  }
}

const swarm = new SwarmCoordinator();

// ─── Cross-Tab Message Bus ─────────────────────────────────────────────────

/**
 * Registry of tab IDs that have an active content script.
 * Tabs are added on REGISTER_TAB and removed when Chrome fires tabs.onRemoved.
 * @type {Set<number>}
 */
const activeTabs = new Set();

/**
 * Sends a message to every registered tab except the optional sender.
 * Stale tab IDs are silently removed from activeTabs.
 *
 * @param {object} payload
 * @param {number|null} [excludeTabId]
 * @returns {Promise<PromiseSettledResult[]>}
 */
async function broadcastToTabs(payload, excludeTabId = null) {
  const sends = [];
  for (const tabId of activeTabs) {
    if (tabId === excludeTabId) continue;
    sends.push(
      chrome.tabs.sendMessage(tabId, payload).catch(() => {
        activeTabs.delete(tabId);
      })
    );
  }
  return Promise.allSettled(sends);
}

const STORAGE_KEYS = {
  usage: "ambientUsage",
  session: "ambientSession",
  settings: "ambientSettings",
  nudges: "ambientNudges",
  rewards: "ambientRewards",
  dashboard: "ambientDashboard",
};

const DEFAULT_SETTINGS = {
  digestHour: 8,
  digestMinute: 0,
  digestWindowMinutes: 45,
  autoRedirectSeconds: 10,
  nudgeCooldownMinutes: 45,
  nudgeEnabled: true,
  nudgeOverlayStyle: "ambient",
  tabGroupingIntervalMinutes: 60,
  surpriseIntervalMinutes: 360,
  surpriseChance: 0.32,
  surpriseMinVisits: 2,
  focusStreakMinMinutes: 8,
  maxSessionsPerDay: 280,
  maxDomainSamples: 120,
  badgeEnabled: true,
  dashboardAutoOpenOnInstall: true,
  redirectTargets: {
    youtube: "https://quanttube.ai",
    reddit: "https://quantchat.ai",
  },
  dashboardDefaults: {
    showTopSites: true,
    showProductivity: true,
    showDigestPreview: true,
    showNudges: true,
  },
};

const PRODUCTIVITY_WEIGHTS = {
  productive: 1,
  neutral: 0.45,
  distracting: 0,
};

const PRODUCTIVITY_DOMAIN_RULES = {
  productive: [
    "docs.google.com",
    "calendar.google.com",
    "drive.google.com",
    "notion.so",
    "github.com",
    "gitlab.com",
    "bitbucket.org",
    "jira",
    "linear.app",
    "trello.com",
    "asana.com",
    "slack.com",
    "teams.microsoft.com",
    "outlook.office.com",
    "developer.mozilla.org",
    "stackoverflow.com",
    "stackexchange.com",
    "coursera.org",
    "edx.org",
    "khanacademy.org",
    "udemy.com",
    "pluralsight.com",
    "linkedin.com/learning",
    "openai.com",
    "chat.openai.com",
    "figma.com",
    "canva.com",
    "docs",
    "wiki",
    "readthedocs",
    "spring.io",
    "cloud.google.com",
    "console.aws.amazon.com",
    "portal.azure.com",
    "vercel.com",
    "netlify.com",
    "railway.app",
    "supabase.com",
    "heroku.com",
    "digitalocean.com",
    "atlassian.net",
    "miro.com",
    "airtable.com",
    "loom.com",
    "zoom.us",
    "meet.google.com",
    "docs.rust-lang.org",
    "pkg.go.dev",
    "developer.apple.com",
    "learn.microsoft.com",
    "developer.android.com",
    "codepen.io",
    "codesandbox.io",
    "replit.com",
    "leetcode.com",
    "hackerrank.com",
    "topcoder.com",
    "projecteuler.net",
    "overleaf.com",
    "arxiv.org",
    "medium.com/p/",
    "towardsdatascience.com",
    "analytics.google.com",
    "mixpanel.com",
    "datadoghq.com",
    "grafana.com",
    "newrelic.com",
    "notebook",
    "colab.research.google.com",
    "docs.microsoft.com",
    "coda.io",
    "quantbrowse.ai",
  ],
  neutral: [
    "news.ycombinator.com",
    "theverge.com",
    "nytimes.com",
    "wsj.com",
    "cnn.com",
    "bbc.com",
    "bloomberg.com",
    "reuters.com",
    "theguardian.com",
    "producthunt.com",
    "medium.com",
    "substack.com",
    "weather.com",
    "accuweather.com",
    "forecast",
    "maps.google.com",
    "wikipedia.org",
    "quora.com",
    "stackexchange.com",
    "reddit.com/r/learn",
    "amazon.com",
    "etsy.com",
    "ebay.com",
    "bestbuy.com",
    "apple.com",
    "store.google.com",
    "open.spotify.com",
    "music.youtube.com",
    "mail.google.com",
    "gmail.com",
    "proton.me",
    "icloud.com",
    "drive.google.com",
    "calendar.google.com",
    "notion.site",
    "pastebin.com",
    "gist.github.com",
    "imdb.com",
    "rottentomatoes.com",
    "tripadvisor.com",
    "airbnb.com",
    "booking.com",
    "expedia.com",
    "stripe.com",
    "paypal.com",
    "bank",
    "finance",
    "healthline.com",
    "mayoclinic.org",
    "spotify.com",
    "soundcloud.com",
    "bandcamp.com",
    "calendar",
    "docs",
    "news",
    "finance",
  ],
  distracting: [
    "youtube.com",
    "youtu.be",
    "reddit.com",
    "tiktok.com",
    "instagram.com",
    "facebook.com",
    "x.com",
    "twitter.com",
    "twitch.tv",
    "netflix.com",
    "hulu.com",
    "primevideo.com",
    "disneyplus.com",
    "hbomax.com",
    "pinterest.com",
    "snapchat.com",
    "imgur.com",
    "9gag.com",
    "buzzfeed.com",
    "dailymotion.com",
    "vimeo.com",
    "games",
    "gaming",
    "steamcommunity.com",
    "steampowered.com",
    "epicgames.com",
    "riotgames.com",
    "miniclip.com",
    "crazygames.com",
    "roblox.com",
    "fortnite.com",
    "leagueoflegends.com",
    "giphy.com",
    "spotify.com",
    "soundcloud.com",
    "youtube.com/shorts",
    "reddit.com/r/all",
    "reddit.com/r/funny",
    "reddit.com/r/memes",
    "reddit.com/r/gaming",
    "reddit.com/r/videos",
    "tumblr.com",
    "discord.com",
    "messenger.com",
    "whatsapp.com",
    "telegram.org",
    "snapchat.com",
    "weibo.com",
    "vk.com",
    "baidu.com",
    "bilibili.com",
    "douyin.com",
    "live",
  ],
};

const GROUPING_INTENTS = [
  {
    id: "research",
    title: "Research",
    color: "blue",
    keywords: [
      "paper",
      "research",
      "docs",
      "documentation",
      "spec",
      "reference",
      "guide",
      "manual",
      "api",
      "sdk",
      "tutorial",
      "how to",
      "learn",
      "course",
      "lecture",
      "notebook",
      "dataset",
      "analysis",
      "report",
      "whitepaper",
      "arxiv",
      "journal",
      "wiki",
      "knowledge",
      "insight",
      "schema",
      "design",
      "architecture",
    ],
    domains: [
      "arxiv.org",
      "developer.mozilla.org",
      "readthedocs.io",
      "docs.microsoft.com",
      "docs.google.com",
      "openai.com",
      "coursera.org",
      "edx.org",
      "khanacademy.org",
      "udemy.com",
      "pluralsight.com",
      "wikipedia.org",
      "medium.com",
      "towardsdatascience.com",
    ],
  },
  {
    id: "communication",
    title: "Comms",
    color: "green",
    keywords: [
      "mail",
      "inbox",
      "meeting",
      "call",
      "chat",
      "message",
      "reply",
      "calendar",
      "invite",
      "zoom",
      "teams",
      "slack",
      "notion",
      "discord",
      "support",
      "ticket",
      "conversation",
      "schedule",
      "sync",
      "standup",
    ],
    domains: [
      "mail.google.com",
      "outlook.office.com",
      "calendar.google.com",
      "meet.google.com",
      "zoom.us",
      "teams.microsoft.com",
      "slack.com",
      "notion.so",
      "discord.com",
      "intercom.com",
      "zendesk.com",
    ],
  },
  {
    id: "build",
    title: "Build",
    color: "purple",
    keywords: [
      "repo",
      "pull request",
      "issue",
      "branch",
      "commit",
      "deploy",
      "build",
      "pipeline",
      "environment",
      "dashboard",
      "logs",
      "observability",
      "console",
      "analytics",
      "monitor",
      "trace",
      "metrics",
    ],
    domains: [
      "github.com",
      "gitlab.com",
      "bitbucket.org",
      "vercel.com",
      "netlify.com",
      "supabase.com",
      "railway.app",
      "console.aws.amazon.com",
      "portal.azure.com",
      "cloud.google.com",
      "datadoghq.com",
      "grafana.com",
      "newrelic.com",
    ],
  },
  {
    id: "design",
    title: "Design",
    color: "pink",
    keywords: [
      "design",
      "prototype",
      "wireframe",
      "figma",
      "ux",
      "ui",
      "style",
      "palette",
      "layout",
      "presentation",
      "deck",
      "brand",
      "asset",
      "illustration",
      "mockup",
      "storyboard",
    ],
    domains: [
      "figma.com",
      "canva.com",
      "dribbble.com",
      "behance.net",
      "adobe.com",
      "miro.com",
      "notion.site",
    ],
  },
  {
    id: "commerce",
    title: "Commerce",
    color: "orange",
    keywords: [
      "cart",
      "checkout",
      "order",
      "invoice",
      "shipment",
      "billing",
      "pricing",
      "purchase",
      "subscription",
      "store",
      "plan",
      "upgrade",
      "receipt",
    ],
    domains: [
      "amazon.com",
      "etsy.com",
      "ebay.com",
      "stripe.com",
      "paypal.com",
      "shopify.com",
      "bestbuy.com",
      "store.google.com",
      "apple.com",
    ],
  },
  {
    id: "entertainment",
    title: "Entertainment",
    color: "red",
    keywords: [
      "watch",
      "video",
      "stream",
      "meme",
      "funny",
      "gaming",
      "live",
      "highlights",
      "playlist",
      "twitch",
      "netflix",
      "reddit",
      "youtube",
      "tiktok",
      "reel",
      "clip",
      "viral",
      "music",
      "sound",
    ],
    domains: [
      "youtube.com",
      "youtu.be",
      "reddit.com",
      "tiktok.com",
      "instagram.com",
      "twitch.tv",
      "netflix.com",
      "hulu.com",
      "disneyplus.com",
      "spotify.com",
      "soundcloud.com",
    ],
  },
];

const NUDGE_TARGETS = [
  {
    id: "youtube",
    domains: ["youtube.com", "youtu.be"],
    target: "https://quanttube.ai",
    label: "Quanttube",
    tone: "Focus-forward video for deep work",
  },
  {
    id: "reddit",
    domains: ["reddit.com", "old.reddit.com", "new.reddit.com"],
    target: "https://quantchat.ai",
    label: "Quantchat",
    tone: "Curated knowledge threads without the doomscroll",
  },
];

const REWARD_MESSAGES = [
  "Surprise unlock: a knowledge gem bookmarked for later.",
  "Variable reward hit! We saved a high-signal page.",
  "AI bonus: an insight page was captured in your bookmarks.",
  "Focus bonus: we tucked away a meaningful resource.",
  "Momentum reward: new bookmark added to your Quantbrowse stash.",
  "Small win! We stored a page your future self will love.",
  "Signal boost: a high-value page is now bookmarked.",
  "Streak reward: one more curated page saved.",
  "Surprise drop: a smart bookmark is waiting.",
];

const state = {
  initialized: false,
  settings: null,
  usage: null,
  nudges: null,
  rewards: null,
  active: {
    tabId: null,
    windowId: null,
    url: "",
    domain: "",
    title: "",
    startTime: null,
    lastHeartbeat: null,
    isFocused: true,
  },
  pendingSave: null,
  lastBadgeScore: null,
  lastNudgeSent: new Map(),
};

let readyPromise = null;

bootstrap("boot");

chrome.runtime.onInstalled.addListener((details) => {
  bootstrap("install").then(() => handleInstall(details)).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  bootstrap("startup").catch(() => {});
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  withReady(() => handleTabActivated(activeInfo));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  withReady(() => handleTabUpdated(tabId, changeInfo, tab));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  activeTabs.delete(tabId);
  withReady(() => handleTabRemoved(tabId));
});

chrome.webNavigation.onCompleted.addListener(({ tabId, frameId }) => {
  if (frameId !== 0) return;
  activeTabs.add(tabId);
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  withReady(() => handleWindowFocusChanged(windowId));
});

chrome.idle.onStateChanged.addListener((newState) => {
  withReady(() => handleIdleStateChange(newState));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  withReady(() => handleAlarm(alarm));
});

chrome.commands.onCommand.addListener((command) => {
  withReady(() => handleCommand(command));
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type) return false;
  (async () => {
    await ensureReady();
    const response = await handleMessage(message, sender);
    sendResponse(response);
  })().catch((err) => {
    sendResponse({ success: false, error: String(err) });
  });
  return true;
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes[STORAGE_KEYS.settings]) {
    state.settings = changes[STORAGE_KEYS.settings].newValue;
  }
});

async function bootstrap(reason) {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    state.settings = await loadSettings();
    state.usage = await loadUsage();
    state.nudges = await loadNudges();
    state.rewards = await loadRewards();
    await ensureAlarms();
    await hydrateActiveSession();
    await refreshActiveTab();
    await updateBadge();
    state.initialized = true;
  })();
  return readyPromise;
}

async function ensureReady() {
  if (!readyPromise) {
    await bootstrap("lazy");
  }
  return readyPromise;
}

function withReady(fn) {
  ensureReady()
    .then(fn)
    .catch(() => {});
}

async function handleInstall(details) {
  if (details.reason === "install") {
    await chrome.storage.local.set({
      [STORAGE_KEYS.settings]: state.settings,
      [STORAGE_KEYS.usage]: state.usage,
      [STORAGE_KEYS.nudges]: state.nudges,
      [STORAGE_KEYS.rewards]: state.rewards,
    });
    if (state.settings.dashboardAutoOpenOnInstall) {
      await openDashboardForActiveTab();
    }
  }
}

async function loadSettings() {
  const stored = await storageGet(STORAGE_KEYS.settings);
  return {
    ...DEFAULT_SETTINGS,
    ...(stored ?? {}),
    dashboardDefaults: {
      ...DEFAULT_SETTINGS.dashboardDefaults,
      ...(stored?.dashboardDefaults ?? {}),
    },
    redirectTargets: {
      ...DEFAULT_SETTINGS.redirectTargets,
      ...(stored?.redirectTargets ?? {}),
    },
  };
}

async function loadUsage() {
  const stored = await storageGet(STORAGE_KEYS.usage);
  if (stored?.version === STORAGE_VERSION) return stored;
  return {
    version: STORAGE_VERSION,
    days: {},
    createdAt: Date.now(),
  };
}

async function loadNudges() {
  const stored = await storageGet(STORAGE_KEYS.nudges);
  return (
    stored ?? {
      totalShown: 0,
      totalAccepted: 0,
      totalDismissed: 0,
      byDomain: {},
      lastShownAt: 0,
    }
  );
}

async function loadRewards() {
  const stored = await storageGet(STORAGE_KEYS.rewards);
  return (
    stored ?? {
      totalRewards: 0,
      lastRewardAt: 0,
      bookmarks: [],
    }
  );
}

async function storageGet(key) {
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (data) => resolve(data?.[key]));
  });
}

async function storageSet(values) {
  return new Promise((resolve) => {
    chrome.storage.local.set(values, resolve);
  });
}

async function ensureAlarms() {
  const alarms = await chrome.alarms.getAll();
  const alarmNames = new Set(alarms.map((alarm) => alarm.name));
  if (!alarmNames.has("dailyDigest")) {
    const when = getNextDigestTime(state.settings);
    chrome.alarms.create("dailyDigest", {
      when,
      periodInMinutes: 1440,
    });
  }
  if (!alarmNames.has("surpriseReward")) {
    chrome.alarms.create("surpriseReward", {
      periodInMinutes: state.settings.surpriseIntervalMinutes,
    });
  }
  if (!alarmNames.has("tabGrouping")) {
    chrome.alarms.create("tabGrouping", {
      periodInMinutes: state.settings.tabGroupingIntervalMinutes,
    });
  }
  if (!alarmNames.has("usagePulse")) {
    chrome.alarms.create("usagePulse", { periodInMinutes: 1 });
  }
}

function getNextDigestTime(settings) {
  const now = new Date();
  const target = new Date();
  target.setHours(settings.digestHour, settings.digestMinute, 0, 0);
  if (target <= now) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime();
}

async function hydrateActiveSession() {
  const stored = await storageGet(STORAGE_KEYS.session);
  if (!stored?.tabId) return;
  state.active = {
    tabId: stored.tabId,
    windowId: stored.windowId ?? null,
    url: stored.url ?? "",
    domain: stored.domain ?? "",
    title: stored.title ?? "",
    startTime: stored.startTime ?? null,
    lastHeartbeat: stored.lastHeartbeat ?? null,
    isFocused: stored.isFocused ?? true,
  };
}

async function refreshActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  await startTracking(tab, "refresh");
}

async function handleTabActivated(activeInfo) {
  const tab = await chrome.tabs.get(activeInfo.tabId);
  await startTracking(tab, "activate");
}

async function handleTabUpdated(tabId, changeInfo, tab) {
  if (!tab?.active) return;
  if (changeInfo.status === "loading" || changeInfo.url || changeInfo.title) {
    await startTracking(tab, "updated");
  }
}

async function handleTabRemoved(tabId) {
  if (state.active.tabId === tabId) {
    await stopTracking("tab-closed");
  }
}

async function handleWindowFocusChanged(windowId) {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    state.active.isFocused = false;
    await stopTracking("window-blur");
    return;
  }
  state.active.isFocused = true;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    await startTracking(tab, "window-focus");
  }
}

async function handleIdleStateChange(newState) {
  if (newState === "idle" || newState === "locked") {
    await stopTracking("idle");
  } else if (newState === "active") {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      await startTracking(tab, "idle-active");
    }
  }
}

async function handleAlarm(alarm) {
  switch (alarm.name) {
    case "dailyDigest":
      await sendDailyDigest();
      break;
    case "surpriseReward":
      await maybeCreateSurpriseBookmark("alarm");
      break;
    case "tabGrouping":
      await smartGroupTabs();
      break;
    case "usagePulse":
      await pulseUsage();
      break;
    default:
      break;
  }
}

async function handleCommand(command) {
  if (command === "toggle-dashboard") {
    await openDashboardForActiveTab();
  }
  if (command === "group-tabs") {
    await smartGroupTabs(true);
  }
  if (command === "trigger-digest") {
    await sendDailyDigest(true);
  }
}

async function handleMessage(message, sender) {
  switch (message.type) {
    case "REGISTER_TAB": {
      const senderTabId = sender?.tab?.id ?? null;
      if (senderTabId !== null) activeTabs.add(senderTabId);
      return { success: true, tabId: senderTabId };
    }
    case "RUN_AI_COMMAND":
      return handleAiCommand(message);
    case "RELAY_TO_TABS": {
      const senderTabId = sender?.tab?.id ?? null;
      await broadcastToTabs(
        { type: "SWARM_BROADCAST", payload: message.payload },
        senderTabId
      );
      return { success: true };
    }
    case "SWARM_STATS":
      return { success: true, stats: swarm.stats() };
    case "TASK_STATUS": {
      const task = swarm.get(message.taskId);
      return task
        ? { success: true, task }
        : { success: false, error: "Task not found." };
    }
    case "PAGE_HEARTBEAT":
      return handlePageHeartbeat(message, sender);
    case "REQUEST_DASHBOARD":
      return { success: true, dashboard: buildDashboardPayload() };
    case "TRIGGER_GROUP_TABS":
      await smartGroupTabs(true);
      return { success: true };
    case "TRIGGER_DIGEST":
      await sendDailyDigest(true);
      return { success: true };
    case "REQUEST_NUDGE_SETTINGS":
      return { success: true, nudge: buildNudgeSettings(message.url) };
    case "NUDGE_EVENT":
      await recordNudgeEvent(message.event, message.domain);
      return { success: true };
    case "SURPRISE_BOOKMARK":
      await maybeCreateSurpriseBookmark("manual");
      return { success: true };
    case "SETTINGS_UPDATE":
      await updateSettings(message.settings);
      return { success: true };
    case "REQUEST_USAGE_EXPORT":
      return { success: true, usage: state.usage };
    default:
      return { success: false, error: "Unknown message type." };
  }
}

async function handleAiCommand(message) {
  const { prompt } = message;
  if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
    return { success: false, error: "A non-empty prompt is required." };
  }
  if (prompt.length > 2000) {
    return { success: false, error: "Prompt exceeds the 2,000-character limit." };
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    return { success: false, error: "No active tab found." };
  }

  activeTabs.add(tab.id);
  const task = swarm.enqueue(tab.id, prompt.trim());
  swarm.update(task.id, "running");

  try {
    const domContent = await getDomContent(tab.id);
    const apiBaseUrl = await getApiBaseUrl();
    const response = await fetch(`${apiBaseUrl}/api/browse`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: prompt.trim(), domContent }),
    });

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      const error = errBody?.error ?? `Server error: ${response.status}`;
      swarm.update(task.id, "failed", { error });
      return { success: false, error };
    }

    const data = await response.json();
    swarm.update(task.id, "complete", { result: data.result });

    await broadcastToTabs(
      {
        type: "SWARM_BROADCAST",
        payload: { event: "task_complete", taskId: task.id },
      },
      tab.id
    );

    return { success: true, result: data.result, taskId: task.id };
  } catch (err) {
    const error = String(err);
    swarm.update(task.id, "failed", { error });
    return { success: false, error };
  }
}

async function getApiBaseUrl() {
  const stored = await storageGet("apiBaseUrl");
  if (typeof stored === "string" && stored.trim()) {
    return stored.trim();
  }
  return DEFAULT_API_BASE_URL;
}

/**
 * Attempts to retrieve the page's visible text from the content script.
 * If the content script is not yet injected, injects it and retries once.
 *
 * @param {number} tabId
 * @returns {Promise<string>}
 */
async function getDomContent(tabId) {
  try {
    const domResponse = await sendMessageToTab(tabId, { type: "EXTRACT_DOM" });
    if (domResponse?.success) {
      return domResponse.domContent ?? "";
    }
  } catch {
    // Content script not running — fall through to injection
  }

  return injectAndExtractDom(tabId);
}

async function injectAndExtractDom(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
    const domResponse = await sendMessageToTab(tabId, { type: "EXTRACT_DOM" });
    return domResponse?.domContent ?? "";
  } catch {
    return "";
  }
}

async function sendMessageToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
        return;
      }
      resolve(response);
    });
  });
}

async function startTracking(tab, reason) {
  if (!tab?.id) return;
  const url = tab.url ?? "";
  if (!isTrackableUrl(url)) {
    await stopTracking("untrackable");
    return;
  }

  if (state.active.tabId === tab.id && state.active.url === url) {
    return;
  }

  await stopTracking(reason);
  const now = Date.now();
  const domain = extractDomain(url);
  state.active = {
    tabId: tab.id,
    windowId: tab.windowId ?? null,
    url,
    domain,
    title: tab.title ?? "",
    startTime: now,
    lastHeartbeat: now,
    isFocused: true,
  };

  await storageSet({
    [STORAGE_KEYS.session]: {
      tabId: tab.id,
      windowId: tab.windowId ?? null,
      url,
      domain,
      title: tab.title ?? "",
      startTime: now,
      lastHeartbeat: now,
      isFocused: true,
    },
  });
}

async function stopTracking(reason) {
  if (!state.active.tabId || !state.active.startTime) return;
  const now = Date.now();
  const duration = Math.max(0, now - state.active.startTime);
  if (duration > 1000 && state.active.domain) {
    recordUsage(
      state.active.domain,
      state.active.url,
      state.active.title,
      duration,
      state.active.startTime,
      now
    );
  }
  state.active.startTime = null;
  state.active.lastHeartbeat = null;
  await storageSet({ [STORAGE_KEYS.session]: null });
  if (reason === "untrackable") {
    state.active.tabId = null;
    state.active.url = "";
    state.active.domain = "";
    state.active.title = "";
  }
  await scheduleSave();
  await updateBadge();
}

function recordUsage(domain, url, title, durationMs, start, end) {
  const dayKey = getDayKey(new Date(end));
  if (!state.usage.days[dayKey]) {
    state.usage.days[dayKey] = createEmptyDay(dayKey);
  }
  const day = state.usage.days[dayKey];
  const category = categorizeDomain(domain, url, title);
  day.totalMs += durationMs;
  day.categoryTotals[category] += durationMs;
  day.lastUpdated = end;

  if (!day.domains[domain]) {
    day.domains[domain] = createEmptyDomain(domain, category);
  }
  const domainEntry = day.domains[domain];
  domainEntry.ms += durationMs;
  domainEntry.visits += 1;
  domainEntry.lastUrl = url;
  domainEntry.lastTitle = title;
  domainEntry.category = category;
  domainEntry.lastVisited = end;

  if (day.sessions.length >= state.settings.maxSessionsPerDay) {
    // Keep the most recent sessions only to cap storage size per day.
    day.sessions.shift();
  }
  day.sessions.push({
    start,
    end,
    durationMs,
    domain,
    url,
    title,
    category,
  });
}

function createEmptyDay(dayKey) {
  return {
    dayKey,
    totalMs: 0,
    lastUpdated: Date.now(),
    categoryTotals: {
      productive: 0,
      neutral: 0,
      distracting: 0,
    },
    domains: {},
    sessions: [],
  };
}

function createEmptyDomain(domain, category) {
  return {
    domain,
    ms: 0,
    visits: 0,
    category,
    lastUrl: "",
    lastTitle: "",
    lastVisited: 0,
  };
}

function categorizeDomain(domain, url, title) {
  if (!domain) return "neutral";
  const lowerDomain = domain.toLowerCase();
  const combined = `${lowerDomain} ${url ?? ""} ${title ?? ""}`.toLowerCase();
  if (matchesRule(combined, PRODUCTIVITY_DOMAIN_RULES.distracting)) {
    return "distracting";
  }
  if (matchesRule(combined, PRODUCTIVITY_DOMAIN_RULES.productive)) {
    return "productive";
  }
  if (matchesRule(combined, PRODUCTIVITY_DOMAIN_RULES.neutral)) {
    return "neutral";
  }
  return "neutral";
}

function matchesRule(text, rules) {
  return rules.some((rule) => text.includes(rule));
}

function getDayKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function buildDashboardPayload() {
  const todayKey = getDayKey(new Date());
  const today = state.usage.days[todayKey] ?? createEmptyDay(todayKey);
  const weekKeys = getRecentDayKeys(7);
  const weekDays = weekKeys.map((key) => state.usage.days[key]).filter(Boolean);
  const topDomains = getTopDomains(today, 8);
  const weekTotals = summarizeDays(weekDays);
  const productivityScore = computeProductivityScore(today);
  const weekScore = computeProductivityScore(weekTotals);
  const focusStreak = computeFocusStreak(today.sessions);
  const digestPreview = buildDigestMessage(todayKey, today, true);

  return {
    todayKey,
    todayTotal: today.totalMs,
    todayDomains: topDomains,
    weekTotal: weekTotals.totalMs,
    weekDomains: getTopDomains(weekTotals, 6),
    productivityScore,
    weekScore,
    focusStreak,
    nudges: state.nudges,
    rewards: state.rewards,
    digestPreview,
  };
}

function getRecentDayKeys(count) {
  const keys = [];
  const now = new Date();
  for (let i = 0; i < count; i += 1) {
    const date = new Date(now);
    date.setDate(now.getDate() - i);
    keys.push(getDayKey(date));
  }
  return keys;
}

function summarizeDays(days) {
  const aggregate = createEmptyDay("summary");
  for (const day of days) {
    aggregate.totalMs += day.totalMs;
    aggregate.categoryTotals.productive += day.categoryTotals.productive;
    aggregate.categoryTotals.neutral += day.categoryTotals.neutral;
    aggregate.categoryTotals.distracting += day.categoryTotals.distracting;
    for (const [domain, entry] of Object.entries(day.domains)) {
      if (!aggregate.domains[domain]) {
        aggregate.domains[domain] = createEmptyDomain(domain, entry.category);
      }
      aggregate.domains[domain].ms += entry.ms;
      aggregate.domains[domain].visits += entry.visits;
      aggregate.domains[domain].lastUrl = entry.lastUrl;
      aggregate.domains[domain].lastTitle = entry.lastTitle;
      aggregate.domains[domain].category = entry.category;
      aggregate.domains[domain].lastVisited = Math.max(
        aggregate.domains[domain].lastVisited,
        entry.lastVisited
      );
    }
  }
  return aggregate;
}

function getTopDomains(day, limit) {
  return Object.values(day.domains)
    .sort((a, b) => b.ms - a.ms)
    .slice(0, limit)
    .map((entry) => ({
      domain: entry.domain,
      ms: entry.ms,
      visits: entry.visits,
      category: entry.category,
      lastTitle: entry.lastTitle,
      lastUrl: entry.lastUrl,
    }));
}

function computeProductivityScore(day) {
  if (!day?.totalMs) return 0;
  const weighted =
    day.categoryTotals.productive * PRODUCTIVITY_WEIGHTS.productive +
    day.categoryTotals.neutral * PRODUCTIVITY_WEIGHTS.neutral +
    day.categoryTotals.distracting * PRODUCTIVITY_WEIGHTS.distracting;
  const ratio = weighted / Math.max(day.totalMs, 1);
  return Math.round(clamp(ratio * 100, 0, 100));
}

function computeFocusStreak(sessions) {
  if (!sessions?.length) {
    return { currentMinutes: 0, longestMinutes: 0 };
  }
  const sorted = [...sessions].sort((a, b) => a.start - b.start);
  let current = 0;
  let longest = 0;
  let running = 0;
  for (const session of sorted) {
    if (session.category === "productive") {
      running += session.durationMs;
      longest = Math.max(longest, running);
    } else {
      running = 0;
    }
  }
  current = running;
  return {
    currentMinutes: Math.round(current / 60000),
    longestMinutes: Math.round(longest / 60000),
  };
}

async function scheduleSave() {
  if (state.pendingSave) {
    clearTimeout(state.pendingSave);
  }
  state.pendingSave = setTimeout(async () => {
    state.pendingSave = null;
    await storageSet({ [STORAGE_KEYS.usage]: state.usage });
  }, 2000);
}

async function updateBadge() {
  if (!state.settings.badgeEnabled) return;
  const todayKey = getDayKey(new Date());
  const today = state.usage.days[todayKey] ?? createEmptyDay(todayKey);
  const score = computeProductivityScore(today);
  if (state.lastBadgeScore === score) return;
  state.lastBadgeScore = score;
  const badgeText = score ? `${score}` : "";
  chrome.action.setBadgeText({ text: badgeText });
  chrome.action.setBadgeBackgroundColor({
    color: score >= 70 ? "#22c55e" : score >= 40 ? "#f59e0b" : "#ef4444",
  });
}

async function handlePageHeartbeat(message, sender) {
  if (!sender?.tab?.id) return { success: true };
  const now = Date.now();
  state.active.lastHeartbeat = now;
  if (sender.tab.active) {
    state.active.title = message.title ?? sender.tab.title ?? state.active.title;
    state.active.url = message.url ?? sender.tab.url ?? state.active.url;
    state.active.domain = extractDomain(state.active.url);
    if (!state.active.startTime) {
      state.active.startTime = now;
    }
  }
  await storageSet({
    [STORAGE_KEYS.session]: {
      tabId: sender.tab.id,
      windowId: sender.tab.windowId ?? null,
      url: state.active.url,
      domain: state.active.domain,
      title: state.active.title,
      startTime: state.active.startTime,
      lastHeartbeat: now,
      isFocused: state.active.isFocused,
    },
  });
  return { success: true };
}

async function pulseUsage() {
  if (!state.active.startTime || !state.active.domain) return;
  const now = Date.now();
  const duration = now - state.active.startTime;
  if (duration < 60000) return;
  recordUsage(
    state.active.domain,
    state.active.url,
    state.active.title,
    duration,
    state.active.startTime,
    now
  );
  state.active.startTime = now;
  await scheduleSave();
  await updateBadge();
}

async function sendDailyDigest(isManual = false) {
  const todayKey = getDayKey(new Date());
  const today = state.usage.days[todayKey] ?? createEmptyDay(todayKey);
  const message = buildDigestMessage(todayKey, today, false);
  if (!message) return;
  await createNotification("Quantbrowse Daily Digest", message);
}

function buildDigestMessage(dayKey, day, concise) {
  if (!day.totalMs && !concise) {
    return "Quiet start today. Let’s set a focused intention for the next session.";
  }
  const topDomains = getTopDomains(day, 3);
  const totalText = formatDuration(day.totalMs);
  const score = computeProductivityScore(day);
  const focus = computeFocusStreak(day.sessions);
  const topText = topDomains
    .map((entry) => `${entry.domain} (${formatDuration(entry.ms)})`)
    .join(", ");

  if (concise) {
    return {
      headline: `Today • ${totalText} • Score ${score}`,
      topSites: topDomains,
      focus,
    };
  }

  return [
    `Total focus time: ${totalText}`,
    `Productivity score: ${score}/100`,
    focus.longestMinutes
      ? `Longest focus streak: ${focus.longestMinutes} min`
      : "Build a focus streak by staying on productive sites.",
    topText ? `Top sites: ${topText}` : "No top sites yet — start browsing mindfully.",
    "Tap the Quantbrowse dashboard for deeper insights.",
  ].join("\n");
}

async function createNotification(title, message) {
  return chrome.notifications.create({
    type: "basic",
    iconUrl: NOTIFICATION_ICON,
    title,
    message,
  });
}

async function maybeCreateSurpriseBookmark(source) {
  const todayKey = getDayKey(new Date());
  const today = state.usage.days[todayKey] ?? createEmptyDay(todayKey);
  const score = computeProductivityScore(today);
  const chanceBoost = score >= 70 ? 0.18 : score >= 50 ? 0.08 : 0;
  const chance = Math.min(MAX_SURPRISE_CHANCE, state.settings.surpriseChance + chanceBoost);
  if (Math.random() > chance) return;

  const candidates = Object.values(today.domains)
    .filter((entry) => entry.visits >= state.settings.surpriseMinVisits)
    .sort((a, b) => b.ms - a.ms)
    .slice(0, state.settings.maxDomainSamples);

  if (!candidates.length) return;

  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  const bookmarkUrl = pick.lastUrl || `https://${pick.domain}`;
  const rewardTitle = `AI Surprise: ${pick.lastTitle || pick.domain}`;

  if (state.rewards.bookmarks.some((entry) => entry.url === bookmarkUrl)) {
    return;
  }

  const folderId = await ensureBookmarkFolder();
  await chrome.bookmarks.create({ parentId: folderId, title: rewardTitle, url: bookmarkUrl });

  state.rewards.totalRewards += 1;
  state.rewards.lastRewardAt = Date.now();
  state.rewards.bookmarks.push({
    url: bookmarkUrl,
    title: rewardTitle,
    domain: pick.domain,
    createdAt: Date.now(),
    source,
  });

  await storageSet({ [STORAGE_KEYS.rewards]: state.rewards });
  await createNotification("Surprise AI Bookmark", randomChoice(REWARD_MESSAGES));
}

async function ensureBookmarkFolder() {
  const folderTitle = "Quantbrowse AI Surprises";
  const tree = await chrome.bookmarks.search({ title: folderTitle });
  const existing = tree.find((item) => item.title === folderTitle && !item.url);
  if (existing) return existing.id;
  const created = await chrome.bookmarks.create({ title: folderTitle });
  return created.id;
}

async function smartGroupTabs(force = false) {
  const window = await chrome.windows.getCurrent({ populate: true });
  if (!window?.tabs?.length) return;

  const tabs = window.tabs.filter((tab) => tab.url && !tab.pinned);
  if (tabs.length < 3 && !force) return;

  const groups = buildTabGroups(tabs);
  for (const group of groups) {
    if (group.tabIds.length < 2 && !force) continue;
    try {
      const groupId = await chrome.tabs.group({ tabIds: group.tabIds });
      await chrome.tabGroups.update(groupId, {
        title: group.title,
        color: group.color,
      });
    } catch {
      // Ignore grouping errors for restricted tabs.
    }
  }
}

function buildTabGroups(tabs) {
  const groups = new Map();
  for (const tab of tabs) {
    const suggestion = scoreTabForGrouping(tab);
    const key = suggestion.key;
    if (!groups.has(key)) {
      groups.set(key, {
        title: suggestion.title,
        color: suggestion.color,
        tabIds: [],
      });
    }
    groups.get(key).tabIds.push(tab.id);
  }
  return Array.from(groups.values());
}

function scoreTabForGrouping(tab) {
  const url = tab.url ?? "";
  const domain = extractDomain(url);
  const title = (tab.title ?? "").toLowerCase();
  const combined = `${domain} ${title} ${url}`.toLowerCase();

  let bestScore = 0;
  let bestIntent = GROUPING_INTENTS[0];
  for (const intent of GROUPING_INTENTS) {
    let score = 0;
    for (const keyword of intent.keywords) {
      if (combined.includes(keyword)) score += 2;
    }
    for (const entry of intent.domains) {
      if (combined.includes(entry)) score += 3;
    }
    if (score > bestScore) {
      bestScore = score;
      bestIntent = intent;
    }
  }

  const fallbackTitle = domain ? toTitleCase(domain.replace(/\./g, " ")) : "Focus";
  if (bestScore === 0) {
    return {
      key: `site-${domain}`,
      title: fallbackTitle,
      color: "grey",
    };
  }

  return {
    key: `${bestIntent.id}-${domain || "general"}`,
    title: bestIntent.title,
    color: bestIntent.color,
  };
}

async function openDashboardForActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  try {
    await sendMessageToTab(tab.id, { type: "SHOW_DASHBOARD" });
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content.js"],
      });
      await sendMessageToTab(tab.id, { type: "SHOW_DASHBOARD" });
    } catch {
      // Ignore if the tab is not eligible.
    }
  }
}

function buildNudgeSettings(url) {
  const domain = extractDomain(url);
  const target = findNudgeTarget(domain);
  if (!target) return null;
  if (!state.settings.nudgeEnabled) return null;
  const existing = state.nudges.byDomain[domain];
  if (existing?.lastEventAt) {
    const cooldown = state.settings.nudgeCooldownMinutes * 60000;
    if (Date.now() - existing.lastEventAt < cooldown) return null;
  }
  const overrideTarget = state.settings.redirectTargets?.[target.id];
  return {
    domain,
    label: target.label,
    target: overrideTarget || target.target,
    tone: target.tone,
    autoRedirectSeconds: state.settings.autoRedirectSeconds,
    nudgeCooldownMinutes: state.settings.nudgeCooldownMinutes,
    style: state.settings.nudgeOverlayStyle,
  };
}

function findNudgeTarget(domain) {
  if (!domain) return null;
  return NUDGE_TARGETS.find((target) =>
    target.domains.some((entry) => domain.includes(entry))
  );
}

async function recordNudgeEvent(event, domain) {
  const safeDomain = domain || "unknown";
  state.nudges.byDomain[safeDomain] = state.nudges.byDomain[safeDomain] ?? {
    shown: 0,
    accepted: 0,
    dismissed: 0,
    lastEventAt: 0,
  };
  const entry = state.nudges.byDomain[safeDomain];
  entry.lastEventAt = Date.now();
  if (event === "shown") {
    state.nudges.totalShown += 1;
    entry.shown += 1;
  }
  if (event === "accepted") {
    state.nudges.totalAccepted += 1;
    entry.accepted += 1;
  }
  if (event === "dismissed") {
    state.nudges.totalDismissed += 1;
    entry.dismissed += 1;
  }
  state.nudges.lastShownAt = Date.now();
  await storageSet({ [STORAGE_KEYS.nudges]: state.nudges });
}

async function updateSettings(partial) {
  state.settings = {
    ...state.settings,
    ...partial,
    dashboardDefaults: {
      ...state.settings.dashboardDefaults,
      ...(partial?.dashboardDefaults ?? {}),
    },
    redirectTargets: {
      ...state.settings.redirectTargets,
      ...(partial?.redirectTargets ?? {}),
    },
  };
  await storageSet({ [STORAGE_KEYS.settings]: state.settings });
  await ensureAlarms();
}

function extractDomain(url) {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function isTrackableUrl(url) {
  return url.startsWith("http://") || url.startsWith("https://");
}

function formatDuration(ms) {
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours) {
    return `${hours}h ${minutes}m`;
  }
  return `${Math.max(minutes, 1)}m`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function toTitleCase(text) {
  return text
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function randomChoice(list) {
  return list[Math.floor(Math.random() * list.length)];
}
