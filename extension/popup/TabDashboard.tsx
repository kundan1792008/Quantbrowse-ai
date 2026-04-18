/**
 * TabDashboard.tsx — Quantbrowse AI Smart Tab Management
 *
 * A React component that renders the full Tab Dashboard inside the extension
 * popup or a dedicated side-panel page.
 *
 * Features:
 *  • Grid view of all open tabs with favicon, title, URL, and memory usage.
 *  • Per-tab "Tab Score" showing a productivity vs. distraction ratio.
 *  • Memory savings indicator driven by TabHibernation.
 *  • One-click group management: hibernate, close, focus, and ungroup.
 *  • Integrated fuzzy search bar backed by TabSearch.
 *  • Topic-group swimlanes with collapsible sections.
 *  • Live refresh every 10 seconds.
 *
 * This file is intentionally self-contained so it can be bundled as a
 * standalone entry-point (e.g. `tab-dashboard.html`) separate from the
 * main popup.  It communicates with the background service worker via
 * chrome.runtime.sendMessage.
 */

import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
} from "react";

// ─── Types ─────────────────────────────────────────────────────────────────────

/** Topic categories mirrored from TabOrganizer.ts */
type TabTopic =
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

/** Productivity classification driving the Tab Score. */
type ProductivityClass = "productive" | "neutral" | "distraction";

/** A fully-enriched tab record used throughout the dashboard. */
interface DashboardTab {
  id: number;
  windowId: number;
  title: string;
  url: string;
  favIconUrl?: string;
  topic: TabTopic;
  memoryMb: number;
  active: boolean;
  audible: boolean;
  pinned: boolean;
  discarded: boolean;
  hibernated: boolean;
  groupId: number;
  /** Calculated score 0–100. */
  tabScore: number;
  productivityClass: ProductivityClass;
  /** ISO string of last activation. */
  lastActivated: string;
  /** Milliseconds the tab has been active. */
  activeTimeMs: number;
}

/** A topic group rendered as a swimlane. */
interface TabGroup {
  topic: TabTopic;
  label: string;
  color: string;
  tabs: DashboardTab[];
  chromeGroupId: number | null;
  collapsed: boolean;
}

