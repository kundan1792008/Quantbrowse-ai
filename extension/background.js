/**
 * background.js — Quantbrowse Ambient Intelligence & OS Shell Service Worker
 *
 * Handles usage tracking, smart tab grouping, daily digests, surprise AI
 * bookmarks, productivity scoring, and ecosystem redirect nudges. Also manages
 * the SwarmCoordinator, cross-tab relay, and AI command orchestration.
 */

import { ContentClipper } from "./clipper/clipper.js";
import { StorageService } from "./clipper/storage.js";
import { GemmaTagger } from "./clipper/tagger.js";
import { UniversalSaver } from "./clipper/saver.js";

const DEFAULT_API_BASE_URL = "http://localhost:3000";
const CLIPPER_ALARM = "qba_flush_queue";
const CONTEXT_MENU_IDS = {
  SAVE_PAGE: "qba_save_page",
  SAVE_SELECTION: "qba_save_selection",
  SAVE_LINK: "qba_save_link",
  SAVE_IMAGE: "qba_save_image",
};
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
  static MAX_TASKS = 200; // Cap to bound memory; keeps eviction work small.

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
      else if (task.status === "failed") failed += 1;
      else {
        failed += 1;
        console.warn("Quantbrowse: unexpected task status", task.status);
      }
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
const storage = new StorageService();
const tagger = new GemmaTagger();
const saver = new UniversalSaver({ storage, tagger, getApiBaseUrl });
const clipper = new ContentClipper({ storage });

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
    case "CAPTURE_SCREENSHOT": {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.windowId) {
          return { success: false, error: "No active window found." };
        }
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });

        if (message.region && tab?.id) {
          const { x, y, width, height } = message.region;
          const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (src, cx, cy, cw, ch) => {
              return new Promise((resolve) => {
                const img = new Image();
                img.onload = () => {
                  const canvas = document.createElement("canvas");
                  const dpr = window.devicePixelRatio || 1;
                  canvas.width = Math.round(cw * dpr);
                  canvas.height = Math.round(ch * dpr);
                  const ctx = canvas.getContext("2d");
                  if (ctx) {
                    ctx.drawImage(
                      img,
                      cx * dpr, cy * dpr, cw * dpr, ch * dpr,
                      0, 0, canvas.width, canvas.height
                    );
                  }
                  resolve(canvas.toDataURL("image/png"));
                };
                img.src = src;
              });
            },
            args: [dataUrl, x, y, width, height],
          });
          const croppedUrl = results?.[0]?.result;
          return { success: true, dataUrl: croppedUrl || dataUrl };
        }
        return { success: true, dataUrl };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    }
    case "SAVE_CLIP": {
      try {
        const clip = message.clip;
        if (!clip) {
          return { success: false, error: "No clip payload provided." };
        }
        const apiBaseUrl = await getApiBaseUrl();
        const tags = await autoTagClip(clip, apiBaseUrl);
        const savedItem = await persistClip(clip, tags);
        const result = await trySaveToApi(savedItem, apiBaseUrl);
        return {
          success: true,
          item: result.item,
          app: result.item.app,
          isDuplicate: result.isDuplicate,
        };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    }
    case "SYNC_QUEUE": {
      try {
        const apiBaseUrl = await getApiBaseUrl();
        const result = await syncOfflineQueue(apiBaseUrl);
        return { success: true, ...result };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    }
    case "GET_SAVED_ITEMS": {
      try {
        const items = await getSavedItems();
        return { success: true, items };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    }
    case "DELETE_SAVED_ITEM": {
      try {
        await deleteSavedItem(message.itemId);
        return { success: true };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    }
    case "GET_COLLECTIONS": {
      try {
        const collections = await getCollections();
        return { success: true, collections };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    }
    case "SAVE_COLLECTIONS": {
      try {
        await chrome.storage.local.set({ qba_collections: message.collections });
        return { success: true };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    }
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

// ─── Universal Clipper Setup ────────────────────────────────────────────────

async function ensureClipperReady() {
  await storage.ensureSchema();
  await setupClipperContextMenus();
  scheduleQueueFlush();
}

function scheduleQueueFlush() {
  chrome.alarms.create(CLIPPER_ALARM, { periodInMinutes: 5 });
}

chrome.runtime.onInstalled.addListener(() => {
  ensureClipperReady();
});

chrome.runtime.onStartup.addListener(() => {
  ensureClipperReady();
});

ensureClipperReady();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== CLIPPER_ALARM) return;
  saver.flushQueue().catch((error) => {
    console.warn("Queue flush failed:", error);
  });
});

function setupClipperContextMenus() {
  return new Promise((resolve) => {
    // Note: do not call removeAll() here to avoid wiping menu items
    // registered by the existing context-menu setup further below.
    try {
      chrome.contextMenus.create({
        id: CONTEXT_MENU_IDS.SAVE_PAGE,
        title: "Save page to Quantbrowse",
        contexts: ["page", "frame"],
      }, () => void chrome.runtime.lastError);
      chrome.contextMenus.create({
        id: CONTEXT_MENU_IDS.SAVE_SELECTION,
        title: "Save selection to Quantbrowse",
        contexts: ["selection"],
      }, () => void chrome.runtime.lastError);
      chrome.contextMenus.create({
        id: CONTEXT_MENU_IDS.SAVE_LINK,
        title: "Save link to Quantbrowse",
        contexts: ["link"],
      }, () => void chrome.runtime.lastError);
      chrome.contextMenus.create({
        id: CONTEXT_MENU_IDS.SAVE_IMAGE,
        title: "Save image to Quantbrowse",
        contexts: ["image"],
      }, () => void chrome.runtime.lastError);
    } catch {
      // ignore registration errors (e.g. duplicate ids)
    }
    resolve();
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!info?.menuItemId) return;
  if (!Object.values(CONTEXT_MENU_IDS).includes(info.menuItemId)) return;
  handleContextMenuSave(info, tab);
});

async function handleContextMenuSave(info, tab) {
  try {
    const clip = await clipper.captureFromContextMenu(tab, info);
    const saved = await saver.saveClip(clip);
    await notifyClipSaved(saved);
    await chrome.runtime
      .sendMessage({
        type: "CLIP_SAVED",
        clip: saved,
      })
      .catch(() => undefined);
  } catch (error) {
    await notifyClipError(error);
  }
}

async function notifyClipSaved(clip) {
  const { preferences } = await storage.getState();
  if (!preferences.showNotifications) return;
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon48.png",
    title: "Saved to Quantbrowse",
    message: clip?.title || "Clip saved",
  });
}

async function notifyClipError(error) {
  const { preferences } = await storage.getState();
  if (!preferences.showNotifications) return;
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon48.png",
    title: "Quantbrowse save failed",
    message: String(error || "Unable to save clip."),
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
// ─── Context Menu Setup ────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "qba-save-to-quant",
      title: "Save to Quant \u2726",
      contexts: ["all"],
    });

    chrome.contextMenus.create({
      id: "qba-save-link",
      title: "Save Link to Quant",
      contexts: ["link"],
    });

    chrome.contextMenus.create({
      id: "qba-save-image",
      title: "Save Image to Quantedits",
      contexts: ["image"],
    });

    chrome.contextMenus.create({
      id: "qba-save-selection",
      title: "Save Selection to Quant",
      contexts: ["selection"],
    });

    chrome.contextMenus.create({
      id: "qba-screenshot-region",
      title: "Screenshot Region\u2026",
      contexts: ["all"],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;

  switch (info.menuItemId) {
    case "qba-save-to-quant":
      chrome.tabs.sendMessage(
        tab.id,
        { type: "CLIP_ELEMENT", targetInfo: null },
        async (response) => {
          if (chrome.runtime.lastError || !response?.success) return;
          const apiBaseUrl = await getApiBaseUrl();
          const tags = await autoTagClip(response.clip, apiBaseUrl);
          const item = await persistClip(response.clip, tags);
          await trySaveToApi(item, apiBaseUrl);
          chrome.tabs.sendMessage(tab.id, {
            type: "OVERLAY_RESULT",
            text: `\u2713 Saved to ${item.app}: ${tags.title}`,
          }).catch(() => undefined);
        }
      );
      break;

    case "qba-save-link": {
      const url = info.linkUrl ?? tab.url ?? "";
      (async () => {
        const clip = {
          id: `clip-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          type: "generic",
          url,
          faviconUrl: `${new URL(url).origin}/favicon.ico`,
          title: info.selectionText || url,
          description: "",
          timestamp: Date.now(),
        };
        const apiBaseUrl = await getApiBaseUrl();
        const tags = await autoTagClip(clip, apiBaseUrl);
        const item = await persistClip(clip, tags);
        await trySaveToApi(item, apiBaseUrl);
      })().catch(console.error);
      break;
    }

    // ── Universal clipper: quick save from popup ───────────────────────────
    case "CLIPPER_SAVE": {
      const captureMode = message.captureMode || "page";
      (async () => {
        try {
          const [tab] = await chrome.tabs.query({
            active: true,
            currentWindow: true,
          });
          if (!tab?.id) {
            sendResponse({ success: false, error: "No active tab found." });
            return;
          }
          const clip = await clipper.captureFromPopup(tab, captureMode);
          const saved = await saver.saveClip(clip);
          sendResponse({ success: true, clip: saved });
          await chrome.runtime
            .sendMessage({ type: "CLIP_SAVED", clip: saved })
            .catch(() => undefined);
        } catch (error) {
          sendResponse({ success: false, error: String(error) });
        }
      })();
      return true;
    }

    // ── Collections state for UI ──────────────────────────────────────────
    case "COLLECTIONS_STATE": {
      (async () => {
        const state = await storage.getState();
        sendResponse({ success: true, state });
      })();
      return true;
    }

    case "COLLECTIONS_UPDATE": {
      (async () => {
        const { clipId, patch } = message;
        if (!clipId || !patch) {
          sendResponse({ success: false, error: "clipId and patch are required." });
          return;
        }
        const updated = await saver.updateClip(clipId, patch);
        sendResponse({ success: true, clip: updated.clip });
      })();
      return true;
    }

    case "COLLECTIONS_DELETE": {
      (async () => {
        const { clipId } = message;
        if (!clipId) {
          sendResponse({ success: false, error: "clipId is required." });
          return;
        }
        await saver.deleteClip(clipId);
        sendResponse({ success: true });
      })();
      return true;
    }

    case "COLLECTIONS_REFRESH_TAGS": {
      (async () => {
        const { clipId } = message;
        if (!clipId) {
          sendResponse({ success: false, error: "clipId is required." });
          return;
        }
        const clip = await saver.refreshTags(clipId);
        sendResponse({ success: true, clip });
      })();
      return true;
    }

    case "QUEUE_STATS": {
      (async () => {
        const state = await storage.getState();
        sendResponse({
          success: true,
          queue: state.offlineQueue,
          stats: state.stats,
        });
      })();
      return true;
    }

    case "QUEUE_FLUSH": {
      (async () => {
        const result = await saver.flushQueue();
        sendResponse({ success: true, result });
      })();
      return true;
    }

    case "PREFERENCES_UPDATE": {
      (async () => {
        const next = await storage.setPreferences(message.preferences || {});
        sendResponse({ success: true, preferences: next });
      })();
      return true;
    }

    default:
      return false;
  }
});
    case "qba-save-image": {
      const url = info.srcUrl ?? "";
      (async () => {
        const clip = {
          id: `clip-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          type: "image",
          url: info.pageUrl ?? tab.url ?? "",
          faviconUrl: `${new URL(info.pageUrl ?? tab.url ?? "http://example.com").origin}/favicon.ico`,
          title: `Image from ${tab.title ?? "page"}`,
          description: info.selectionText || "",
          timestamp: Date.now(),
          image: { src: url, alt: "", width: 0, height: 0, caption: "" },
        };
        const apiBaseUrl = await getApiBaseUrl();
        const tags = await autoTagClip(clip, apiBaseUrl);
        const item = await persistClip(clip, tags);
        await trySaveToApi(item, apiBaseUrl);
      })().catch(console.error);
      break;
    }

    case "qba-save-selection": {
      const selectedText = info.selectionText ?? "";
      (async () => {
        const clip = {
          id: `clip-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          type: "article",
          url: tab.url ?? "",
          faviconUrl: `${new URL(tab.url ?? "http://example.com").origin}/favicon.ico`,
          title: tab.title ?? "Selection",
          description: selectedText.slice(0, 200),
          timestamp: Date.now(),
          article: {
            title: tab.title ?? "Selection",
            byline: "",
            publishedDate: "",
            bodyHtml: `<p>${selectedText}</p>`,
            bodyText: selectedText,
            leadImageUrl: "",
            wordCount: selectedText.split(/\s+/).filter(Boolean).length,
            readingTimeMinutes: Math.ceil(selectedText.split(/\s+/).filter(Boolean).length / 200),
          },
        };
        const apiBaseUrl = await getApiBaseUrl();
        const tags = await autoTagClip(clip, apiBaseUrl);
        const item = await persistClip(clip, tags);
        await trySaveToApi(item, apiBaseUrl);
      })().catch(console.error);
      break;
    }

    case "qba-screenshot-region":
      chrome.tabs.sendMessage(
        tab.id,
        { type: "START_REGION_SCREENSHOT" },
        (response) => {
          if (!response?.success) return;
          (async () => {
            const clip = {
              id: `clip-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
              type: "image",
              url: tab.url ?? "",
              faviconUrl: `${new URL(tab.url ?? "http://example.com").origin}/favicon.ico`,
              title: `Screenshot of ${tab.title ?? "page"}`,
              description: "",
              timestamp: Date.now(),
              screenshotDataUrl: response.dataUrl,
            };
            const apiBaseUrl = await getApiBaseUrl();
            const tags = await autoTagClip(clip, apiBaseUrl);
            const item = await persistClip(clip, tags);
            await trySaveToApi(item, apiBaseUrl);
          })().catch(console.error);
        }
      );
      break;
  }
});

