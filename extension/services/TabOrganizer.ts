/**
 * TabOrganizer.ts — Quantbrowse AI Smart Tab Management
 *
 * Responsibilities:
 *  1. Detect the topic of every open tab (work, social, shopping, research, entertainment).
 *  2. Auto-group tabs by topic using the Chrome tabGroups API.
 *  3. Identify duplicate tabs (same origin + pathname) and suggest merging them.
 *  4. Build and maintain a "Tab Tree" that tracks which tab opened which.
 *
 * All heavy classification is done locally without an external AI call so
 * the organizer works immediately, even offline.  When the background AI
 * service is available the caller can optionally pass richer meta-data
 * (page description, keywords) to improve classification accuracy.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/** High-level productivity topics that tabs are classified into. */
export type TabTopic =
  | "work"
  | "social"
  | "shopping"
  | "research"
  | "entertainment"
  | "news"
  | "finance"
  | "health"
  | "travel"
  | "other";

/** A richer snapshot of a single Chrome tab. */
export interface TabSnapshot {
  id: number;
  windowId: number;
  title: string;
  url: string;
  favIconUrl?: string;
  active: boolean;
  audible: boolean;
  /** Estimated memory usage in bytes (from chrome.processes if available). */
  memoryBytes: number;
  topic: TabTopic;
  /** Chrome tab-group ID this tab currently belongs to (-1 = ungrouped). */
  groupId: number;
  /** Tab ID of the opener, or null if unknown / top-level. */
  openerTabId: number | null;
  /** Milliseconds since epoch when this tab was last activated. */
  lastActivatedAt: number;
  /** Cumulative active time in milliseconds. */
  activeTimeMs: number;
  /** Whether the tab is currently suspended (hibernated) by TabHibernation. */
  hibernated: boolean;
}

/** An organizer result grouping tabs by topic. */
export interface TopicGroup {
  topic: TabTopic;
  label: string;
  color: string;
  tabIds: number[];
  chromeGroupId: number | null;
}

/** A pair of duplicate tabs. */
export interface DuplicatePair {
  keepTabId: number;
  closeTabId: number;
  url: string;
  title: string;
}

/** A node in the Tab Tree (opener ↔ child relationship). */
export interface TabTreeNode {
  tabId: number;
  title: string;
  url: string;
  topic: TabTopic;
  children: TabTreeNode[];
}

// ─── Topic Detection ──────────────────────────────────────────────────────────

/**
 * Domain / keyword fingerprints for each topic.
 * Each entry is [domains[], keywords[]] where keywords are matched against
 * the lowercase URL + title + description string.
 */
const TOPIC_SIGNALS: Record<
  TabTopic,
  { domains: string[]; keywords: string[] }
