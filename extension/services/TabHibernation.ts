/**
 * TabHibernation.ts — Quantbrowse AI Smart Tab Management
 *
 * Responsibilities:
 *  1. Auto-hibernate (suspend) tabs that have been inactive for a configurable
 *     duration (default: 30 minutes).
 *  2. Save tab state — scroll position, filled form data, and viewport geometry
 *     — before discarding so it can be restored on next activation.
 *  3. Track aggregate memory savings in bytes and expose a formatted indicator.
 *  4. Whitelist: never hibernate tabs matching certain domain patterns
 *     (e.g. music players, collaborative documents, real-time dashboards).
 *  5. Expose a manual API so the popup / TabDashboard can hibernate or restore
 *     individual tabs on demand.
 *
 * Implementation notes
 * --------------------
 * Chrome's built-in `chrome.tabs.discard()` suspends a tab's renderer process
 * while keeping the tab visible in the tab strip.  When the user clicks the
 * tab again Chrome automatically reloads it.  We augment this by:
 *   a. Injecting a content script that captures scroll + form state and sends
 *      it to the background before the discard is requested.
 *   b. Storing the captured state in chrome.storage.session keyed by tab ID.
 *   c. Injecting a restore script on the next `webNavigation.onCompleted`
 *      event for that tab ID if stored state is found.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/** Scroll coordinates saved before hibernation. */
export interface ScrollState {
  x: number;
  y: number;
}

/** A single form field's captured state. */
export interface FormFieldState {
  selector: string;
  value: string;
  type: string;
  checked?: boolean;
}

/** Complete state snapshot saved for a tab before it is discarded. */
export interface TabSavedState {
  tabId: number;
  url: string;
  title: string;
  scroll: ScrollState;
  formFields: FormFieldState[];
  /** Epoch ms when the state was captured. */
  savedAt: number;
  /** Estimated memory saved (bytes) — measured right before discard. */
  memorySavedBytes: number;
}

/** Summary of memory savings across all hibernated tabs. */
export interface MemorySavingsSummary {
  totalSavedBytes: number;
  hibernatedTabCount: number;
  /** Human-readable string, e.g. "142 MB saved". */
  label: string;
}

/** Options for configuring the hibernation service. */
export interface HibernationOptions {
  /**
   * Inactivity threshold in milliseconds after which a tab becomes eligible
   * for hibernation.  Defaults to 30 minutes.
   */
  inactivityThresholdMs: number;

  /**
   * How often (in milliseconds) the background sweep checks for idle tabs.
   * Defaults to 5 minutes.
   */
  sweepIntervalMs: number;

  /**
   * Domain patterns that are never eligible for hibernation.
   * Each entry is either an exact hostname (e.g. "music.youtube.com") or
   * a glob-like wildcard prefix/suffix ("*.notion.so").
   */
  whitelist: string[];

  /**
   * Maximum number of tabs to hibernate in a single sweep pass.
   * Prevents excessive hibernation during a sudden burst of inactivity.
   * Defaults to 5.
   */
  maxHibernatePerSweep: number;

  /**
   * Average memory per renderer process assumed for tabs that report 0 bytes
   * (i.e. when chrome.processes API is unavailable).
   * Defaults to 80 MB.
   */
  fallbackMemoryBytesPerTab: number;
}

const DEFAULT_OPTIONS: HibernationOptions = {
  inactivityThresholdMs: 30 * 60 * 1000, // 30 minutes
  sweepIntervalMs: 5 * 60 * 1000,         // 5 minutes
  whitelist: [
    "music.youtube.com",
    "open.spotify.com",
    "soundcloud.com",
    "bandcamp.com",
    "docs.google.com",
    "sheets.google.com",
    "slides.google.com",
    "notion.so",
    "figma.com",
    "miro.com",
    "*.zoom.us",
    "meet.google.com",
    "teams.microsoft.com",
    "*.slack.com",
    "discord.com",
    "localhost",
  ],
  maxHibernatePerSweep: 5,
  fallbackMemoryBytesPerTab: 80 * 1024 * 1024, // 80 MB
};

// ─── TabHibernation class ─────────────────────────────────────────────────────

/**
 * Manages automatic and manual hibernation of browser tabs to save memory.
 *
 * Lifecycle:
 *   1. Call `start()` to begin the periodic sweep.
 *   2. Call `stop()` to cancel the sweep (e.g. on extension unload).
 *   3. Use `hibernateTab(tabId)` / `restoreTab(tabId)` for manual control.
 */