/** State returned by the background for the memory savings indicator. */
interface MemorySavings {
  totalSavedBytes: number;
  hibernatedTabCount: number;
  label: string;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

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

const TOPIC_COLORS: Record<TabTopic, string> = {
  work: "#4f87ff",
  social: "#f472b6",
  shopping: "#fbbf24",
  research: "#22d3ee",
  entertainment: "#a78bfa",
  news: "#94a3b8",
  finance: "#4ade80",
  health: "#f87171",
  travel: "#fb923c",
  other: "#6b7280",
};

const PRODUCTIVITY_MAP: Record<TabTopic, ProductivityClass> = {
  work: "productive",
  research: "productive",
  finance: "productive",
  health: "neutral",
  news: "neutral",
  travel: "neutral",
  social: "distraction",
  shopping: "distraction",
  entertainment: "distraction",
  other: "neutral",
};

const PRODUCTIVITY_SCORE: Record<ProductivityClass, number> = {
  productive: 85,
  neutral: 50,
  distraction: 20,
};

const REFRESH_INTERVAL_MS = 10_000;

// ─── Utility functions ─────────────────────────────────────────────────────────

/** Formats bytes to human-readable string. */
function formatMb(mb: number): string {
  if (mb < 1) return `${Math.round(mb * 1024)} KB`;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

/** Truncates a string to maxLen characters with an ellipsis. */
function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? str.slice(0, maxLen - 1) + "…" : str;
}

/** Returns hostname from a URL string, or the raw string on parse failure. */
function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Classifies a tab's topic based on its hostname and title using the same
 * domain-fingerprint approach as TabOrganizer.ts (simplified inline version
 * for the React bundle — avoids a cross-file import at runtime).
 */
function classifyTopic(url: string, title: string): TabTopic {
  const h = hostname(url);
  const text = `${h} ${title}`.toLowerCase();

  if (/github|gitlab|jira|linear|figma|notion|slack|zoom|meet\.google|docs\.google|calendar\.google|confluence|trello|asana/.test(text)) return "work";
  if (/twitter|x\.com|facebook|instagram|linkedin|reddit|tiktok|discord|mastodon|threads|bsky/.test(text)) return "social";
  if (/amazon|ebay|etsy|walmart|target|bestbuy|shopify|aliexpress|wayfair/.test(text)) return "shopping";
  if (/scholar|arxiv|pubmed|wikipedia|stackoverflow|developer\.mozilla|docs\.python|devdocs/.test(text)) return "research";
  if (/youtube|netflix|twitch|hulu|disney|spotify|soundcloud|steam|crunchyroll/.test(text)) return "entertainment";
  if (/bbc|cnn|nytimes|guardian|reuters|apnews|techcrunch|theverge|arstechnica|ycombinator/.test(text)) return "news";
  if (/bloomberg|marketwatch|investing\.com|cnbc|wsj|robinhood|coinbase|binance|tradingview/.test(text)) return "finance";
  if (/webmd|mayoclinic|healthline|nih\.gov|cdc\.gov|who\.int/.test(text)) return "health";
  if (/booking\.com|airbnb|expedia|tripadvisor|kayak|skyscanner/.test(text)) return "travel";
  return "other";
}

// ─── Custom hooks ──────────────────────────────────────────────────────────────

/**
 * Fetches all tabs from the Chrome API (via background message) and enriches
 * them with topic, score, and hibernation data.
 */
function useTabs(refreshTick: number) {
  const [tabs, setTabs] = useState<DashboardTab[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);

    chrome.runtime.sendMessage(
      { type: "GET_ALL_TABS_WITH_STATS" },
      (response) => {
        if (chrome.runtime.lastError || !response?.success) {
          // Fallback: query tabs directly from chrome.tabs API
          chrome.tabs.query({}, (chromeTabs) => {
            const enriched = chromeTabs.map((t) => enrichTab(t, {}));
            setTabs(enriched);
            setLoading(false);
            setError(null);
          });
          return;
        }

        const enriched = (response.tabs as chrome.tabs.Tab[]).map((t) =>
          enrichTab(t, response.hibernatedIds ?? {})
        );
        setTabs(enriched);
        setLoading(false);
        setError(null);
      }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTick]);

  return { tabs, loading, error };
}

/** Converts a Chrome tab to a DashboardTab. */
function enrichTab(
  tab: chrome.tabs.Tab,
  hibernatedIds: Record<number, boolean>
): DashboardTab {
  const topic = classifyTopic(tab.url ?? "", tab.title ?? "");
  const productivityClass = PRODUCTIVITY_MAP[topic];
  const tabScore = PRODUCTIVITY_SCORE[productivityClass];

  return {
    id: tab.id!,
    windowId: tab.windowId,
    title: tab.title ?? "Untitled",
    url: tab.url ?? "",
    favIconUrl: tab.favIconUrl,
    topic,
    memoryMb: 0, // injected externally if available
    active: tab.active,
    audible: tab.audible ?? false,
    pinned: tab.pinned,
    discarded: tab.discarded ?? false,
    hibernated: hibernatedIds[tab.id!] ?? tab.discarded ?? false,
    groupId: tab.groupId ?? -1,
    tabScore,
    productivityClass,
    lastActivated: new Date().toISOString(),
    activeTimeMs: 0,
  };
}

/** Returns memory savings from the background. */
function useMemorySavings(refreshTick: number) {
  const [savings, setSavings] = useState<MemorySavings | null>(null);

  useEffect(() => {
    chrome.runtime.sendMessage(
      { type: "GET_MEMORY_SAVINGS" },
      (response) => {
        if (!chrome.runtime.lastError && response?.success) {
          setSavings(response.savings as MemorySavings);
        }
      }
    );
  }, [refreshTick]);

  return savings;
}

// ─── Sub-components ────────────────────────────────────────────────────────────

interface SearchBarProps {
  value: string;
  onChange: (v: string) => void;
}

