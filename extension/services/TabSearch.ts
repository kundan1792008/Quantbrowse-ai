/**
 * TabSearch.ts — Quantbrowse AI Smart Tab Management
 *
 * Responsibilities:
 *  1. Fuzzy search across all open tabs by title and URL.
 *  2. Deep search inside tab page content (not just metadata).
 *  3. Maintain a frecency-ranked recent-tabs history.
 *  4. Register and handle the Ctrl+Space quick-switch keyboard shortcut.
 *
 * Frecency ranking
 * ----------------
 * "Frecency" combines frequency (how often a tab is visited) and recency
 * (how recently it was visited) into a single score.  The formula used here
 * is inspired by Firefox's Places frecency algorithm:
 *
 *   frecency = Σ (decay^age_in_hours) * visit_weight
 *
 * where `decay` = 0.9975 (half-life ≈ 277 hours) and `visit_weight` = 1.
 *
 * Fuzzy matching algorithm
 * ------------------------
 * We use a simple but effective character-sequence fuzzy match:
 *   1. All query characters must appear in order within the target string.
 *   2. The score is boosted when characters appear consecutively (run bonus)
 *      and when the match starts at a word boundary (boundary bonus).
 *   3. Results are ranked by score descending; ties broken by frecency.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/** A single entry in the recent-tabs history. */
export interface HistoryEntry {
  tabId: number;
  windowId: number;
  title: string;
  url: string;
  favIconUrl?: string;
  /** Epoch ms of each individual visit, newest first. */
  visits: number[];
  /** Computed frecency score (recalculated on demand). */
  frecency: number;
}

/** A single search result returned by the query methods. */
export interface TabSearchResult {
  tabId: number;
  windowId: number;
  title: string;
  url: string;
  favIconUrl?: string;
  /** Sections of the title that matched the query (for highlight rendering). */
  titleMatchRanges: [number, number][];
  /** Sections of the URL that matched the query. */
  urlMatchRanges: [number, number][];
  /** Combined rank score (higher = better). */
  score: number;
  /** Optional snippet from page content containing the query term. */
  contentSnippet?: string;
  /** Whether the match was found inside the page body (deep search). */
  isContentMatch: boolean;
}

/** Options for search queries. */
export interface SearchOptions {
  /**
   * If true, the search also queries page content via injected content scripts.
   * This is slower but surfaces results not visible in tab titles / URLs.
   * Defaults to false.
   */
  deepSearch: boolean;

  /**
   * Maximum number of results to return.  Defaults to 20.
   */
  maxResults: number;

  /**
   * Minimum fuzzy score (0–1) for a result to be included.
   * Defaults to 0.1.
   */
  minScore: number;
}

const DEFAULT_SEARCH_OPTIONS: SearchOptions = {
  deepSearch: false,
  maxResults: 20,
  minScore: 0.1,
};

/** Configuration for the TabSearch service. */
export interface TabSearchConfig {
  /**
   * Maximum number of unique URLs to retain in history.
   * Defaults to 500.
   */
  maxHistorySize: number;

  /**
   * Frecency decay factor per hour (0 < factor < 1).
   * Defaults to 0.9975 (half-life ≈ 277 hours).
   */
  frecencyDecay: number;

  /**
   * Keyboard shortcut string registered with chrome.commands.
   * Must match the "commands" entry in manifest.json.
   * Defaults to "_execute_action" (opens the popup).
   */
  shortcutCommand: string;
}

const DEFAULT_CONFIG: TabSearchConfig = {
  maxHistorySize: 500,
  frecencyDecay: 0.9975,
  shortcutCommand: "quick_switch",
};

// ─── Fuzzy matching utilities ─────────────────────────────────────────────────

/**
 * Performs a fuzzy character-sequence match of `query` against `target`.
 *
 * @returns An object containing:
 *   - `score`: 0 if no match; higher values indicate better matches.
 *   - `ranges`: Array of [startIndex, endIndex] pairs of matched characters.
 */
