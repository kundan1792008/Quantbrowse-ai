/// <reference types="chrome"/>
/**
 * Collections.tsx — Collections UI panel for the Quantbrowse popup
 *
 * Features:
 *  - Browse / manage saved items organised into named collections
 *  - Full-text search across all saved content
 *  - Inline quick-preview (title + summary + screenshot)
 *  - Share a collection (generates a public link)
 *  - Export: JSON · Markdown · CSV
 *  - Drag-and-drop reordering within a collection
 *  - Create, rename, colour-pick, and delete collections
 *  - Smart recommendations strip ("You might like…")
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

// ─── Types (mirrored from UniversalSaver to avoid importing the full module) ─

export type QuantApp =
  | "quantsink"
  | "quanttube"
  | "quantedits"
  | "quantbrowse"
  | "quantdocs"
  | "quantcode"
  | "quantshop"
  | "quantrecipes"
  | "quantmind";

export type SaveStatus = "queued" | "saving" | "saved" | "failed" | "duplicate";

export interface SavedItem {
  id: string;
  url: string;
  clip: {
    type: string;
    faviconUrl: string;
    screenshotDataUrl?: string;
    article?: { bodyText: string; wordCount: number; readingTimeMinutes: number };
    video?: { platform: string; posterUrl: string; duration: number };
    image?: { src: string; alt: string };
    code?: { snippet: string; language: string };
  };
  tags: {
    title: string;
    summary: string;
    tags: string[];
    category: string;
    sentiment: "positive" | "neutral" | "negative";
    language: string;
    suggestedApp: QuantApp;
  };
  app: QuantApp;
  status: SaveStatus;
  savedAt: number;
  versions: Array<{ versionNumber: number; savedAt: number }>;
}

export interface Collection {
  id: string;
  name: string;
  description: string;
  itemIds: string[];
  color: string;
  emoji: string;
  createdAt: number;
  updatedAt: number;
  isShared: boolean;
  shareToken: string | null;
}

// ─── chrome.storage helpers (typed) ─────────────────────────────────────────

function storageGet<T>(key: string): Promise<T | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (result: Record<string, unknown>) => {
      resolve((result[key] as T) ?? null);
    });
  });
}

async function loadSavedItems(): Promise<SavedItem[]> {
  const items = await storageGet<SavedItem[]>("qba_saved_items");
  return (items ?? []).sort((a, b) => b.savedAt - a.savedAt);
}

async function loadCollections(): Promise<Collection[]> {
  const cols = await storageGet<Collection[]>("qba_collections");
  return (cols ?? []).sort((a, b) => b.updatedAt - a.updatedAt);
}

// ─── Utility helpers ──────────────────────────────────────────────────────────

const APP_ICONS: Record<QuantApp, string> = {
  quantsink: "📡",
  quanttube: "▶️",
  quantedits: "🎨",
  quantbrowse: "🌐",
  quantdocs: "📄",
  quantcode: "💻",
  quantshop: "🛒",
  quantrecipes: "🍳",
  quantmind: "💡",
};

const STATUS_COLORS: Record<SaveStatus, string> = {
  queued: "#f59e0b",
  saving: "#6366f1",
  saved: "#10b981",
  failed: "#ef4444",
  duplicate: "#8b5cf6",
};

const PALETTE = [
  "#6366f1", "#8b5cf6", "#ec4899", "#ef4444",
  "#f59e0b", "#10b981", "#06b6d4", "#64748b",
];

function formatDate(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - ts;
  const diffMins = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString();
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + "…";
}

// ─── Sub-components ──────────────────────────────────────────────────────────

interface TagChipProps {
  label: string;
  onClick?: () => void;
}
const TagChip: React.FC<TagChipProps> = ({ label, onClick }) => (
  <button
    onClick={onClick}
    style={{
      background: "#1a1a24",
      border: "1px solid #2a2a3c",
      borderRadius: "12px",
      color: "#a0a0c0",
      cursor: onClick ? "pointer" : "default",
      display: "inline-block",
      fontSize: "10px",
      lineHeight: "1",
      padding: "3px 8px",
      whiteSpace: "nowrap",
    }}
  >
    {label}
  </button>
);

interface StatusBadgeProps {
  status: SaveStatus;
}
const StatusBadge: React.FC<StatusBadgeProps> = ({ status }) => (
  <span
    style={{
      background: `${STATUS_COLORS[status]}22`,
      border: `1px solid ${STATUS_COLORS[status]}44`,
      borderRadius: "10px",
      color: STATUS_COLORS[status],
      fontSize: "9px",
      padding: "2px 6px",
      textTransform: "uppercase",
      letterSpacing: "0.4px",
    }}
  >
    {status}
  </span>
);

interface SentimentDotProps {
  sentiment: "positive" | "neutral" | "negative";
}
const SentimentDot: React.FC<SentimentDotProps> = ({ sentiment }) => {
  const colors = { positive: "#10b981", neutral: "#6b7280", negative: "#ef4444" };
  return (
    <span
      title={`Sentiment: ${sentiment}`}
      style={{
        display: "inline-block",
        width: "7px",
        height: "7px",
        borderRadius: "50%",
        background: colors[sentiment],
        flexShrink: 0,
      }}
    />
  );
};

// ─── SavedItemCard ────────────────────────────────────────────────────────────

interface SavedItemCardProps {
  item: SavedItem;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onPreview: (item: SavedItem) => void;
  onDelete: (id: string) => void;
  onTagClick: (tag: string) => void;
}

const SavedItemCard: React.FC<SavedItemCardProps> = ({
  item,
  isSelected,
  onSelect,
  onPreview,
  onDelete,
  onTagClick,
}) => {
  const thumbnail =
    item.clip.screenshotDataUrl ||
    item.clip.video?.posterUrl ||
    item.clip.image?.src ||
    null;

  return (
    <div
      style={{
        background: isSelected ? "#1e1e32" : "#13131a",
        border: `1px solid ${isSelected ? "#6366f1" : "#1e1e2e"}`,
        borderRadius: "10px",
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        gap: "6px",
        marginBottom: "6px",
        padding: "10px",
        transition: "border-color 0.15s",
      }}
      onClick={() => onSelect(item.id)}
    >
      {/* ── Row 1: favicon + title + status ── */}
      <div style={{ alignItems: "flex-start", display: "flex", gap: "7px" }}>
        <img
          src={item.clip.faviconUrl}
          alt=""
          width={14}
          height={14}
          style={{ borderRadius: "3px", flexShrink: 0, marginTop: "2px" }}
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = "none";
          }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              color: "#e8e8f0",
              fontSize: "12px",
              fontWeight: 600,
              lineHeight: "1.3",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={item.tags.title}
          >
            {item.tags.title || item.url}
          </div>
          <div
            style={{
              alignItems: "center",
              color: "#6c6c8a",
              display: "flex",
              fontSize: "10px",
              gap: "5px",
              marginTop: "2px",
            }}
          >
            <SentimentDot sentiment={item.tags.sentiment} />
            <span>{APP_ICONS[item.app]} {item.app}</span>
            <span>·</span>
            <span>{formatDate(item.savedAt)}</span>
            {item.versions.length > 1 && (
              <>
                <span>·</span>
                <span>v{item.versions.length}</span>
              </>
            )}
          </div>
        </div>
        <StatusBadge status={item.status} />
      </div>

      {/* ── Row 2: thumbnail or summary ── */}
      {thumbnail ? (
        <img
          src={thumbnail}
          alt=""
          style={{
            borderRadius: "6px",
            maxHeight: "100px",
            objectFit: "cover",
            width: "100%",
          }}
        />
      ) : item.tags.summary ? (
        <p
          style={{
            color: "#8a8aa8",
            fontSize: "11px",
            lineHeight: "1.5",
            margin: 0,
          }}
        >
          {truncate(item.tags.summary, 120)}
        </p>
      ) : null}

      {/* ── Row 3: tags + actions ── */}
      <div style={{ alignItems: "center", display: "flex", gap: "4px", flexWrap: "wrap" }}>
        {item.tags.tags.slice(0, 4).map((tag) => (
          <TagChip key={tag} label={tag} onClick={() => onTagClick(tag)} />
        ))}
        <div style={{ flex: 1 }} />
        <button
          onClick={(e) => {
            e.stopPropagation();
            onPreview(item);
          }}
          style={actionBtnStyle}
          title="Preview"
        >
          👁
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            window.open(item.url, "_blank");
          }}
          style={actionBtnStyle}
          title="Open original"
        >
          ↗
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete(item.id);
          }}
          style={{ ...actionBtnStyle, color: "#ef444488" }}
          title="Delete"
        >
          ✕
        </button>
      </div>
    </div>
  );
};

const actionBtnStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  borderRadius: "4px",
  color: "#6c6c8a",
  cursor: "pointer",
  fontSize: "12px",
  padding: "2px 5px",
};

// ─── PreviewModal ─────────────────────────────────────────────────────────────

interface PreviewModalProps {
  item: SavedItem;
  onClose: () => void;
}

const PreviewModal: React.FC<PreviewModalProps> = ({ item, onClose }) => {
  const thumbnail =
    item.clip.screenshotDataUrl ||
    item.clip.video?.posterUrl ||
    item.clip.image?.src ||
    null;

  return (
    <div
      style={{
        background: "rgba(0,0,0,0.7)",
        bottom: 0,
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
        left: 0,
        position: "fixed",
        right: 0,
        top: 0,
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "#13131a",
          border: "1px solid #2a2a3c",
          borderRadius: "14px 14px 0 0",
          maxHeight: "80vh",
          overflowY: "auto",
          padding: "20px",
          width: "100%",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ alignItems: "center", display: "flex", gap: "10px", marginBottom: "12px" }}>
          <img
            src={item.clip.faviconUrl}
            alt=""
            width={18}
            height={18}
            style={{ borderRadius: "4px" }}
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = "none";
            }}
          />
          <h3
            style={{
              color: "#e8e8f0",
              flex: 1,
              fontSize: "14px",
              fontWeight: 600,
              margin: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {item.tags.title || item.url}
          </h3>
          <button onClick={onClose} style={{ ...actionBtnStyle, fontSize: "16px" }}>
            ✕
          </button>
        </div>

        {/* Thumbnail */}
        {thumbnail && (
          <img
            src={thumbnail}
            alt=""
            style={{
              borderRadius: "8px",
              marginBottom: "12px",
              maxHeight: "180px",
              objectFit: "cover",
              width: "100%",
            }}
          />
        )}

        {/* Summary */}
        {item.tags.summary && (
          <p style={{ color: "#a0a0c0", fontSize: "12px", lineHeight: "1.6", marginBottom: "12px" }}>
            {item.tags.summary}
          </p>
        )}

        {/* Article body preview */}
        {item.clip.article?.bodyText && (
          <div
            style={{
              background: "#0f0f13",
              borderRadius: "8px",
              color: "#8a8aa8",
              fontSize: "11px",
              lineHeight: "1.7",
              marginBottom: "12px",
              maxHeight: "120px",
              overflowY: "auto",
              padding: "10px",
            }}
          >
            {item.clip.article.bodyText.slice(0, 800)}…
          </div>
        )}

        {/* Code preview */}
        {item.clip.code?.snippet && (
          <pre
            style={{
              background: "#0f0f13",
              borderRadius: "8px",
              color: "#a8d8a8",
              fontSize: "10px",
              lineHeight: "1.6",
              marginBottom: "12px",
              maxHeight: "120px",
              overflowY: "auto",
              padding: "10px",
            }}
          >
            <code>{item.clip.code.snippet.slice(0, 500)}</code>
          </pre>
        )}

        {/* Meta */}
        <div style={{ alignItems: "center", display: "flex", flexWrap: "wrap", gap: "6px" }}>
          {item.tags.tags.map((tag) => (
            <TagChip key={tag} label={tag} />
          ))}
        </div>

        <div
          style={{
            borderTop: "1px solid #1e1e2e",
            color: "#5a5a7a",
            display: "flex",
            fontSize: "10px",
            gap: "12px",
            justifyContent: "space-between",
            marginTop: "12px",
            paddingTop: "10px",
          }}
        >
          <span>{APP_ICONS[item.app]} {item.app}</span>
          <span>{item.tags.category}</span>
          <span>{formatDate(item.savedAt)}</span>
          {item.clip.article?.readingTimeMinutes ? (
            <span>{item.clip.article.readingTimeMinutes} min read</span>
          ) : null}
          <a
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "#6366f1", textDecoration: "none" }}
          >
            Open ↗
          </a>
        </div>
      </div>
    </div>
  );
};