// ─── Clipper helpers ───────────────────────────────────────────────────────

const CONTENT_TYPE_APP_MAP = {
  article: "quantsink",
  video: "quanttube",
  image: "quantedits",
  code: "quantcode",
  recipe: "quantrecipes",
  product: "quantshop",
  generic: "quantbrowse",
};

/**
 * Minimal statistical auto-tagger (no ML dependency in service worker).
 */
async function autoTagClip(clip, apiBaseUrl) {
  const text = clip.article?.bodyText
    || clip.code?.snippet
    || `${clip.title} ${clip.description}`
    || "";

  try {
    const resp = await fetch(`${apiBaseUrl}/api/tag`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: text.slice(0, 4000) }),
      signal: AbortSignal.timeout(6000),
    });
    if (resp.ok) {
      const data = await resp.json();
      if (data?.tags?.length) {
        return {
          title: data.title || cleanTitle(clip.title || clip.url),
          summary: data.summary || text.slice(0, 200),
          tags: data.tags.slice(0, 5),
          category: data.category || "other",
          sentiment: data.sentiment || "neutral",
          language: data.language || "en",
          translatedTitle: data.translatedTitle || "",
          translatedSummary: data.translatedSummary || "",
          suggestedApp: CONTENT_TYPE_APP_MAP[clip.type] || "quantbrowse",
          confidence: 0.8,
          processingMs: 0,
        };
      }
    }
  } catch {
    // fall through to statistical method
  }

  const tags = extractKeywordsSimple(text, 5);
  const category = classifyCategorySimple(text);
  const sentiment = analyzeSentimentSimple(text);
  const summary = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);

  return {
    title: cleanTitle(clip.article?.title || clip.video?.title || clip.title || clip.url),
    summary,
    tags,
    category,
    sentiment,
    language: "en",
    translatedTitle: "",
    translatedSummary: "",
    suggestedApp: CONTENT_TYPE_APP_MAP[clip.type] || "quantbrowse",
    confidence: 0.5,
    processingMs: 0,
  };
}