/** Fuzzy search input bar. */
const SearchBar: React.FC<SearchBarProps> = ({ value, onChange }) => (
  <div style={styles.searchBar}>
    <span style={styles.searchIcon}>🔍</span>
    <input
      type="text"
      placeholder="Search tabs… (Ctrl+Space)"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={styles.searchInput}
      autoFocus
    />
    {value && (
      <button
        onClick={() => onChange("")}
        style={styles.clearBtn}
        title="Clear search"
        aria-label="Clear search"
      >
        ✕
      </button>
    )}
  </div>
);

interface TabScoreBadgeProps {
  score: number;
  productivityClass: ProductivityClass;
}

/** Coloured badge showing the tab's productivity score. */
const TabScoreBadge: React.FC<TabScoreBadgeProps> = ({ score, productivityClass }) => {
  const color =
    productivityClass === "productive"
      ? "#4ade80"
      : productivityClass === "neutral"
      ? "#fbbf24"
      : "#f87171";

  return (
    <span
      style={{
        ...styles.scoreBadge,
        background: `${color}22`,
        color,
        border: `1px solid ${color}66`,
      }}
      title={`Tab Score: ${score} (${productivityClass})`}
    >
      {score}
    </span>
  );
};

interface TabCardProps {
  tab: DashboardTab;
  onFocus: (id: number) => void;
  onHibernate: (id: number) => void;
  onRestore: (id: number) => void;
  onClose: (id: number) => void;
}

/** Individual tab card rendered in the grid. */
const TabCard: React.FC<TabCardProps> = ({
  tab,
  onFocus,
  onHibernate,
  onRestore,
  onClose,
}) => {
  const [hovered, setHovered] = useState(false);

  const cardStyle: React.CSSProperties = {
    ...styles.tabCard,
    ...(tab.active ? styles.tabCardActive : {}),
    ...(tab.hibernated ? styles.tabCardHibernated : {}),
    ...(hovered ? styles.tabCardHovered : {}),
  };

  return (
    <div
      style={cardStyle}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={tab.url}
    >
      {/* Favicon + title row */}
      <div style={styles.tabCardHeader}>
        <img
          src={tab.favIconUrl || "icons/icon16.png"}
          alt=""
          width={14}
          height={14}
          style={styles.favicon}
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).src = "icons/icon16.png";
          }}
        />
        <span style={styles.tabTitle}>{truncate(tab.title, 36)}</span>
        {tab.audible && <span style={styles.audioBadge} title="Playing audio">🔊</span>}
        {tab.pinned && <span style={styles.pinnedBadge} title="Pinned">📌</span>}
      </div>

      {/* URL row */}
      <div style={styles.tabUrl}>{truncate(hostname(tab.url), 40)}</div>

      {/* Score + memory row */}
      <div style={styles.tabMeta}>
        <TabScoreBadge score={tab.tabScore} productivityClass={tab.productivityClass} />
        {tab.memoryMb > 0 && (
          <span style={styles.memoryBadge}>{formatMb(tab.memoryMb)}</span>
        )}
        {tab.hibernated && (
          <span style={styles.hibernatedBadge} title="Hibernated — click restore to wake">
            💤 Hibernated
          </span>
        )}
      </div>

      {/* Action buttons — only visible on hover */}
      {hovered && (
        <div style={styles.tabActions}>
          {!tab.hibernated ? (
            <>
              <button
                style={styles.actionBtn}
                onClick={() => onFocus(tab.id)}
                title="Focus tab"
              >
                ↗
              </button>
              {!tab.active && !tab.pinned && (
                <button
                  style={styles.actionBtn}
                  onClick={() => onHibernate(tab.id)}
                  title="Hibernate tab"
                >
                  💤
                </button>
              )}
              <button
                style={{ ...styles.actionBtn, ...styles.actionBtnDanger }}
                onClick={() => onClose(tab.id)}
                title="Close tab"
              >
                ✕
              </button>
            </>
          ) : (
            <button
              style={{ ...styles.actionBtn, ...styles.actionBtnRestore }}
              onClick={() => onRestore(tab.id)}
              title="Restore tab"
            >
              ▶ Restore
            </button>
          )}
        </div>
      )}
    </div>
  );
};