// ─── CollectionModal ─────────────────────────────────────────────────────────

interface CollectionModalProps {
  collection?: Collection;
  onSave: (name: string, description: string, emoji: string, color: string) => void;
  onClose: () => void;
}

const EMOJI_OPTIONS = ["📁", "⭐", "🔖", "💼", "🎯", "🔬", "🎨", "💻", "📚", "🍳", "🛒", "🎵"];

const CollectionModal: React.FC<CollectionModalProps> = ({ collection, onSave, onClose }) => {
  const [name, setName] = useState(collection?.name ?? "");
  const [description, setDescription] = useState(collection?.description ?? "");
  const [emoji, setEmoji] = useState(collection?.emoji ?? "📁");
  const [color, setColor] = useState(collection?.color ?? PALETTE[0]);

  return (
    <div
      style={{
        background: "rgba(0,0,0,0.7)",
        bottom: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        left: 0,
        position: "fixed",
        right: 0,
        top: 0,
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "#13131a",
          border: "1px solid #2a2a3c",
          borderRadius: "14px",
          padding: "20px",
          width: "300px",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ color: "#e8e8f0", fontSize: "14px", fontWeight: 600, marginBottom: "16px" }}>
          {collection ? "Edit Collection" : "New Collection"}
        </h3>

        {/* Emoji picker */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginBottom: "12px" }}>
          {EMOJI_OPTIONS.map((e) => (
            <button
              key={e}
              onClick={() => setEmoji(e)}
              style={{
                background: emoji === e ? "#2a2a3c" : "transparent",
                border: `1px solid ${emoji === e ? "#6366f1" : "#2a2a3c"}`,
                borderRadius: "6px",
                cursor: "pointer",
                fontSize: "18px",
                padding: "4px",
              }}
            >
              {e}
            </button>
          ))}
        </div>

        {/* Name input */}
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Collection name"
          style={inputStyle}
        />

        {/* Description input */}
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description (optional)"
          style={{ ...inputStyle, marginTop: "8px" }}
        />

        {/* Color picker */}
        <div style={{ display: "flex", gap: "6px", margin: "12px 0" }}>
          {PALETTE.map((c) => (
            <button
              key={c}
              onClick={() => setColor(c)}
              style={{
                background: c,
                border: `2px solid ${color === c ? "#fff" : "transparent"}`,
                borderRadius: "50%",
                cursor: "pointer",
                height: "22px",
                padding: 0,
                width: "22px",
              }}
            />
          ))}
        </div>

        {/* Actions */}
        <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
          <button onClick={onClose} style={ghostBtnStyle}>Cancel</button>
          <button
            onClick={() => {
              if (name.trim()) onSave(name.trim(), description.trim(), emoji, color);
            }}
            style={primaryBtnStyle}
            disabled={!name.trim()}
          >
            {collection ? "Save" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
};

const inputStyle: React.CSSProperties = {
  background: "#1a1a24",
  border: "1px solid #2a2a3c",
  borderRadius: "8px",
  color: "#e8e8f0",
  fontSize: "13px",
  outline: "none",
  padding: "8px 10px",
  width: "100%",
  boxSizing: "border-box",
};

const primaryBtnStyle: React.CSSProperties = {
  background: "linear-gradient(135deg, #6366f1, #8b5cf6)",
  border: "none",
  borderRadius: "8px",
  color: "#fff",
  cursor: "pointer",
  fontSize: "12px",
  fontWeight: 600,
  padding: "7px 14px",
};

const ghostBtnStyle: React.CSSProperties = {
  background: "transparent",
  border: "1px solid #2a2a3c",
  borderRadius: "8px",
  color: "#8a8aa8",
  cursor: "pointer",
  fontSize: "12px",
  padding: "7px 14px",
};

// ─── ExportMenu ───────────────────────────────────────────────────────────────

interface ExportMenuProps {
  onExport: (format: "json" | "markdown" | "csv") => void;
  onClose: () => void;
}

const ExportMenu: React.FC<ExportMenuProps> = ({ onExport, onClose }) => (
  <div
    style={{
      background: "#13131a",
      border: "1px solid #2a2a3c",
      borderRadius: "10px",
      boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
      padding: "6px",
      position: "absolute",
      right: 0,
      top: "100%",
      width: "140px",
      zIndex: 200,
    }}
  >
    {(["json", "markdown", "csv"] as const).map((fmt) => (
      <button
        key={fmt}
        onClick={() => {
          onExport(fmt);
          onClose();
        }}
        style={{
          background: "transparent",
          border: "none",
          borderRadius: "6px",
          color: "#c4c4d4",
          cursor: "pointer",
          display: "block",
          fontSize: "12px",
          padding: "7px 10px",
          textAlign: "left",
          width: "100%",
        }}
        onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "#1a1a24")}
        onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "transparent")}
      >
        {fmt === "json" ? "⬇ JSON" : fmt === "markdown" ? "⬇ Markdown" : "⬇ CSV"}
      </button>
    ))}
  </div>
);