function cleanTitle(raw) {
  if (!raw) return "";
  const parts = raw.split(/\s*[\|–—-]\s*/);
  const cleaned = parts
    .map((p) => p.replace(/^\s*(BREAKING|WATCH|VIDEO|OPINION|SPONSORED):\s*/i, "").trim())
    .filter((p) => p.length > 5);
  return (cleaned.sort((a, b) => b.length - a.length)[0] ?? raw).trim().slice(0, 120);
}

const STOPWORDS_SET = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "are", "was", "were", "be", "been",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "not", "no", "this", "that", "it", "he", "she", "we", "they",
  "i", "you", "my", "your", "our", "their",
]);

function extractKeywordsSimple(text, max) {
  const lower = text.toLowerCase().replace(/[^\w\s]/g, " ");
  const words = lower.split(/\s+/).filter((w) => w.length > 3 && !STOPWORDS_SET.has(w));
  const freq = new Map();
  for (const w of words) freq.set(w, (freq.get(w) || 0) + 1);
  return [...freq.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([term]) => term);
}

const CATEGORY_KEYWORDS = {
  technology: ["javascript", "python", "api", "software", "code", "developer", "ai", "cloud"],
  science: ["research", "study", "experiment", "physics", "biology", "quantum"],
  business: ["startup", "revenue", "funding", "market", "enterprise"],
  finance: ["stock", "crypto", "invest", "portfolio", "bitcoin"],
  health: ["health", "medical", "disease", "treatment", "fitness"],
  sports: ["game", "match", "team", "championship", "athlete"],
  entertainment: ["movie", "film", "streaming", "celebrity", "trailer"],
  food: ["recipe", "ingredient", "cook", "restaurant", "cuisine"],
  education: ["learn", "course", "tutorial", "university"],
  travel: ["destination", "hotel", "flight", "travel"],
};