interface TopicSwimlaneProps {
  group: TabGroup;
  onToggleCollapse: (topic: TabTopic) => void;
  onFocusTab: (id: number) => void;
  onHibernateTab: (id: number) => void;
  onRestoreTab: (id: number) => void;
  onCloseTab: (id: number) => void;
  onCloseGroup: (topic: TabTopic) => void;
  onHibernateGroup: (topic: TabTopic) => void;
}

/** A collapsible swimlane for one topic group. */
const TopicSwimlane: React.FC<TopicSwimlaneProps> = ({
  group,
  onToggleCollapse,
  onFocusTab,
  onHibernateTab,
  onRestoreTab,
  onCloseTab,
  onCloseGroup,
  onHibernateGroup,
}) => {
  const color = TOPIC_COLORS[group.topic];

  return (
    <div style={styles.swimlane}>
      {/* Swimlane header */}
      <div
        style={{ ...styles.swimlaneHeader, borderLeftColor: color }}
        onClick={() => onToggleCollapse(group.topic)}
      >
        <span style={{ color, fontWeight: 600 }}>{group.label}</span>
        <span style={styles.swimlaneCount}>
          {group.tabs.length} tab{group.tabs.length !== 1 ? "s" : ""}
        </span>

        <div style={styles.swimlaneActions} onClick={(e) => e.stopPropagation()}>
          <button
            style={styles.groupActionBtn}
            onClick={() => onHibernateGroup(group.topic)}
            title={`Hibernate all ${group.label} tabs`}
          >
            💤 All
          </button>
          <button
            style={{ ...styles.groupActionBtn, ...styles.groupActionBtnDanger }}
            onClick={() => onCloseGroup(group.topic)}
            title={`Close all ${group.label} tabs`}
          >
            ✕ All
          </button>
        </div>

        <span style={styles.collapseIcon}>{group.collapsed ? "▶" : "▼"}</span>
      </div>

      {/* Tab grid */}
      {!group.collapsed && (
        <div style={styles.tabGrid}>
          {group.tabs.map((tab) => (
            <TabCard
              key={tab.id}
              tab={tab}
              onFocus={onFocusTab}
              onHibernate={onHibernateTab}
              onRestore={onRestoreTab}
              onClose={onCloseTab}
            />
          ))}
        </div>
      )}
    </div>
  );
};

interface StatsBarProps {
  totalTabs: number;
  hibernatedCount: number;
  productiveCount: number;
  distractionCount: number;
  memorySavings: MemorySavings | null;
}

/** Summary stats bar at the top of the dashboard. */
const StatsBar: React.FC<StatsBarProps> = ({
  totalTabs,
  hibernatedCount,
  productiveCount,
  distractionCount,
  memorySavings,
}) => (
  <div style={styles.statsBar}>
    <div style={styles.statChip}>
      <span style={styles.statValue}>{totalTabs}</span>
      <span style={styles.statLabel}>tabs open</span>
    </div>
    <div style={styles.statChip}>
      <span style={{ ...styles.statValue, color: "#4ade80" }}>{productiveCount}</span>
      <span style={styles.statLabel}>productive</span>
    </div>
    <div style={styles.statChip}>
      <span style={{ ...styles.statValue, color: "#f87171" }}>{distractionCount}</span>
      <span style={styles.statLabel}>distractions</span>
    </div>
    {hibernatedCount > 0 && (
      <div style={styles.statChip}>
        <span style={{ ...styles.statValue, color: "#a78bfa" }}>💤 {hibernatedCount}</span>
        <span style={styles.statLabel}>hibernated</span>
      </div>
    )}
    {memorySavings && memorySavings.totalSavedBytes > 0 && (
      <div style={{ ...styles.statChip, background: "#0d2a1a" }}>
        <span style={{ ...styles.statValue, color: "#4ade80" }}>
          {memorySavings.label}
        </span>
      </div>
    )}
  </div>
);

// ─── Main TabDashboard component ───────────────────────────────────────────────

/**
 * Full-featured Tab Dashboard component.
 *
 * Mount this at the root of `tab-dashboard.html` or embed it inside the popup.
 *
 * ```tsx
 * import React from "react";
 * import { createRoot } from "react-dom/client";
 * import { TabDashboard } from "./TabDashboard";
 *
 * createRoot(document.getElementById("root")!).render(<TabDashboard />);
 * ```
 */