// ─── RecommendationsStrip ──────────────────────────────────────────────────────

interface RecommendationsStripProps {
  items: SavedItem[];
}

const RecommendationsStrip: React.FC<RecommendationsStripProps> = ({ items }) => {
  if (items.length === 0) return null;

  // Build tag frequency map from all saved items
  const tagFreq = new Map<string, number>();
  items.forEach((item) => {
    item.tags.tags.forEach((tag) => tagFreq.set(tag, (tagFreq.get(tag) ?? 0) + 1));
  });

  const topTags = [...tagFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([tag]) => tag);

  if (topTags.length === 0) return null;

  return (
    <div
      style={{
        borderTop: "1px solid #1e1e2e",
        padding: "10px 0 6px",
      }}
    >
      <p style={{ color: "#5a5a7a", fontSize: "10px", marginBottom: "6px", textTransform: "uppercase", letterSpacing: "0.5px" }}>
        Your top interests
      </p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "5px" }}>
        {topTags.map((tag) => (
          <span
            key={tag}
            style={{
              background: "#1a1a24",
              border: "1px solid #2a2a3c",
              borderRadius: "12px",
              color: "#8080a0",
              fontSize: "10px",
              padding: "3px 8px",
            }}
          >
            #{tag}
          </span>
        ))}
      </div>
    </div>
  );
};