function classifyCategorySimple(text) {
  const lower = text.toLowerCase();
  let bestCat = "other";
  let bestScore = 0;
  for (const [cat, kws] of Object.entries(CATEGORY_KEYWORDS)) {
    const score = kws.filter((kw) => lower.includes(kw)).length;
    if (score > bestScore) { bestScore = score; bestCat = cat; }
  }
  return bestCat;
}

const POS_WORDS = new Set([
  "good", "great", "excellent", "amazing", "wonderful", "love", "best",
  "success", "win", "positive", "improve", "growth", "helpful", "easy",
]);
const NEG_WORDS = new Set([
  "bad", "terrible", "awful", "horrible", "worst", "hate", "fail",
  "loss", "negative", "decline", "problem", "error", "crash", "dangerous",
]);

function analyzeSentimentSimple(text) {
  const words = text.toLowerCase().split(/\W+/);
  let pos = 0, neg = 0;
  for (const w of words) {
    if (POS_WORDS.has(w)) pos++;
    if (NEG_WORDS.has(w)) neg++;
  }
  const total = pos + neg;
  if (total === 0) return "neutral";
  if (pos / total > 0.6) return "positive";
  if (neg / total > 0.4) return "negative";
  return "neutral";
}

// ─── Storage helpers ───────────────────────────────────────────────────────