export const TabDashboard: React.FC = () => {
  // Inject keyframe animations once (CSS-in-JS inline styles cannot define @keyframes)
  useEffect(() => {
    const id = "quantbrowse-dashboard-styles";
    if (!document.getElementById(id)) {
      const style = document.createElement("style");
      style.id = id;
      style.textContent = `
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
      `;
      document.head.appendChild(style);
    }
  }, []);
  const [refreshTick, setRefreshTick] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<TabTopic>>(new Set());
  const [notification, setNotification] = useState<string | null>(null);
  const notifTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { tabs, loading } = useTabs(refreshTick);
  const memorySavings = useMemorySavings(refreshTick);

  // Auto-refresh every REFRESH_INTERVAL_MS
  useEffect(() => {
    const handle = setInterval(() => {
      setRefreshTick((t) => t + 1);
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(handle);
  }, []);

  // Keyboard shortcut: Ctrl+Space focuses search bar
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === " ") {
        e.preventDefault();
        const input = document.querySelector<HTMLInputElement>('input[type="text"]');
        input?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  /** Shows a transient notification message. */
  const notify = useCallback((msg: string) => {
    setNotification(msg);
    if (notifTimerRef.current) clearTimeout(notifTimerRef.current);
    notifTimerRef.current = setTimeout(() => setNotification(null), 3000);
  }, []);

  // ── Filter tabs by search query ─────────────────────────────────────────────

  const filteredTabs = useMemo(() => {
    if (!searchQuery.trim()) return tabs;
    const q = searchQuery.toLowerCase();
    return tabs.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        t.url.toLowerCase().includes(q) ||
        hostname(t.url).includes(q)
    );
  }, [tabs, searchQuery]);

  // ── Group tabs by topic ─────────────────────────────────────────────────────

  const groups = useMemo<TabGroup[]>(() => {
    const map = new Map<TabTopic, DashboardTab[]>();

    for (const tab of filteredTabs) {
      const list = map.get(tab.topic) ?? [];
      list.push(tab);
      map.set(tab.topic, list);
    }

    const topicOrder: TabTopic[] = [
      "work",
      "research",
      "finance",
      "news",
      "health",
      "travel",
      "social",
      "shopping",
      "entertainment",
      "other",
    ];

    return topicOrder
      .filter((t) => map.has(t))
      .map((topic) => ({
        topic,
        label: TOPIC_LABELS[topic],
        color: TOPIC_COLORS[topic],
        tabs: map.get(topic)!,
        chromeGroupId: null,
        collapsed: collapsedGroups.has(topic),
      }));
  }, [filteredTabs, collapsedGroups]);

  // ── Computed stats ──────────────────────────────────────────────────────────

  const stats = useMemo(() => {
    const productiveCount = filteredTabs.filter((t) => t.productivityClass === "productive").length;
    const distractionCount = filteredTabs.filter((t) => t.productivityClass === "distraction").length;
    const hibernatedCount = filteredTabs.filter((t) => t.hibernated).length;
    return { productiveCount, distractionCount, hibernatedCount };
  }, [filteredTabs]);

  // ── Tab action handlers ─────────────────────────────────────────────────────

  const handleFocusTab = useCallback((tabId: number) => {
    chrome.runtime.sendMessage({ type: "FOCUS_TAB", tabId }, () => {
      setRefreshTick((t) => t + 1);
    });
  }, []);

  const handleHibernateTab = useCallback(
    (tabId: number) => {
      chrome.runtime.sendMessage({ type: "HIBERNATE_TAB", tabId }, (res) => {
        if (res?.success) {
          notify("Tab hibernated 💤");
          setRefreshTick((t) => t + 1);
        } else {
          notify("Could not hibernate tab: " + (res?.error ?? "unknown error"));
        }
      });
    },
    [notify]
  );

  const handleRestoreTab = useCallback(
    (tabId: number) => {
      chrome.runtime.sendMessage({ type: "RESTORE_TAB", tabId }, (res) => {
        if (res?.success) {
          notify("Tab restored ▶");
          setRefreshTick((t) => t + 1);
        }
      });
    },
    [notify]
  );

  const handleCloseTab = useCallback(
    (tabId: number) => {
      chrome.tabs.remove(tabId, () => {
        setRefreshTick((t) => t + 1);
        notify("Tab closed");
      });
    },
    [notify]
  );

  const handleCloseGroup = useCallback(
    (topic: TabTopic) => {
      const group = groups.find((g) => g.topic === topic);
      if (!group) return;
      const ids = group.tabs.map((t) => t.id);
      chrome.tabs.remove(ids, () => {
        setRefreshTick((t) => t + 1);
        notify(`Closed ${ids.length} ${TOPIC_LABELS[topic]} tab${ids.length !== 1 ? "s" : ""}`);
      });
    },
    [groups, notify]
  );

  const handleHibernateGroup = useCallback(
    (topic: TabTopic) => {
      const group = groups.find((g) => g.topic === topic);
      if (!group) return;
      const ids = group.tabs
        .filter((t) => !t.active && !t.pinned && !t.hibernated)
        .map((t) => t.id);

      chrome.runtime.sendMessage(
        { type: "HIBERNATE_TABS", tabIds: ids },
        (res) => {
          if (res?.hibernated > 0) {
            notify(`Hibernated ${res.hibernated} tab${res.hibernated !== 1 ? "s" : ""} 💤`);
            setRefreshTick((t) => t + 1);
          }
        }
      );
    },
    [groups, notify]
  );

  const handleToggleCollapse = useCallback((topic: TabTopic) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(topic)) next.delete(topic);
      else next.add(topic);
      return next;
    });
  }, []);

  const handleOrganizeTabs = useCallback(() => {
    chrome.runtime.sendMessage({ type: "ORGANIZE_TABS" }, (res) => {
      if (res?.success) {
        notify("Tabs organized into topic groups ✓");
        setRefreshTick((t) => t + 1);
      }
    });
  }, [notify]);

  const handleFindDuplicates = useCallback(() => {
    chrome.runtime.sendMessage({ type: "FIND_DUPLICATES" }, (res) => {
      if (res?.success && res.duplicates?.length > 0) {
        notify(`Found ${res.duplicates.length} duplicate tab${res.duplicates.length !== 1 ? "s" : ""} — closing extras`);
        setTimeout(() => setRefreshTick((t) => t + 1), 500);
      } else {
        notify("No duplicate tabs found ✓");
      }
    });
  }, [notify]);

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div style={styles.root}>
      {/* Header */}
      <div style={styles.header}>
        <div style={styles.headerLeft}>
          <div style={styles.logo}>🤖</div>
          <span style={styles.headerTitle}>Tab Dashboard</span>
        </div>
        <div style={styles.headerActions}>
          <button style={styles.headerBtn} onClick={handleOrganizeTabs} title="Auto-group tabs by topic">
            ✦ Organize
          </button>
          <button style={styles.headerBtn} onClick={handleFindDuplicates} title="Close duplicate tabs">
            🔍 Dupes
          </button>
          <button
            style={styles.headerBtn}
            onClick={() => setRefreshTick((t) => t + 1)}
            title="Refresh dashboard"
          >
            ⟳
          </button>
        </div>
      </div>

      {/* Stats bar */}
      <StatsBar
        totalTabs={filteredTabs.length}
        hibernatedCount={stats.hibernatedCount}
        productiveCount={stats.productiveCount}
        distractionCount={stats.distractionCount}
        memorySavings={memorySavings}
      />

      {/* Search */}
      <SearchBar value={searchQuery} onChange={setSearchQuery} />

      {/* Notification toast */}
      {notification && (
        <div style={styles.notification}>{notification}</div>
      )}

      {/* Content */}
      <div style={styles.content}>
        {loading ? (
          <div style={styles.loadingState}>
            <div style={styles.spinner} />
            <span>Loading tabs…</span>
          </div>
        ) : filteredTabs.length === 0 ? (
          <div style={styles.emptyState}>
            {searchQuery
              ? `No tabs matching "${searchQuery}"`
              : "No tabs open"}
          </div>
        ) : (
          groups.map((group) => (
            <TopicSwimlane
              key={group.topic}
              group={group}
              onToggleCollapse={handleToggleCollapse}
              onFocusTab={handleFocusTab}
              onHibernateTab={handleHibernateTab}
              onRestoreTab={handleRestoreTab}
              onCloseTab={handleCloseTab}
              onCloseGroup={handleCloseGroup}
              onHibernateGroup={handleHibernateGroup}
            />
          ))
        )}
      </div>
    </div>
  );
};