> = {
  work: {
    domains: [
      "github.com",
      "gitlab.com",
      "bitbucket.org",
      "jira.atlassian.com",
      "confluence.atlassian.com",
      "linear.app",
      "notion.so",
      "asana.com",
      "trello.com",
      "slack.com",
      "teams.microsoft.com",
      "zoom.us",
      "meet.google.com",
      "calendar.google.com",
      "mail.google.com",
      "outlook.live.com",
      "outlook.office.com",
      "figma.com",
      "miro.com",
      "lucid.app",
      "docs.google.com",
      "sheets.google.com",
      "drive.google.com",
      "office.com",
      "monday.com",
      "clickup.com",
    ],
    keywords: [
      "dashboard",
      "project",
      "sprint",
      "kanban",
      "backlog",
      "issue",
      "pull request",
      "deployment",
      "pipeline",
      "ci/cd",
      "repository",
      "workflow",
      "standup",
      "meeting",
      "invoice",
    ],
  },
  social: {
    domains: [
      "twitter.com",
      "x.com",
      "facebook.com",
      "instagram.com",
      "linkedin.com",
      "reddit.com",
      "tiktok.com",
      "snapchat.com",
      "pinterest.com",
      "tumblr.com",
      "discord.com",
      "mastodon.social",
      "threads.net",
      "bsky.app",
    ],
    keywords: [
      "feed",
      "timeline",
      "post",
      "tweet",
      "retweet",
      "like",
      "share",
      "comment",
      "follower",
      "following",
      "profile",
      "story",
      "reel",
      "message",
    ],
  },
  shopping: {
    domains: [
      "amazon.com",
      "amazon.co.uk",
      "ebay.com",
      "etsy.com",
      "walmart.com",
      "target.com",
      "bestbuy.com",
      "shopify.com",
      "aliexpress.com",
      "wish.com",
      "wayfair.com",
      "overstock.com",
      "chewy.com",
      "zappos.com",
      "nordstrom.com",
      "macys.com",
    ],
    keywords: [
      "cart",
      "checkout",
      "buy now",
      "add to cart",
      "price",
      "discount",
      "coupon",
      "shipping",
      "delivery",
      "order",
      "wishlist",
      "product",
      "review",
      "rating",
      "sale",
    ],
  },
  research: {
    domains: [
      "scholar.google.com",
      "arxiv.org",
      "pubmed.ncbi.nlm.nih.gov",
      "semanticscholar.org",
      "researchgate.net",
      "jstor.org",
      "academia.edu",
      "springer.com",
      "nature.com",
      "sciencedirect.com",
      "wikipedia.org",
      "en.wikipedia.org",
      "stackoverflow.com",
      "stackexchange.com",
      "developer.mozilla.org",
      "docs.python.org",
      "w3schools.com",
      "devdocs.io",
    ],
    keywords: [
      "paper",
      "abstract",
      "citation",
      "research",
      "study",
      "experiment",
      "hypothesis",
      "analysis",
      "methodology",
      "documentation",
      "tutorial",
      "howto",
      "api reference",
      "guide",
      "learn",
    ],
  },
  entertainment: {
    domains: [
      "youtube.com",
      "netflix.com",
      "twitch.tv",
      "hulu.com",
      "disneyplus.com",
      "hbomax.com",
      "primevideo.com",
      "spotify.com",
      "soundcloud.com",
      "bandcamp.com",
      "vimeo.com",
      "dailymotion.com",
      "imdb.com",
      "rottentomatoes.com",
      "steamcommunity.com",
      "store.steampowered.com",
      "crunchyroll.com",
    ],
    keywords: [
      "watch",
      "stream",
      "video",
      "movie",
      "series",
      "episode",
      "music",
      "playlist",
      "album",
      "game",
      "gaming",
      "anime",
      "trailer",
      "live",
      "podcast",
    ],
  },
  news: {
    domains: [
      "bbc.com",
      "bbc.co.uk",
      "cnn.com",
      "nytimes.com",
      "theguardian.com",
      "reuters.com",
      "apnews.com",
      "washingtonpost.com",
      "foxnews.com",
      "nbcnews.com",
      "abcnews.go.com",
      "cbsnews.com",
      "npr.org",
      "politico.com",
      "axios.com",
      "theatlantic.com",
      "wired.com",
      "techcrunch.com",
      "theverge.com",
      "arstechnica.com",
      "hackernews.com",
      "news.ycombinator.com",
    ],
    keywords: [
      "breaking",
      "headline",
      "article",
      "reporter",
      "journalist",
      "editorial",
      "opinion",
      "analysis",
      "exclusive",
      "developing",
      "latest",
      "update",
    ],
  },
  finance: {
    domains: [
      "finance.yahoo.com",
      "bloomberg.com",
      "marketwatch.com",
      "investing.com",
      "cnbc.com",
      "wsj.com",
      "ft.com",
      "robinhood.com",
      "coinbase.com",
      "binance.com",
      "kraken.com",
      "fidelity.com",
      "vanguard.com",
      "schwab.com",
      "etrade.com",
      "tradingview.com",
    ],
    keywords: [
      "stock",
      "market",
      "portfolio",
      "investment",
      "crypto",
      "bitcoin",
      "ethereum",
      "trading",
      "dividend",
      "earnings",
      "p/e ratio",
      "ipo",
      "bond",
      "fund",
      "inflation",
    ],
  },
  health: {
    domains: [
      "webmd.com",
      "mayoclinic.org",
      "healthline.com",
      "nih.gov",
      "cdc.gov",
      "who.int",
      "medlineplus.gov",
      "drugs.com",
      "rxlist.com",
    ],
    keywords: [
      "symptom",
      "diagnosis",
      "treatment",
      "medication",
      "dosage",
      "diet",
      "nutrition",
      "exercise",
      "mental health",
      "therapy",
      "doctor",
      "clinic",
      "hospital",
    ],
  },
  travel: {
    domains: [
      "booking.com",
      "airbnb.com",
      "expedia.com",
      "tripadvisor.com",
      "kayak.com",
      "skyscanner.com",
      "hotels.com",
      "trivago.com",
      "lonelyplanet.com",
      "google.com/travel",
      "flightradar24.com",
    ],
    keywords: [
      "hotel",
      "flight",
      "booking",
      "reservation",
      "itinerary",
      "destination",
      "tour",
      "visa",
      "passport",
      "travel",
      "trip",
      "vacation",
      "cruise",
    ],
  },
  other: {
    domains: [],
    keywords: [],
  },
};