async function getSavedItems() {
  return new Promise((resolve) => {
    chrome.storage.local.get("qba_saved_items", ({ qba_saved_items }) => {
      resolve((qba_saved_items || []).sort((a, b) => b.savedAt - a.savedAt));
    });
  });
}

async function getCollections() {
  return new Promise((resolve) => {
    chrome.storage.local.get("qba_collections", ({ qba_collections }) => {
      resolve((qba_collections || []).sort((a, b) => b.updatedAt - a.updatedAt));
    });
  });
}

async function persistClip(clip, tags) {
  const items = await getSavedItems();
  const normalizedUrl = normalizeUrl(clip.url);

  const existing = items.find((i) => i.normalizedUrl === normalizedUrl);
  const prevVersion = existing?.versions?.slice(-1)[0] ?? null;
  const newVersion = {
    versionNumber: (prevVersion?.versionNumber || 0) + 1,
    savedAt: Date.now(),
    bodyTextHash: "",
    diff: "",
  };

  const item = {
    id: clip.id,
    url: clip.url,
    normalizedUrl,
    clip,
    tags,
    app: tags.suggestedApp || "quantbrowse",
    status: "queued",
    savedAt: Date.now(),
    updatedAt: Date.now(),
    remoteId: null,
    errorMessage: null,
    versions: [...(existing?.versions || []), newVersion],
  };

  const filtered = items
    .filter((i) => i.id !== item.id && i.normalizedUrl !== item.normalizedUrl)
    .slice(0, 4999);

  await chrome.storage.local.set({ qba_saved_items: [item, ...filtered] });
  return item;
}