// ─── Styles ────────────────────────────────────────────────────────────────────

/** All CSS-in-JS styles for the dashboard (avoids external stylesheet dependency). */
const styles: Record<string, React.CSSProperties> = {
  root: {
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    background: "#0f0f13",
    color: "#e8e8f0",
    minWidth: 480,
    minHeight: 400,
    display: "flex",
    flexDirection: "column",
  },

  // ── Header ──────────────────────────────────────────────────────────────────
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 16px",
    borderBottom: "1px solid #1e1e2e",
    background: "#13131a",
    flexShrink: 0,
  },
  headerLeft: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  logo: {
    width: 26,
    height: 26,
    background: "linear-gradient(135deg, #6366f1, #8b5cf6)",
    borderRadius: 8,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 14,
  },
  headerTitle: {
    fontWeight: 600,
    fontSize: 14,
    color: "#c4c4d4",
  },
  headerActions: {
    display: "flex",
    gap: 6,
  },
  headerBtn: {
    padding: "5px 10px",
    background: "#1a1a24",
    border: "1px solid #2a2a3c",
    borderRadius: 8,
    color: "#a0a0c0",
    fontSize: 12,
    cursor: "pointer",
  },

  // ── Stats bar ────────────────────────────────────────────────────────────────
  statsBar: {
    display: "flex",
    gap: 8,
    padding: "10px 16px",
    flexWrap: "wrap",
    borderBottom: "1px solid #1e1e2e",
    background: "#13131a",
    flexShrink: 0,
  },
  statChip: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    background: "#1a1a24",
    border: "1px solid #2a2a3c",
    borderRadius: 8,
    padding: "4px 10px",
    minWidth: 60,
  },
  statValue: {
    fontSize: 16,
    fontWeight: 700,
    lineHeight: 1.2,
    color: "#e8e8f0",
  },
  statLabel: {
    fontSize: 10,
    color: "#6c6c8c",
    marginTop: 1,
  },

  // ── Search bar ───────────────────────────────────────────────────────────────
  searchBar: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "10px 16px",
    borderBottom: "1px solid #1e1e2e",
    flexShrink: 0,
  },
  searchIcon: {
    fontSize: 14,
    color: "#6c6c8c",
  },
  searchInput: {
    flex: 1,
    background: "#1a1a24",
    border: "1px solid #2a2a3c",
    borderRadius: 8,
    color: "#e8e8f0",
    fontFamily: "inherit",
    fontSize: 13,
    padding: "7px 10px",
    outline: "none",
  },
  clearBtn: {
    background: "none",
    border: "none",
    color: "#6c6c8c",
    cursor: "pointer",
    fontSize: 12,
    padding: 4,
  },

  // ── Content ──────────────────────────────────────────────────────────────────
  content: {
    flex: 1,
    overflowY: "auto",
    padding: "8px 12px",
  },

  // ── Swimlane ─────────────────────────────────────────────────────────────────
  swimlane: {
    marginBottom: 16,
  },
  swimlaneHeader: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 10px",
    background: "#13131a",
    borderLeft: "3px solid #6366f1",
    borderRadius: "0 6px 6px 0",
    cursor: "pointer",
    marginBottom: 8,
  },
  swimlaneCount: {
    fontSize: 11,
    color: "#6c6c8c",
    marginRight: "auto",
  },
  swimlaneActions: {
    display: "flex",
    gap: 4,
  },
  groupActionBtn: {
    padding: "3px 8px",
    background: "#1a1a24",
    border: "1px solid #2a2a3c",
    borderRadius: 6,
    color: "#a0a0c0",
    fontSize: 11,
    cursor: "pointer",
  },
  groupActionBtnDanger: {
    borderColor: "#3d1a1a",
    color: "#f87171",
  },
  collapseIcon: {
    color: "#4a4a6a",
    fontSize: 11,
    marginLeft: 4,
  },

  // ── Tab grid ─────────────────────────────────────────────────────────────────
  tabGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
    gap: 8,
  },
  tabCard: {
    background: "#1a1a24",
    border: "1px solid #2a2a3c",
    borderRadius: 10,
    padding: "10px 10px 8px",
    position: "relative",
    transition: "border-color 0.15s, background 0.15s",
    minHeight: 80,
  },
  tabCardActive: {
    borderColor: "#6366f1",
    background: "#1a1a30",
  },
  tabCardHibernated: {
    opacity: 0.65,
    borderStyle: "dashed",
  },
  tabCardHovered: {
    borderColor: "#4a4a6a",
    background: "#1e1e2e",
  },
  tabCardHeader: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    marginBottom: 4,
  },
  favicon: {
    flexShrink: 0,
    borderRadius: 2,
  },
  tabTitle: {
    fontSize: 12,
    fontWeight: 500,
    color: "#d4d4e8",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    flex: 1,
  },
  audioBadge: {
    fontSize: 10,
    flexShrink: 0,
  },
  pinnedBadge: {
    fontSize: 10,
    flexShrink: 0,
  },
  tabUrl: {
    fontSize: 10,
    color: "#6c6c8c",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    marginBottom: 6,
  },
  tabMeta: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    flexWrap: "wrap",
  },
  scoreBadge: {
    fontSize: 10,
    fontWeight: 600,
    padding: "1px 6px",
    borderRadius: 10,
  },
  memoryBadge: {
    fontSize: 10,
    color: "#6c6c8c",
  },
  hibernatedBadge: {
    fontSize: 10,
    color: "#a78bfa",
  },
  tabActions: {
    position: "absolute",
    top: 6,
    right: 6,
    display: "flex",
    gap: 4,
    background: "#1a1a24",
    borderRadius: 6,
    padding: "2px 4px",
    border: "1px solid #2a2a3c",
  },
  actionBtn: {
    background: "none",
    border: "none",
    color: "#a0a0c0",
    cursor: "pointer",
    fontSize: 12,
    padding: "2px 4px",
    borderRadius: 4,
  },
  actionBtnDanger: {
    color: "#f87171",
  },
  actionBtnRestore: {
    color: "#a78bfa",
    fontSize: 11,
  },

  // ── States ───────────────────────────────────────────────────────────────────
  loadingState: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    padding: 40,
    color: "#6c6c8c",
    fontSize: 13,
  },
  spinner: {
    width: 18,
    height: 18,
    border: "2px solid #2a2a3c",
    borderTopColor: "#6366f1",
    borderRadius: "50%",
    animation: "spin 0.8s linear infinite",
  },
  emptyState: {
    textAlign: "center",
    padding: 40,
    color: "#6c6c8c",
    fontSize: 13,
  },

  // ── Notification toast ───────────────────────────────────────────────────────
  notification: {
    position: "fixed",
    bottom: 16,
    left: "50%",
    transform: "translateX(-50%)",
    background: "#1e1e2e",
    border: "1px solid #2a2a3c",
    borderRadius: 10,
    padding: "8px 16px",
    fontSize: 12,
    color: "#e8e8f0",
    zIndex: 9999,
    pointerEvents: "none",
    whiteSpace: "nowrap",
  },
};

// ─── Entry-point for standalone tab-dashboard.html ────────────────────────────

/**
 * Call this from a `<script type="module">` tag in `tab-dashboard.html` to
 * mount the TabDashboard component.
 *
 * ```html
 * <div id="root"></div>
 * <script type="module">
 *   import { mountTabDashboard } from "./popup/TabDashboard.js";
 *   mountTabDashboard();
 * </script>
 * ```
 */
export function mountTabDashboard(rootId = "root"): void {
  // Dynamic import of react-dom/client to avoid bundler issues in plain ESM builds
  import("react-dom/client").then(({ createRoot }) => {
    const container = document.getElementById(rootId);
    if (!container) {
      console.error(`[TabDashboard] Could not find root element #${rootId}`);
      return;
    }
    createRoot(container).render(
      React.createElement(TabDashboard)
    );
  });
}