/** Color mapping for each topic (Chrome tabGroups colors). */
const TOPIC_COLORS: Record<TabTopic, string> = {
  work: "blue",
  social: "pink",
  shopping: "yellow",
  research: "cyan",
  entertainment: "purple",
  news: "grey",
  finance: "green",
  health: "red",
  travel: "orange",
  other: "grey",
};

/** Human-readable label for each topic. */
const TOPIC_LABELS: Record<TabTopic, string> = {
  work: "⚙ Work",
  social: "💬 Social",
  shopping: "🛍 Shopping",
  research: "🔬 Research",
  entertainment: "🎬 Entertainment",
  news: "📰 News",
  finance: "📈 Finance",
  health: "🏥 Health",
  travel: "✈ Travel",
  other: "📌 Other",
};

/**
 * Classifies a tab's topic from its URL, title, and optional description.
 *
 * The algorithm:
 *  1. Parse the URL hostname and strip the leading "www." prefix.
 *  2. Score every topic by counting domain matches (weight 10) and
 *     keyword matches (weight 1) in the combined search text.
 *  3. Return the topic with the highest non-zero score; "other" otherwise.
 *
 * @param url         Full URL string of the tab.
 * @param title       Page title.
 * @param description Optional meta description / first-paragraph text.
 * @returns           Detected TabTopic.
 */
export function detectTopic(
  url: string,
  title: string,
  description = ""
): TabTopic {
  let hostname = "";
  try {
    hostname = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    // Malformed URL — fall through with empty hostname
  }

  const searchText = `${hostname} ${title} ${description}`.toLowerCase();

  let bestTopic: TabTopic = "other";
  let bestScore = 0;

  for (const [topic, signals] of Object.entries(TOPIC_SIGNALS) as [
    TabTopic,
    (typeof TOPIC_SIGNALS)[TabTopic]
  ][]) {
    if (topic === "other") continue;

    let score = 0;

    // Domain match carries much higher weight than keyword match
    for (const domain of signals.domains) {
      if (hostname === domain || hostname.endsWith(`.${domain}`)) {
        score += 10;
        break; // one domain hit is enough per topic
      }
    }

    for (const kw of signals.keywords) {
      if (searchText.includes(kw)) score += 1;
    }

    if (score > bestScore) {
      bestScore = score;
      bestTopic = topic;
    }
  }

  return bestTopic;
}