async function deleteSavedItem(id) {
  const items = await getSavedItems();
  await chrome.storage.local.set({
    qba_saved_items: items.filter((i) => i.id !== id),
  });
}

function normalizeUrl(raw) {
  try {
    const u = new URL(raw);
    const TRACKING = [
      "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
      "ref", "source", "fbclid", "gclid",
    ];
    TRACKING.forEach((p) => u.searchParams.delete(p));
    if (!u.hash.startsWith("#/")) u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    return u.toString();
  } catch {
    return raw;
  }
}

async function trySaveToApi(item, apiBaseUrl) {
  const endpointMap = {
    quantsink: "/api/quantsink/save",
    quanttube: "/api/quanttube/save",
    quantedits: "/api/quantedits/save",
    quantbrowse: "/api/quantbrowse/save",
    quantdocs: "/api/quantdocs/save",
    quantcode: "/api/quantcode/save",
    quantshop: "/api/quantshop/save",
    quantrecipes: "/api/quantrecipes/save",
    quantmind: "/api/quantmind/save",
  };

  const endpoint = endpointMap[item.app] || endpointMap["quantbrowse"];

  try {
    const resp = await fetch(`${apiBaseUrl}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceUrl: item.url,
        title: item.tags.title,
        summary: item.tags.summary,
        tags: item.tags.tags,
        category: item.tags.category,
        sentiment: item.tags.sentiment,
        language: item.tags.language,
        savedAt: item.savedAt,
        faviconUrl: item.clip.faviconUrl,
        bodyHtml: item.clip.article?.bodyHtml,
        bodyText: item.clip.article?.bodyText,
        snippet: item.clip.code?.snippet,
        codeLanguage: item.clip.code?.language,
        embedUrl: item.clip.video?.embedUrl,
        imageUrl: item.clip.image?.src,
        screenshotDataUrl: item.clip.screenshotDataUrl,
      }),
      signal: AbortSignal.timeout(12000),
    });

    if (resp.ok) {
      const data = await resp.json().catch(() => ({}));
      item.remoteId = data.id || null;
      item.status = "saved";
      item.updatedAt = Date.now();

      const items = await getSavedItems();
      const idx = items.findIndex((i) => i.id === item.id);
      if (idx !== -1) {
        items[idx] = item;
        await chrome.storage.local.set({ qba_saved_items: items });
      }
    }
  } catch {
    // Network offline — stays in queue for retry
  }

  return { success: true, item, isDuplicate: false };
}

async function syncOfflineQueue(apiBaseUrl) {
  const items = await getSavedItems();
  const queued = items.filter((i) => i.status === "queued");
  let synced = 0;
  let failed = 0;

  for (const item of queued) {
    try {
      const result = await trySaveToApi(item, apiBaseUrl);
      if (result.item.status === "saved") synced++;
      else failed++;
    } catch {
      failed++;
    }
  }

  return { synced, failed };
}

// ─── Periodic queue sync ───────────────────────────────────────────────────

chrome.alarms.create("qba-sync-queue", { periodInMinutes: 2 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "qba-sync-queue") return;
  const apiBaseUrl = await getApiBaseUrl();
  await syncOfflineQueue(apiBaseUrl);
});