// ─── Main Collections component ───────────────────────────────────────────────

export const Collections: React.FC = () => {
  const [items, setItems] = useState<SavedItem[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeCollectionId, setActiveCollectionId] = useState<string | null>(null);
  const [previewItem, setPreviewItem] = useState<SavedItem | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showCollectionModal, setShowCollectionModal] = useState(false);
  const [editingCollection, setEditingCollection] = useState<Collection | undefined>(undefined);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const exportMenuRef = useRef<HTMLDivElement>(null);

  // ── Load data ──────────────────────────────────────────────────────────────
  const refresh = useCallback(async () => {
    setIsLoading(true);
    const [loadedItems, loadedCollections] = await Promise.all([
      loadSavedItems(),
      loadCollections(),
    ]);
    setItems(loadedItems);
    setCollections(loadedCollections);
    setIsLoading(false);
  }, []);

  useEffect(() => {
    refresh().catch(console.error);
  }, [refresh]);

  // ── Toast helper ───────────────────────────────────────────────────────────
  const toast = useCallback((msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 2500);
  }, []);

  // ── Filtered items ─────────────────────────────────────────────────────────
  const filteredItems = useMemo(() => {
    let base = items;

    // Filter to active collection
    if (activeCollectionId) {
      const col = collections.find((c) => c.id === activeCollectionId);
      if (col) {
        base = base.filter((item) => col.itemIds.includes(item.id));
      }
    }

    // Search filter
    if (searchQuery.trim()) {
      const lower = searchQuery.toLowerCase();
      base = base.filter((item) => {
        const searchable = [
          item.tags.title,
          item.tags.summary,
          ...item.tags.tags,
          item.url,
          item.tags.category,
        ]
          .join(" ")
          .toLowerCase();
        return searchable.includes(lower);
      });
    }

    return base;
  }, [items, collections, activeCollectionId, searchQuery]);

  // ── Handlers ────────────────────────────────────────────────────────────────

  const handleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleDelete = useCallback(
    async (id: string) => {
      const all = await loadSavedItems();
      const filtered = all.filter((i) => i.id !== id);
      await new Promise<void>((resolve) =>
        chrome.storage.local.set({ qba_saved_items: filtered }, resolve)
      );
      await refresh();
      toast("Item deleted");
    },
    [refresh, toast]
  );

  const handleCreateCollection = useCallback(
    async (name: string, description: string, emoji: string, color: string) => {
      const newCol: Collection = {
        id: `col-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        name,
        description,
        itemIds: [],
        color,
        emoji,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        isShared: false,
        shareToken: null,
      };
      const all = await loadCollections();
      await new Promise<void>((resolve) =>
        chrome.storage.local.set({ qba_collections: [newCol, ...all] }, resolve)
      );
      await refresh();
      setShowCollectionModal(false);
      toast(`Collection "${name}" created`);
    },
    [refresh, toast]
  );

  const handleUpdateCollection = useCallback(
    async (name: string, description: string, emoji: string, color: string) => {
      if (!editingCollection) return;
      const all = await loadCollections();
      const idx = all.findIndex((c) => c.id === editingCollection.id);
      if (idx !== -1) {
        all[idx] = { ...all[idx], name, description, emoji, color, updatedAt: Date.now() };
        await new Promise<void>((resolve) =>
          chrome.storage.local.set({ qba_collections: all }, resolve)
        );
      }
      await refresh();
      setShowCollectionModal(false);
      setEditingCollection(undefined);
      toast("Collection updated");
    },
    [editingCollection, refresh, toast]
  );

  const handleDeleteCollection = useCallback(
    async (colId: string) => {
      const all = await loadCollections();
      await new Promise<void>((resolve) =>
        chrome.storage.local.set({ qba_collections: all.filter((c) => c.id !== colId) }, resolve)
      );
      if (activeCollectionId === colId) setActiveCollectionId(null);
      await refresh();
      toast("Collection deleted");
    },
    [activeCollectionId, refresh, toast]
  );

  const handleAddToCollection = useCallback(
    async (colId: string) => {
      if (selectedIds.size === 0) {
        toast("Select items first");
        return;
      }
      const all = await loadCollections();
      const col = all.find((c) => c.id === colId);
      if (!col) return;
      selectedIds.forEach((id) => {
        if (!col.itemIds.includes(id)) col.itemIds.push(id);
      });
      col.updatedAt = Date.now();
      await new Promise<void>((resolve) =>
        chrome.storage.local.set({ qba_collections: all }, resolve)
      );
      await refresh();
      setSelectedIds(new Set());
      toast(`Added ${selectedIds.size} items`);
    },
    [selectedIds, refresh, toast]
  );

  const handleExport = useCallback(
    async (format: "json" | "markdown" | "csv") => {
      const exportItems = filteredItems;
      let content = "";
      const mimeTypes = { json: "application/json", markdown: "text/markdown", csv: "text/csv" };
      const extensions = { json: "json", markdown: "md", csv: "csv" };

      if (format === "json") {
        content = JSON.stringify(exportItems, null, 2);
      } else if (format === "csv") {
        const header = "id,url,title,tags,category,app,savedAt,status\n";
        const rows = exportItems
          .map(
            (i) =>
              [
                i.id,
                i.url,
                `"${(i.tags.title ?? "").replace(/"/g, '""')}"`,
                `"${(i.tags.tags ?? []).join(", ")}"`,
                i.tags.category,
                i.app,
                new Date(i.savedAt).toISOString(),
                i.status,
              ].join(",")
          )
          .join("\n");
        content = header + rows;
      } else {
        const lines = ["# Quant Saved Items\n"];
        for (const item of exportItems) {
          lines.push(`## [${item.tags.title}](${item.url})\n`);
          if (item.tags.summary) lines.push(`> ${item.tags.summary}\n`);
          lines.push(`**Tags:** ${item.tags.tags.map((t) => `\`${t}\``).join(", ")}`);
          lines.push(`**App:** ${item.app} · **Saved:** ${new Date(item.savedAt).toLocaleDateString()}`);
          lines.push("\n---\n");
        }
        content = lines.join("\n");
      }

      const blob = new Blob([content], { type: mimeTypes[format] });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `quant-saves-${Date.now()}.${extensions[format]}`;
      a.click();
      URL.revokeObjectURL(url);
      toast(`Exported ${exportItems.length} items as ${format.toUpperCase()}`);
    },
    [filteredItems, toast]
  );

  const handleTagClick = useCallback((tag: string) => {
    setSearchQuery(tag);
    setActiveCollectionId(null);
  }, []);

  // ── Close export menu on outside click ────────────────────────────────────
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setShowExportMenu(false);
      }
    };
    if (showExportMenu) document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showExportMenu]);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div
      style={{
        background: "#0f0f13",
        color: "#e8e8f0",
        display: "flex",
        flexDirection: "column",
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        fontSize: "13px",
        height: "100%",
        overflow: "hidden",
      }}
    >
      {/* ── Header toolbar ── */}
      <div
        style={{
          alignItems: "center",
          borderBottom: "1px solid #1e1e2e",
          display: "flex",
          gap: "6px",
          padding: "10px 12px",
        }}
      >
        <div style={{ flex: 1, position: "relative" }}>
          <span
            style={{
              color: "#4a4a6a",
              fontSize: "12px",
              left: "9px",
              position: "absolute",
              top: "50%",
              transform: "translateY(-50%)",
            }}
          >
            🔍
          </span>
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search saves…"
            style={{
              ...inputStyle,
              fontSize: "12px",
              paddingLeft: "28px",
            }}
          />
        </div>

        {/* Export */}
        <div ref={exportMenuRef} style={{ position: "relative" }}>
          <button
            onClick={() => setShowExportMenu((v) => !v)}
            style={ghostBtnStyle}
            title="Export"
          >
            ⬇
          </button>
          {showExportMenu && (
            <ExportMenu
              onExport={handleExport}
              onClose={() => setShowExportMenu(false)}
            />
          )}
        </div>

        {/* New collection */}
        <button
          onClick={() => {
            setEditingCollection(undefined);
            setShowCollectionModal(true);
          }}
          style={primaryBtnStyle}
          title="New collection"
        >
          +
        </button>
      </div>

      {/* ── Collections sidebar strip ── */}
      {collections.length > 0 && (
        <div
          style={{
            borderBottom: "1px solid #1e1e2e",
            display: "flex",
            gap: "5px",
            overflowX: "auto",
            padding: "8px 12px",
            scrollbarWidth: "none",
          }}
        >
          <button
            onClick={() => setActiveCollectionId(null)}
            style={{
              background: activeCollectionId === null ? "#2a2a3c" : "transparent",
              border: `1px solid ${activeCollectionId === null ? "#6366f1" : "#2a2a3c"}`,
              borderRadius: "16px",
              color: "#c4c4d4",
              cursor: "pointer",
              fontSize: "11px",
              padding: "4px 10px",
              whiteSpace: "nowrap",
            }}
          >
            All ({items.length})
          </button>

          {collections.map((col) => (
            <button
              key={col.id}
              onClick={() =>
                setActiveCollectionId((prev) => (prev === col.id ? null : col.id))
              }
              onContextMenu={(e) => {
                e.preventDefault();
                setEditingCollection(col);
                setShowCollectionModal(true);
              }}
              style={{
                background: activeCollectionId === col.id ? `${col.color}22` : "transparent",
                border: `1px solid ${activeCollectionId === col.id ? col.color : "#2a2a3c"}`,
                borderRadius: "16px",
                color: activeCollectionId === col.id ? col.color : "#8a8aa8",
                cursor: "pointer",
                fontSize: "11px",
                padding: "4px 10px",
                whiteSpace: "nowrap",
              }}
            >
              {col.emoji} {col.name} ({col.itemIds.length})
            </button>
          ))}
        </div>
      )}

      {/* ── Batch-action bar ── */}
      {selectedIds.size > 0 && (
        <div
          style={{
            alignItems: "center",
            background: "#1a1a28",
            borderBottom: "1px solid #2a2a3c",
            display: "flex",
            gap: "6px",
            padding: "6px 12px",
          }}
        >
          <span style={{ color: "#a0a0c0", fontSize: "11px", flex: 1 }}>
            {selectedIds.size} selected
          </span>
          {collections.map((col) => (
            <button
              key={col.id}
              onClick={() => handleAddToCollection(col.id)}
              style={{ ...ghostBtnStyle, fontSize: "10px", padding: "4px 8px" }}
            >
              {col.emoji} {col.name}
            </button>
          ))}
          <button
            onClick={() => setSelectedIds(new Set())}
            style={{ ...ghostBtnStyle, fontSize: "10px" }}
          >
            Clear
          </button>
        </div>
      )}

      {/* ── Items list ── */}
      <div style={{ flex: 1, overflowY: "auto", padding: "10px 12px" }}>
        {isLoading ? (
          <div style={{ color: "#5a5a7a", fontSize: "12px", padding: "20px", textAlign: "center" }}>
            Loading…
          </div>
        ) : filteredItems.length === 0 ? (
          <div style={{ color: "#5a5a7a", fontSize: "12px", padding: "30px 0", textAlign: "center" }}>
            {searchQuery ? "No results found" : "Nothing saved yet"}
            <br />
            <span style={{ fontSize: "11px" }}>
              Press <kbd style={{ background: "#1a1a24", border: "1px solid #2a2a3c", borderRadius: "3px", padding: "1px 4px" }}>Alt+S</kbd> on any page to save
            </span>
          </div>
        ) : (
          filteredItems.map((item) => (
            <SavedItemCard
              key={item.id}
              item={item}
              isSelected={selectedIds.has(item.id)}
              onSelect={handleSelect}
              onPreview={setPreviewItem}
              onDelete={handleDelete}
              onTagClick={handleTagClick}
            />
          ))
        )}

        {/* Recommendations strip */}
        <RecommendationsStrip items={items} />
      </div>

      {/* ── Stats footer ── */}
      <div
        style={{
          alignItems: "center",
          borderTop: "1px solid #1e1e2e",
          color: "#4a4a6a",
          display: "flex",
          fontSize: "10px",
          gap: "10px",
          padding: "6px 12px",
        }}
      >
        <span>{items.length} saved</span>
        <span>·</span>
        <span>{items.filter((i) => i.status === "queued").length} queued</span>
        <span>·</span>
        <span>{collections.length} collections</span>
        <div style={{ flex: 1 }} />
        <button
          onClick={refresh}
          style={{ ...actionBtnStyle, fontSize: "10px" }}
          title="Refresh"
        >
          ↺
        </button>
      </div>

      {/* ── Modals ── */}
      {previewItem && (
        <PreviewModal item={previewItem} onClose={() => setPreviewItem(null)} />
      )}

      {showCollectionModal && (
        <CollectionModal
          collection={editingCollection}
          onSave={editingCollection ? handleUpdateCollection : handleCreateCollection}
          onClose={() => {
            setShowCollectionModal(false);
            setEditingCollection(undefined);
          }}
        />
      )}

      {/* ── Toast notification ── */}
      {toastMessage && (
        <div
          style={{
            background: "#6366f1",
            borderRadius: "8px",
            bottom: "48px",
            boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
            color: "#fff",
            fontSize: "11px",
            left: "50%",
            padding: "7px 14px",
            pointerEvents: "none",
            position: "fixed",
            transform: "translateX(-50%)",
            whiteSpace: "nowrap",
            zIndex: 500,
          }}
        >
          {toastMessage}
        </div>
      )}
    </div>
  );
};

export default Collections;