export function fuzzyMatch(
  query: string,
  target: string
): { score: number; ranges: [number, number][] } {
  if (!query) return { score: 0, ranges: [] };

  const q = query.toLowerCase();
  const t = target.toLowerCase();

  let qi = 0; // query index
  let score = 0;
  let runLength = 0;
  const matchedPositions: number[] = [];

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      matchedPositions.push(ti);
      qi++;

      // Run bonus: consecutive characters matched
      const isConsecutive =
        matchedPositions.length > 1 &&
        matchedPositions[matchedPositions.length - 1] ===
          matchedPositions[matchedPositions.length - 2] + 1;

      if (isConsecutive) {
        runLength++;
        score += 1 + runLength * 0.5;
      } else {
        runLength = 0;
        score += 1;
      }

      // Word-boundary bonus: matched character follows a separator
      if (ti === 0 || /[\s\-_./:?#=&]/.test(t[ti - 1])) {
        score += 2;
      }
    }
  }

  // All query characters must be present for a valid match
  if (qi < q.length) return { score: 0, ranges: [] };

  // Normalise by query length so longer queries don't dominate unfairly
  score = score / q.length;

  // Build contiguous ranges from matched positions for highlight rendering
  const ranges: [number, number][] = [];
  let rangeStart = matchedPositions[0];
  let prev = matchedPositions[0];

  for (let i = 1; i < matchedPositions.length; i++) {
    const pos = matchedPositions[i];
    if (pos !== prev + 1) {
      ranges.push([rangeStart, prev + 1]);
      rangeStart = pos;
    }
    prev = pos;
  }
  ranges.push([rangeStart, prev + 1]);

  return { score, ranges };
}

/**
 * Extracts a short context snippet around the first occurrence of `query`
 * inside `content`.  Returns an empty string if the query is not found.
 *
 * @param content     Full page content text.
 * @param query       Search query string.
 * @param contextLen  Characters to show on each side of the match (default 80).
 */
export function extractSnippet(
  content: string,
  query: string,
  contextLen = 80
): string {
  const idx = content.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return "";

  const start = Math.max(0, idx - contextLen);
  const end = Math.min(content.length, idx + query.length + contextLen);

  const prefix = start > 0 ? "…" : "";
  const suffix = end < content.length ? "…" : "";

  return prefix + content.slice(start, end).trim() + suffix;
}

// ─── TabSearch class ──────────────────────────────────────────────────────────

/**
 * Provides fuzzy search across open browser tabs with frecency-ranked history.
 */
export class TabSearch {
  private readonly config: TabSearchConfig;

  /**
   * History store: maps URL (normalised) → HistoryEntry.
   * We key by URL rather than tabId because tabs change IDs on reload.
   */
  private readonly history: Map<string, HistoryEntry> = new Map();

  constructor(config: Partial<TabSearchConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.attachListeners();
    this.loadHistory();
  }

  // ── Public search API ───────────────────────────────────────────────────────

  /**
   * Main search entry-point.
   *
   * @param query   The user's search string.
   * @param options Optional overrides for search behaviour.
   * @returns       Ranked array of TabSearchResult objects.
   */
  async search(
    query: string,
    options: Partial<SearchOptions> = {}
  ): Promise<TabSearchResult[]> {
    const opts: SearchOptions = { ...DEFAULT_SEARCH_OPTIONS, ...options };
    const rawQuery = query.trim();

    if (!rawQuery) return this.getFrecentTabs(opts.maxResults);

    const allTabs = await chrome.tabs.query({});
    const results: TabSearchResult[] = [];

    for (const tab of allTabs) {
      const titleMatch = fuzzyMatch(rawQuery, tab.title ?? "");
      const urlMatch = fuzzyMatch(rawQuery, tab.url ?? "");

      const baseScore = Math.max(titleMatch.score, urlMatch.score);
      if (baseScore < opts.minScore) continue;

      // Boost score by frecency
      const frecency = this.getFrecency(tab.url ?? "");
      const finalScore = baseScore + frecency * 0.01;

      results.push({
        tabId: tab.id!,
        windowId: tab.windowId,
        title: tab.title ?? "",
        url: tab.url ?? "",
        favIconUrl: tab.favIconUrl,
        titleMatchRanges: titleMatch.ranges,
        urlMatchRanges: urlMatch.ranges,
        score: finalScore,
        isContentMatch: false,
      });
    }

    // Deep content search (optional — injects into each tab)
    if (opts.deepSearch) {
      const contentResults = await this.deepSearch(rawQuery, allTabs);
      for (const cr of contentResults) {
        const existing = results.find((r) => r.tabId === cr.tabId);
        if (existing) {
          existing.contentSnippet = cr.contentSnippet;
          existing.isContentMatch = true;
          existing.score = Math.max(existing.score, cr.score);
        } else {
          results.push(cr);
        }
      }
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);

    return results.slice(0, opts.maxResults);
  }

  /**
   * Returns the most recently / frequently visited tabs, ranked by frecency.
   *
   * @param limit Maximum number of results (default 10).
   */
  async getRecentTabs(limit = 10): Promise<TabSearchResult[]> {
    return this.getFrecentTabs(limit);
  }