export class TabHibernation {
  private readonly options: HibernationOptions;

  /** tabId → epoch ms of last activation. */
  private readonly lastActivated: Map<number, number> = new Map();

  /** Set of tabIds currently in hibernated (discarded) state. */
  private readonly hibernatedTabs: Set<number> = new Set();

  /** Saved state keyed by tab ID — mirrored in chrome.storage.session. */
  private readonly savedStates: Map<number, TabSavedState> = new Map();

  /** Accumulated bytes across all hibernate operations this session. */
  private totalSavedBytes = 0;

  /** setInterval handle for the background sweep. */
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: Partial<HibernationOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.attachListeners();
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Starts the periodic hibernation sweep. */
  start(): void {
    if (this.sweepTimer !== null) return; // already running
    this.sweepTimer = setInterval(
      () => this.sweep(),
      this.options.sweepIntervalMs
    );
    // Run an immediate sweep so stale tabs are caught right away
    this.sweep();
  }

  /** Stops the periodic sweep. */
  stop(): void {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /**
   * Manually hibernates a specific tab.
   * Saves its state then calls `chrome.tabs.discard()`.
   *
   * @returns true if the tab was successfully hibernated.
   */
  async hibernateTab(tabId: number): Promise<boolean> {
    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return false;
    }

    if (tab.active) return false; // never hibernate the active tab
    if (tab.discarded) return false; // already discarded

    if (this.isWhitelisted(tab.url ?? "")) return false;

    // Capture tab state via injected content script
    const state = await this.captureState(tabId, tab);
    if (state) {
      this.savedStates.set(tabId, state);
      await this.persistState(state);
    }

    // Discard the tab renderer
    try {
      await chrome.tabs.discard(tabId);
      this.hibernatedTabs.add(tabId);
      this.totalSavedBytes += state?.memorySavedBytes ?? this.options.fallbackMemoryBytesPerTab;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Restores a hibernated tab by reloading it and re-injecting its saved
   * state once navigation completes.
   *
   * @returns true if a reload was initiated.
   */
  async restoreTab(tabId: number): Promise<boolean> {
    if (!this.hibernatedTabs.has(tabId)) return false;

    try {
      await chrome.tabs.reload(tabId);
      this.hibernatedTabs.delete(tabId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Returns whether a tab is currently hibernated.
   */
  isHibernated(tabId: number): boolean {
    return this.hibernatedTabs.has(tabId);
  }

  /**
   * Returns the saved state for a tab (if any).
   */
  getSavedState(tabId: number): TabSavedState | undefined {
    return this.savedStates.get(tabId);
  }

  /**
   * Returns a summary of memory savings so far this session.
   */
  getMemorySavings(): MemorySavingsSummary {
    const bytes = this.totalSavedBytes;
    return {
      totalSavedBytes: bytes,
      hibernatedTabCount: this.hibernatedTabs.size,
      label: this.formatBytes(bytes) + " saved",
    };
  }

  /**
   * Returns the current whitelist.
   */
  getWhitelist(): string[] {
    return [...this.options.whitelist];
  }

  /**
   * Adds a domain pattern to the whitelist.
   * Supports exact hostnames and simple glob prefixes/suffixes ("*.example.com").
   */
  addToWhitelist(pattern: string): void {
    if (!this.options.whitelist.includes(pattern)) {
      this.options.whitelist.push(pattern);
    }
  }

  /**
   * Removes a domain pattern from the whitelist.
   */
  removeFromWhitelist(pattern: string): void {
    const idx = this.options.whitelist.indexOf(pattern);
    if (idx !== -1) this.options.whitelist.splice(idx, 1);
  }

  /**
   * Updates the inactivity threshold without restarting the sweep.
   */
  setInactivityThreshold(ms: number): void {
    this.options.inactivityThresholdMs = ms;
  }

  /**
   * Returns an array of tab IDs currently in hibernated state.
   */
  getHibernatedTabIds(): number[] {
    return [...this.hibernatedTabs];
  }

  // ── Sweep logic ─────────────────────────────────────────────────────────────

  /**
   * Identifies and hibernates eligible inactive tabs.
   * Called automatically by the sweep timer.
   */
  private async sweep(): Promise<void> {
    const now = Date.now();
    const allTabs = await chrome.tabs.query({});
    let hibernatedThisSweep = 0;

    // Sort by least-recently activated first so we hibernate oldest idle tabs
    const candidates = allTabs
      .filter((t) => {
        if (t.active) return false;
        if (t.discarded) return false;
        if (t.pinned) return false;
        if (t.audible) return false; // playing audio — leave it alone
        if (this.isWhitelisted(t.url ?? "")) return false;

        const lastAct = this.lastActivated.get(t.id!) ?? now - this.options.inactivityThresholdMs - 1;
        return now - lastAct >= this.options.inactivityThresholdMs;
      })
      .sort((a, b) => {
        const la = this.lastActivated.get(a.id!) ?? 0;
        const lb = this.lastActivated.get(b.id!) ?? 0;
        return la - lb; // oldest first
      });

    for (const tab of candidates) {
      if (hibernatedThisSweep >= this.options.maxHibernatePerSweep) break;

      const ok = await this.hibernateTab(tab.id!);
      if (ok) hibernatedThisSweep++;
    }
  }

  // ── State capture / restore ─────────────────────────────────────────────────

  /**
   * Injects a content script into the tab to capture its scroll position
   * and form field values, then assembles a TabSavedState.
   */
  private async captureState(
    tabId: number,
    tab: chrome.tabs.Tab
  ): Promise<TabSavedState | null> {
    try {
      type CaptureResult = {
        scroll: ScrollState;
        formFields: FormFieldState[];
      };

      const results = await chrome.scripting.executeScript<[], CaptureResult>({
        target: { tabId, allFrames: false },
        func: () => {
          const scroll: ScrollState = {
            x: window.scrollX,
            y: window.scrollY,
          };

          const formFields: FormFieldState[] = [];
          const inputs = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
            "input, textarea, select"
          );

          for (const el of inputs) {
            if (!el.name && !el.id) continue;
            const selector = el.id
              ? `#${CSS.escape(el.id)}`
              : `[name="${CSS.escape(el.name)}"]`;

            if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
              formFields.push({ selector, value: el.value, type: el.type, checked: el.checked });
            } else if (el instanceof HTMLSelectElement) {
              formFields.push({ selector, value: el.value, type: "select" });
            } else {
              formFields.push({ selector, value: (el as HTMLInputElement | HTMLTextAreaElement).value, type: el.type ?? "text" });
            }
          }

          return { scroll, formFields };
        },
      });

      if (!results?.[0]?.result) return null;

      const { scroll, formFields } = results[0].result;

      // Estimate memory: prefer chrome.processes data; fall back to constant
      const memorySavedBytes = await this.estimateMemory(tabId);

      return {
        tabId,
        url: tab.url ?? "",
        title: tab.title ?? "",
        scroll,
        formFields,
        savedAt: Date.now(),
        memorySavedBytes,
      };
    } catch {
      return null;
    }
  }

  /**
   * Re-injects saved scroll and form state into a tab after it reloads.
   * Must be called after `webNavigation.onCompleted` for the tab.
   */
  private async restoreState(tabId: number): Promise<void> {
    const state = this.savedStates.get(tabId);
    if (!state) return;

    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: false },
        func: (savedState: TabSavedState) => {
          // Restore scroll position
          window.scrollTo(savedState.scroll.x, savedState.scroll.y);

          // Restore form fields
          for (const field of savedState.formFields) {
            const el = document.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
              field.selector
            );
            if (!el) continue;

            if (
              el instanceof HTMLInputElement &&
              (field.type === "checkbox" || field.type === "radio")
            ) {
              el.checked = field.checked ?? false;
            } else {
              el.value = field.value;
            }
          }
        },
        args: [state],
      });