// ─── TabOrganizer class ───────────────────────────────────────────────────────

/** Options used to configure the organizer. */
export interface TabOrganizerOptions {
  /**
   * When true the organizer will call the Chrome tabGroups API to
   * physically create / update groups.  Set to false during unit-testing
   * to run classification without touching the browser.
   */
  applyGroups: boolean;

  /**
   * Minimum number of tabs in a topic before a Chrome tab-group is created.
   * Avoids creating a group for a single stray tab.
   * Defaults to 2.
   */
  minGroupSize: number;

  /**
   * If true, tabs already belonging to a user-created group are left alone.
   * Defaults to true.
   */
  respectExistingGroups: boolean;
}

const DEFAULT_OPTIONS: TabOrganizerOptions = {
  applyGroups: true,
  minGroupSize: 2,
  respectExistingGroups: true,
};

/**
 * Core class for AI-powered tab organisation.
 *
 * Usage (from background.js):
 * ```js
 * const organizer = new TabOrganizer();
 * const result = await organizer.organizeAll();
 * ```
 */
export class TabOrganizer {
  private readonly options: TabOrganizerOptions;

  /**
   * In-memory tab tree: maps each tab ID to the ID of the tab that opened it.
   * Populated incrementally via `recordOpener()` and cleared on full re-scan.
   */
  private readonly openerMap: Map<number, number | null> = new Map();

  /**
   * Tracks when each tab was last activated (used for inactivity checks).
   * Key = tabId, value = Date.now() at last activation.
   */
  private readonly lastActivated: Map<number, number> = new Map();

  /**
   * Cumulative active milliseconds per tab (approximated by activation events).
   */
  private readonly activeTime: Map<number, number> = new Map();

  constructor(options: Partial<TabOrganizerOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.attachListeners();
  }

  // ── Listener setup ──────────────────────────────────────────────────────────