  /**
   * Records a visit to a tab so it appears in the history.
   * Call this on `chrome.tabs.onActivated` events.
   */
  recordVisit(tabId: number, url: string, title: string, windowId: number, favIconUrl?: string): void {
    const key = this.normaliseUrl(url);
    const now = Date.now();
    const existing = this.history.get(key);

    if (existing) {
      existing.tabId = tabId;
      existing.title = title;
      existing.favIconUrl = favIconUrl;
      existing.visits.unshift(now);
      if (existing.visits.length > 50) existing.visits.length = 50; // cap per-URL history
      existing.frecency = this.computeFrecency(existing.visits);
    } else {
      const entry: HistoryEntry = {
        tabId,
        windowId,
        title,
        url,
        favIconUrl,
        visits: [now],
        frecency: 1,
      };
      this.history.set(key, entry);
    }

    this.evictOldEntries();
    this.persistHistory();
  }

  /**
   * Switches the browser focus to the given tab.
   *
   * @param tabId   Chrome tab ID to activate.
   */
  async switchToTab(tabId: number): Promise<void> {
    const tab = await chrome.tabs.get(tabId);
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tabId, { active: true });
  }

  /**
   * Returns the frecency score for a URL (0 if never visited).
   */
  getFrecency(url: string): number {
    const key = this.normaliseUrl(url);
    return this.history.get(key)?.frecency ?? 0;
  }

  /**
   * Clears all history entries.
   */
  async clearHistory(): Promise<void> {
    this.history.clear();
    await chrome.storage.local.remove("tabSearchHistory");
  }

  /**
   * Returns the current history entries sorted by frecency descending.
   */
  getHistory(): HistoryEntry[] {
    return [...this.history.values()].sort((a, b) => b.frecency - a.frecency);
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  /**
   * Returns frequently/recently visited open tabs ranked by frecency.
   * Tabs that are no longer open are excluded.
   */
  private async getFrecentTabs(limit: number): Promise<TabSearchResult[]> {
    const allTabs = await chrome.tabs.query({});
    const openUrls = new Set(allTabs.map((t) => this.normaliseUrl(t.url ?? "")));
    const tabByUrl = new Map(allTabs.map((t) => [this.normaliseUrl(t.url ?? ""), t]));

    const results: TabSearchResult[] = [];

    for (const entry of this.history.values()) {
      const key = this.normaliseUrl(entry.url);
      if (!openUrls.has(key)) continue;

      const tab = tabByUrl.get(key);
      if (!tab) continue;

      results.push({
        tabId: tab.id!,
        windowId: tab.windowId,
        title: tab.title ?? entry.title,
        url: tab.url ?? entry.url,
        favIconUrl: tab.favIconUrl ?? entry.favIconUrl,
        titleMatchRanges: [],
        urlMatchRanges: [],
        score: entry.frecency,
        isContentMatch: false,
      });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  /**
   * Injects a content search into every open tab and returns results with
   * page-body snippets.  Tabs that reject scripting are silently skipped.
   */
  private async deepSearch(
    query: string,
    tabs: chrome.tabs.Tab[]
  ): Promise<TabSearchResult[]> {
    const results: TabSearchResult[] = [];

    const searchJobs = tabs.map(async (tab) => {
      if (!tab.id) return;
      try {
        type DeepSearchResult = { found: boolean; snippet: string };
        const [res] = await chrome.scripting.executeScript<[string], DeepSearchResult>({
          target: { tabId: tab.id, allFrames: false },
          func: (q: string): DeepSearchResult => {
            const text = document.body?.innerText ?? "";
            const idx = text.toLowerCase().indexOf(q.toLowerCase());
            if (idx === -1) return { found: false, snippet: "" };

            const start = Math.max(0, idx - 80);
            const end = Math.min(text.length, idx + q.length + 80);
            const prefix = start > 0 ? "…" : "";
            const suffix = end < text.length ? "…" : "";
            return {
              found: true,
              snippet: prefix + text.slice(start, end).trim() + suffix,
            };
          },
          args: [query],
        });

        if (res?.result?.found) {
          results.push({
            tabId: tab.id,
            windowId: tab.windowId,
            title: tab.title ?? "",
            url: tab.url ?? "",
            favIconUrl: tab.favIconUrl,
            titleMatchRanges: [],
            urlMatchRanges: [],
            score: 0.5 + this.getFrecency(tab.url ?? "") * 0.01,
            contentSnippet: res.result.snippet,
            isContentMatch: true,
          });
        }
      } catch {
        // Tab may not allow scripting (e.g. chrome://) — skip silently
      }
    });

    await Promise.allSettled(searchJobs);
    return results;
  }

  /**
   * Computes the frecency score for an array of visit timestamps.
   *
   * Formula: Σ decay^(age_in_hours) for each visit.
   */
  private computeFrecency(visits: number[]): number {
    const now = Date.now();
    const MS_PER_HOUR = 3_600_000;
    let score = 0;

    for (const visitMs of visits) {
      const ageHours = (now - visitMs) / MS_PER_HOUR;
      score += Math.pow(this.config.frecencyDecay, ageHours);
    }

    return score;
  }

  /**
   * Normalises a URL for use as a history key by stripping trailing slashes
   * and lowercasing the scheme + hostname.
   */
  private normaliseUrl(url: string): string {
    try {
      const u = new URL(url);
      return (u.origin + u.pathname).toLowerCase().replace(/\/$/, "");
    } catch {
      return url.toLowerCase();
    }
  }

  /**
   * Evicts oldest (lowest-frecency) entries when history exceeds the cap.
   */
  private evictOldEntries(): void {
    if (this.history.size <= this.config.maxHistorySize) return;

    // Rebuild frecency scores first so eviction is accurate
    for (const entry of this.history.values()) {
      entry.frecency = this.computeFrecency(entry.visits);
    }

    const sorted = [...this.history.entries()].sort(
      ([, a], [, b]) => a.frecency - b.frecency
    );

    const toRemove = sorted.slice(0, this.history.size - this.config.maxHistorySize);
    for (const [key] of toRemove) this.history.delete(key);
  }

  // ── Persistence ─────────────────────────────────────────────────────────────

  /**
   * Persists the history to chrome.storage.local for session continuity.
   * Uses a debounced write to avoid excessive I/O on rapid tab switching.
   */
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  private persistHistory(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(async () => {
      const serialisable = [...this.history.values()];
      await chrome.storage.local.set({ tabSearchHistory: serialisable });
      this.persistTimer = null;
    }, 2000);
  }

  /**
   * Loads history from chrome.storage.local on startup.
   */
  private async loadHistory(): Promise<void> {
    const { tabSearchHistory } = await chrome.storage.local.get("tabSearchHistory");
    if (!Array.isArray(tabSearchHistory)) return;

    const now = Date.now();
    for (const entry of tabSearchHistory as HistoryEntry[]) {
      if (!entry.url || !Array.isArray(entry.visits)) continue;
      // Recompute frecency with the current timestamp
      entry.frecency = this.computeFrecency(entry.visits);
      // Skip entries with negligible frecency (very old, never re-visited)
      if (entry.frecency < 0.001 && entry.visits.every((v) => now - v > 30 * 24 * 3_600_000)) {
        continue;
      }
      this.history.set(this.normaliseUrl(entry.url), entry);
    }
  }

  // ── Event listeners ─────────────────────────────────────────────────────────

  /**
   * Registers Chrome event listeners:
   *   - `tabs.onActivated`: records visits and updates history.
   *   - `tabs.onUpdated`: refreshes title/favicon for history entries.
   *   - `commands.onCommand`: handles the quick-switch keyboard shortcut.
   */
  private attachListeners(): void {
    chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.url) {
          this.recordVisit(tabId, tab.url, tab.title ?? "", windowId, tab.favIconUrl);
        }
      } catch {
        // Tab may have been closed immediately
      }
    });

    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (changeInfo.status !== "complete") return;
      if (!tab.url) return;

      const key = this.normaliseUrl(tab.url);
      const entry = this.history.get(key);
      if (entry) {
        entry.tabId = tabId;
        entry.title = tab.title ?? entry.title;
        entry.favIconUrl = tab.favIconUrl ?? entry.favIconUrl;
      }
    });

    // Keyboard shortcut: Ctrl+Space (registered in manifest.json as "quick_switch")
    if (chrome.commands?.onCommand) {
      chrome.commands.onCommand.addListener(async (command) => {
        if (command !== this.config.shortcutCommand) return;

        // Broadcast a message to the active tab to open the quick-switch overlay
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id) {
          chrome.tabs.sendMessage(tab.id, { type: "OPEN_QUICK_SWITCH" }).catch(() => {
            // If content script isn't ready, open the popup instead
            chrome.action.openPopup?.();
          });
        }
      });
    }
  }
}

// ─── Singleton export ─────────────────────────────────────────────────────────

/** Shared TabSearch instance — import and use from background.js or content.js. */
export const tabSearch = new TabSearch();