      // Clean up after successful restore
      this.savedStates.delete(tabId);
      await this.clearPersistedState(tabId);
    } catch {
      // If restore fails, leave the state so the user can retry manually
    }
  }

  // ── Storage helpers ─────────────────────────────────────────────────────────

  /**
   * Persists tab state to chrome.storage.session so it survives service-worker
   * restarts within the same browser session.
   */
  private async persistState(state: TabSavedState): Promise<void> {
    const key = `hibernation_state_${state.tabId}`;
    await chrome.storage.session.set({ [key]: state });
  }

  /**
   * Removes persisted state for a specific tab.
   */
  private async clearPersistedState(tabId: number): Promise<void> {
    const key = `hibernation_state_${tabId}`;
    await chrome.storage.session.remove(key);
  }

  /**
   * Loads any previously persisted states from storage on startup.
   * Should be called once when the service worker initialises.
   */
  async loadPersistedStates(): Promise<void> {
    const all = await chrome.storage.session.get(null);
    for (const [key, value] of Object.entries(all)) {
      if (key.startsWith("hibernation_state_") && typeof value === "object") {
        const state = value as TabSavedState;
        this.savedStates.set(state.tabId, state);
        this.totalSavedBytes += state.memorySavedBytes;
      }
    }
  }

  // ── Whitelist matching ──────────────────────────────────────────────────────

  /**
   * Returns true if the given URL matches any whitelist pattern.
   * Supports exact hostname, wildcard prefix "*.example.com", and plain
   * substring matching for simple cases like "localhost".
   */
  private isWhitelisted(url: string): boolean {
    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch {
      return false;
    }

    for (const pattern of this.options.whitelist) {
      if (pattern.startsWith("*.")) {
        // Wildcard subdomain: *.example.com matches foo.example.com
        const suffix = pattern.slice(2);
        if (hostname === suffix || hostname.endsWith(`.${suffix}`)) return true;
      } else if (hostname === pattern || hostname.includes(pattern)) {
        return true;
      }
    }

    return false;
  }

  // ── Utility helpers ─────────────────────────────────────────────────────────

  /**
   * Estimates a tab's memory usage.
   * Tries the chrome.processes API first; falls back to the configured constant.
   */
  private async estimateMemory(tabId: number): Promise<number> {
    if (!("processes" in chrome)) {
      return this.options.fallbackMemoryBytesPerTab;
    }

    return new Promise<number>((resolve) => {
      try {
        (chrome as typeof chrome & { processes: { getProcessIdForTab: (id: number, cb: (pid: number) => void) => void; getProcessInfo: (pids: number[], includeMemory: boolean, cb: (info: Record<number, { privateMemory: number }>) => void) => void } }).processes
          .getProcessIdForTab(tabId, (pid) => {
            (chrome as typeof chrome & { processes: { getProcessIdForTab: (id: number, cb: (pid: number) => void) => void; getProcessInfo: (pids: number[], includeMemory: boolean, cb: (info: Record<number, { privateMemory: number }>) => void) => void } }).processes
              .getProcessInfo([pid], true, (info) => {
                const mem = info[pid]?.privateMemory ?? 0;
                resolve(mem > 0 ? mem : this.options.fallbackMemoryBytesPerTab);
              });
          });
      } catch {
        resolve(this.options.fallbackMemoryBytesPerTab);
      }
    });
  }

  /**
   * Formats a byte count to a human-readable string.
   * e.g. 1,572,864 → "1.5 MB"
   */
  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  // ── Event listeners ─────────────────────────────────────────────────────────

  /** Attaches Chrome event listeners for tab lifecycle management. */
  private attachListeners(): void {
    // Track tab activation times
    chrome.tabs.onActivated.addListener(({ tabId }) => {
      this.lastActivated.set(tabId, Date.now());
      // If this tab was hibernated and just became active, restore its state
      if (this.hibernatedTabs.has(tabId)) {
        this.hibernatedTabs.delete(tabId);
      }
    });

    // Restore state after a tab reloads from hibernation
    chrome.webNavigation.onCompleted.addListener(({ tabId, frameId }) => {
      if (frameId !== 0) return;
      if (this.savedStates.has(tabId)) {
        this.restoreState(tabId);
      }
    });

    // Clean up when a tab is closed
    chrome.tabs.onRemoved.addListener((tabId) => {
      this.lastActivated.delete(tabId);
      this.hibernatedTabs.delete(tabId);
      if (this.savedStates.has(tabId)) {
        this.savedStates.delete(tabId);
        this.clearPersistedState(tabId);
      }
    });

    // Initialise lastActivated for tabs that are already open at install time
    chrome.tabs.query({}, (tabs) => {
      const now = Date.now();
      for (const tab of tabs) {
        if (tab.id !== undefined) this.lastActivated.set(tab.id, now);
      }
    });
  }
}

// ─── Singleton export ─────────────────────────────────────────────────────────

/** Shared TabHibernation instance — call `.start()` from background.js. */
export const tabHibernation = new TabHibernation();