  /**
   * Attaches Chrome event listeners to keep the opener map and activity
   * timestamps up-to-date in real time.
   */
  private attachListeners(): void {
    chrome.tabs.onCreated.addListener((tab) => {
      this.openerMap.set(tab.id!, tab.openerTabId ?? null);
      this.lastActivated.set(tab.id!, Date.now());
      this.activeTime.set(tab.id!, 0);
    });

    chrome.tabs.onRemoved.addListener((tabId) => {
      this.openerMap.delete(tabId);
      this.lastActivated.delete(tabId);
      this.activeTime.delete(tabId);
    });

    chrome.tabs.onActivated.addListener(({ tabId }) => {
      const now = Date.now();

      // Find the previously active tab in this window to credit its active time
      chrome.tabs.query({ active: false, currentWindow: true }).then((tabs) => {
        const previousTab = tabs.find((t) => {
          const lastActive = this.lastActivated.get(t.id!);
          return lastActive !== undefined;
        });

        if (previousTab?.id) {
          const prev = this.lastActivated.get(previousTab.id);
          if (prev !== undefined) {
            const elapsed = now - prev;
            const existing = this.activeTime.get(previousTab.id) ?? 0;
            this.activeTime.set(previousTab.id, existing + elapsed);
          }
        }
      });

      this.lastActivated.set(tabId, now);
    });
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Records the opener relationship for a newly created tab.
   * Call this from a `chrome.tabs.onCreated` listener if you want to
   * supplement the automatic listener with external data.
   *
   * @param childTabId  The new tab.
   * @param openerTabId The tab that triggered the navigation (or null).
   */
  recordOpener(childTabId: number, openerTabId: number | null): void {
    this.openerMap.set(childTabId, openerTabId);
  }

  /**
   * Returns a full snapshot of all currently open tabs enriched with
   * topic classification, activity data, and group information.
   */
  async snapshotAllTabs(): Promise<TabSnapshot[]> {
    const chromeTabs = await chrome.tabs.query({});
    return chromeTabs.map((t) => this.toSnapshot(t));
  }

  /**
   * Main entry-point.  Classifies all open tabs, groups them by topic in the
   * Chrome UI (if `applyGroups` is enabled), and returns the grouping result.
   *
   * @returns Array of TopicGroup — one per topic that has qualifying tabs.
   */
  async organizeAll(): Promise<TopicGroup[]> {
    const snapshots = await this.snapshotAllTabs();
    const groups = this.buildTopicGroups(snapshots);

    if (this.options.applyGroups) {
      await this.applyGroupsToChrome(groups, snapshots);
    }

    return groups;
  }

  /**
   * Scans all open tabs and returns pairs of duplicates (same origin +
   * same pathname, ignoring query-string / hash).
   *
   * The heuristic:
   *  - Two tabs are duplicates if `new URL(tab.url).origin + pathname` matches.
   *  - Of each duplicate pair the most recently activated tab is kept;
   *    the older one is marked for closure.
   *
   * @returns Array of DuplicatePair objects — one per pair to be resolved.
   */
  async findDuplicates(): Promise<DuplicatePair[]> {
    const snapshots = await this.snapshotAllTabs();
    return this.detectDuplicates(snapshots);
  }

  /**
   * Builds the full Tab Tree rooted at all top-level tabs (tabs with no
   * known opener or whose opener is no longer open).
   *
   * @returns Array of root TabTreeNode objects.
   */
  async buildTabTree(): Promise<TabTreeNode[]> {
    const snapshots = await this.snapshotAllTabs();
    return this.buildTree(snapshots);
  }

  /**
   * Closes the duplicate tabs identified by `findDuplicates()`.
   * Uses `chrome.tabs.remove` in a batched call.
   *
   * @returns Number of tabs closed.
   */
  async closeDuplicates(): Promise<number> {
    const dupes = await this.findDuplicates();
    const ids = dupes.map((d) => d.closeTabId);
    if (ids.length > 0) await chrome.tabs.remove(ids);
    return ids.length;
  }

  /**
   * Returns a topic classification for a single tab without modifying
   * any existing groups.
   */
  classifyTab(tab: chrome.tabs.Tab): TabTopic {
    return detectTopic(tab.url ?? "", tab.title ?? "");
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  /** Converts a Chrome Tab to a richer TabSnapshot. */
  private toSnapshot(tab: chrome.tabs.Tab): TabSnapshot {
    const id = tab.id!;
    const topic = detectTopic(tab.url ?? "", tab.title ?? "");
    return {
      id,
      windowId: tab.windowId,
      title: tab.title ?? "",
      url: tab.url ?? "",
      favIconUrl: tab.favIconUrl,
      active: tab.active,
      audible: tab.audible ?? false,
      memoryBytes: 0, // populated externally if chrome.processes is available
      topic,
      groupId: tab.groupId ?? -1,
      openerTabId: this.openerMap.get(id) ?? tab.openerTabId ?? null,
      lastActivatedAt: this.lastActivated.get(id) ?? Date.now(),
      activeTimeMs: this.activeTime.get(id) ?? 0,
      hibernated: false,
    };
  }

  /** Groups snapshots by topic, returning only topics with qualifying counts. */
  private buildTopicGroups(snapshots: TabSnapshot[]): TopicGroup[] {
    const byTopic = new Map<TabTopic, number[]>();

    for (const snap of snapshots) {
      if (
        this.options.respectExistingGroups &&
        snap.groupId !== -1 &&
        snap.groupId !== chrome.tabGroups?.TAB_GROUP_ID_NONE
      ) {
        // Leave tabs that are already in a user-managed group alone
        continue;
      }

      const list = byTopic.get(snap.topic) ?? [];
      list.push(snap.id);
      byTopic.set(snap.topic, list);
    }

    const result: TopicGroup[] = [];

    for (const [topic, tabIds] of byTopic) {
      if (tabIds.length < this.options.minGroupSize) continue;

      result.push({
        topic,
        label: TOPIC_LABELS[topic],
        color: TOPIC_COLORS[topic],
        tabIds,
        chromeGroupId: null,
      });
    }

    return result;
  }

  /** Applies the computed groups to Chrome using the tabGroups API. */
  private async applyGroupsToChrome(
    groups: TopicGroup[],
    snapshots: TabSnapshot[]
  ): Promise<void> {
    // Build a lookup from tabId → windowId so we group per-window
    const windowOf = new Map<number, number>();
    for (const snap of snapshots) windowOf.set(snap.id, snap.windowId);

    for (const group of groups) {
      // Partition tabIds by window (Chrome groups are per-window)
      const byWindow = new Map<number, number[]>();
      for (const tabId of group.tabIds) {
        const wid = windowOf.get(tabId) ?? -1;
        const list = byWindow.get(wid) ?? [];
        list.push(tabId);
        byWindow.set(wid, list);
      }

      for (const [windowId, tabIds] of byWindow) {
        if (windowId === -1 || tabIds.length < this.options.minGroupSize) {
          continue;
        }

        try {
          // Ensure we have at least one tab ID
          if (tabIds.length === 0) continue;

          // Chrome tabs.group expects single tabId or non-empty array
          const chromeGroupId = await chrome.tabs.group({
            tabIds: tabIds.length === 1 ? tabIds[0]! : ([...tabIds] as [number, ...number[]]),
            createProperties: { windowId },
          });

          await chrome.tabGroups.update(chromeGroupId, {
            title: group.label,
            color: group.color as chrome.tabGroups.Color,
            collapsed: false,
          });
          group.chromeGroupId = chromeGroupId;
        } catch {
          // tabGroups API is unavailable in some contexts — silently skip
        }
      }
    }
  }

  /** Detects duplicate tabs from a snapshot list. */
  private detectDuplicates(snapshots: TabSnapshot[]): DuplicatePair[] {
    const seen = new Map<string, TabSnapshot>();
    const pairs: DuplicatePair[] = [];

    // Sort by lastActivatedAt descending so we encounter the "newer" tab first
    const sorted = [...snapshots].sort(
      (a, b) => b.lastActivatedAt - a.lastActivatedAt
    );

    for (const snap of sorted) {
      let key: string;
      try {
        const u = new URL(snap.url);
        key = u.origin + u.pathname;
      } catch {
        key = snap.url;
      }

      if (seen.has(key)) {
        const existing = seen.get(key)!;
        // Keep the more recently activated tab; close the older one
        pairs.push({
          keepTabId: existing.lastActivatedAt >= snap.lastActivatedAt
            ? existing.id
            : snap.id,
          closeTabId: existing.lastActivatedAt >= snap.lastActivatedAt
            ? snap.id
            : existing.id,
          url: snap.url,
          title: snap.title,
        });
      } else {
        seen.set(key, snap);
      }
    }

    return pairs;
  }

  /** Builds a tree structure from the flat snapshot list using the openerMap. */
  private buildTree(snapshots: TabSnapshot[]): TabTreeNode[] {
    const nodeMap = new Map<number, TabTreeNode>();

    for (const snap of snapshots) {
      nodeMap.set(snap.id, {
        tabId: snap.id,
        title: snap.title,
        url: snap.url,
        topic: snap.topic,
        children: [],
      });
    }

    const roots: TabTreeNode[] = [];

    for (const snap of snapshots) {
      const node = nodeMap.get(snap.id)!;
      const parentId = snap.openerTabId;

      if (parentId !== null && nodeMap.has(parentId)) {
        nodeMap.get(parentId)!.children.push(node);
      } else {
        roots.push(node);
      }
    }

    return roots;
  }
}

// ─── Singleton export for background.js ──────────────────────────────────────

/** Shared TabOrganizer instance (import and use directly from background.js). */
export const tabOrganizer = new TabOrganizer();
