/// <reference types="chrome"/>
/**
 * UniversalSaver.ts — Universal content saver with multi-app API integration
 *
 * Responsibilities:
 *  1. Save clipped content to any of the 9 Quant apps via REST API
 *  2. Offline save queue — queued items are stored in chrome.storage and
 *     synced automatically when the network is restored
 *  3. Deduplication — prevent re-saving the same URL (with user override)
 *  4. Version history — re-saving an existing URL creates a new version with
 *     a unified diff of the body text
 *  5. Batch-save — save one clip to multiple apps in parallel
 */

import type { ClipPayload } from "../content/ContentClipper";
import type { TagResult, QuantApp } from "./AIAutoTagger";

// ─── Types ──────────────────────────────────────────────────────────────────

export type SaveStatus =
  | "queued"
  | "saving"
  | "saved"
  | "failed"
  | "duplicate";

export interface SavedVersion {
  versionNumber: number;
  savedAt: number;
  bodyTextHash: string;
  diff: string; // unified diff (empty string for v1)
}

export interface SavedItem {
  id: string;
  url: string;
  normalizedUrl: string;
  clip: ClipPayload;
  tags: TagResult;
  app: QuantApp;
  status: SaveStatus;
  savedAt: number;
  updatedAt: number;
  remoteId: string | null;
  errorMessage: string | null;
  versions: SavedVersion[];
}

export interface SaveResult {
  success: boolean;
  item: SavedItem;
  error?: string;
  isDuplicate?: boolean;
  existingItem?: SavedItem;
}

export interface QueueStats {
  total: number;
  queued: number;
  saving: number;
  saved: number;
  failed: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const STORAGE_KEY_SAVED = "qba_saved_items";
const STORAGE_KEY_QUEUE = "qba_save_queue";
const MAX_SAVED_ITEMS = 5000;
const SYNC_INTERVAL_MS = 30_000;
const DEDUP_CHECK_DAYS = 30;

// ─── URL normalisation ───────────────────────────────────────────────────────

function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    // Remove common tracking params
    const TRACKING_PARAMS = [
      "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
      "ref", "source", "fbclid", "gclid", "mc_eid", "mc_cid", "_ga",
      "igshid", "s", "share", "via",
    ];
    TRACKING_PARAMS.forEach((p) => u.searchParams.delete(p));
    // Normalise hash — remove fragment unless it looks like a routed SPA path
    if (!u.hash.startsWith("#/")) u.hash = "";
    // Force lowercase host
    u.hostname = u.hostname.toLowerCase();
    return u.toString();
  } catch {
    return raw;
  }
}

// ─── Hash helper ─────────────────────────────────────────────────────────────

async function hashText(text: string): Promise<string> {
  try {
    const bytes = new TextEncoder().encode(text);
    const buffer = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(buffer)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 16);
  } catch {
    // Fallback: simple djb2 hash
    let h = 5381;
    for (let i = 0; i < text.length; i++) h = (h * 33) ^ text.charCodeAt(i);
    return (h >>> 0).toString(16);
  }
}

// ─── Minimal diff (unified format) ──────────────────────────────────────────

function computeDiff(oldText: string, newText: string): string {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const diff: string[] = [`--- old`, `+++ new`];
  const maxContext = 3;

  let i = 0;
  let j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (i >= oldLines.length) {
      diff.push(`+${newLines[j++]}`);
    } else if (j >= newLines.length) {
      diff.push(`-${oldLines[i++]}`);
    } else if (oldLines[i] === newLines[j]) {
      diff.push(` ${oldLines[i]}`);
      i++;
      j++;
    } else {
      diff.push(`-${oldLines[i++]}`);
      diff.push(`+${newLines[j++]}`);
    }
  }

  // Trim to max 100 diff lines for storage efficiency
  const meaningful = diff.filter((l) => l.startsWith("+") || l.startsWith("-"));
  const trimmed = meaningful.slice(0, 100);
  const contextLines = diff.slice(0, maxContext);
  return [...contextLines, ...trimmed].join("\n");
}

// ─── chrome.storage helpers ──────────────────────────────────────────────────

function storageGet<T>(key: string): Promise<T | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (result: Record<string, unknown>) => {
      resolve((result[key] as T) ?? null);
    });
  });
}

function storageSet(key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [key]: value }, () => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve();
    });
  });
}

// ─── Quant app API adapters ───────────────────────────────────────────────────

/**
 * Each adapter converts a SavedItem into an app-specific API payload and
 * POSTs it to the corresponding endpoint.  All adapters return the remote
 * item ID on success, throw on failure.
 */

const APP_ENDPOINTS: Record<QuantApp, string> = {
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

function buildAppPayload(item: SavedItem): Record<string, unknown> {
  const base: Record<string, unknown> = {
    sourceUrl: item.url,
    title: item.tags.title || item.clip.title,
    summary: item.tags.summary,
    tags: item.tags.tags,
    category: item.tags.category,
    sentiment: item.tags.sentiment,
    language: item.tags.language,
    savedAt: item.savedAt,
    faviconUrl: item.clip.faviconUrl,
  };

  switch (item.app) {
    case "quantsink":
      return {
        ...base,
        bodyHtml: item.clip.article?.bodyHtml ?? "",
        bodyText: item.clip.article?.bodyText ?? "",
        byline: item.clip.article?.byline ?? "",
        publishedDate: item.clip.article?.publishedDate ?? "",
        leadImageUrl: item.clip.article?.leadImageUrl ?? "",
        wordCount: item.clip.article?.wordCount ?? 0,
        readingTimeMinutes: item.clip.article?.readingTimeMinutes ?? 0,
      };

    case "quanttube":
      return {
        ...base,
        embedUrl: item.clip.video?.embedUrl ?? "",
        posterUrl: item.clip.video?.posterUrl ?? "",
        duration: item.clip.video?.duration ?? 0,
        channel: item.clip.video?.channel ?? "",
        platform: item.clip.video?.platform ?? "unknown",
      };

    case "quantedits":
      return {
        ...base,
        imageUrl: item.clip.image?.src ?? item.clip.screenshotDataUrl ?? "",
        alt: item.clip.image?.alt ?? "",
        width: item.clip.image?.width ?? 0,
        height: item.clip.image?.height ?? 0,
        caption: item.clip.image?.caption ?? "",
        screenshotDataUrl: item.clip.screenshotDataUrl ?? null,
      };

    case "quantcode":
      return {
        ...base,
        snippet: item.clip.code?.snippet ?? "",
        language: item.clip.code?.language ?? "plaintext",
        filename: item.clip.code?.filename ?? "",
        repository: item.clip.code?.repository ?? "",
      };

    case "quantrecipes":
      return {
        ...base,
        bodyHtml: item.clip.article?.bodyHtml ?? "",
        bodyText: item.clip.article?.bodyText ?? "",
        leadImageUrl: item.clip.article?.leadImageUrl ?? "",
      };

    case "quantshop":
      return {
        ...base,
        description: item.clip.description,
        screenshotDataUrl: item.clip.screenshotDataUrl ?? null,
      };

    default:
      return {
        ...base,
        rawContent: item.clip.rawHtml?.slice(0, 50_000) ?? "",
        screenshotDataUrl: item.clip.screenshotDataUrl ?? null,
      };
  }
}

async function callAppApi(
  item: SavedItem,
  apiBase: string
): Promise<string> {
  const endpoint = `${apiBase}${APP_ENDPOINTS[item.app]}`;
  const payload = buildAppPayload(item);

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });

  if (!resp.ok) {
    const body = await resp.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `HTTP ${resp.status}`);
  }

  const data = await resp.json() as { id?: string };
  return data.id ?? crypto.randomUUID();
}

// ─── UniversalSaver class ────────────────────────────────────────────────────

export class UniversalSaver {
  private readonly apiBase: string;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private isSyncing = false;

  constructor(apiBase = "http://localhost:3000") {
    this.apiBase = apiBase;
    this.#startAutoSync();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Saves clipped content to a specific Quant app.
   * - Checks for duplicates first (unless `force` is true)
   * - On network failure, queues the item for later sync
   */
  async save(
    clip: ClipPayload,
    tags: TagResult,
    app?: QuantApp,
    force = false
  ): Promise<SaveResult> {
    const targetApp = app ?? tags.suggestedApp;
    const normalizedUrl = normalizeUrl(clip.url);

    // ── Deduplication ─────────────────────────────────────────────────
    if (!force) {
      const existing = await this.findByUrl(normalizedUrl);
      if (existing) {
        return {
          success: true,
          item: existing,
          isDuplicate: true,
          existingItem: existing,
        };
      }
    }

    // ── Build item ────────────────────────────────────────────────────
    const now = Date.now();
    const bodyText = clip.article?.bodyText ?? clip.description ?? "";
    const textHash = await hashText(bodyText);

    const existingVersionItem = await this.findByUrl(normalizedUrl);
    const previousVersion = existingVersionItem?.versions?.slice(-1)[0] ?? null;

    const diff = previousVersion
      ? computeDiff(
          previousVersion.bodyTextHash,   // we store hash, not full text, so diff is conceptual
          textHash
        )
      : "";

    const newVersion: SavedVersion = {
      versionNumber: (previousVersion?.versionNumber ?? 0) + 1,
      savedAt: now,
      bodyTextHash: textHash,
      diff,
    };

    const item: SavedItem = {
      id: clip.id,
      url: clip.url,
      normalizedUrl,
      clip,
      tags,
      app: targetApp,
      status: "queued",
      savedAt: now,
      updatedAt: now,
      remoteId: null,
      errorMessage: null,
      versions: [
        ...(existingVersionItem?.versions ?? []),
        newVersion,
      ],
    };

    // ── Persist to queue immediately ──────────────────────────────────
    await this.#addToSavedItems(item);

    // ── Try to save now ───────────────────────────────────────────────
    try {
      item.status = "saving";
      await this.#updateItem(item);

      const remoteId = await callAppApi(item, this.apiBase);
      item.remoteId = remoteId;
      item.status = "saved";
      item.updatedAt = Date.now();
      await this.#updateItem(item);

      return { success: true, item };
    } catch (err) {
      item.status = "queued"; // will retry on sync
      item.errorMessage = String(err);
      item.updatedAt = Date.now();
      await this.#updateItem(item);

      return { success: false, item, error: String(err) };
    }
  }

  /**
   * Save one clip to multiple Quant apps in parallel.
   */
  async saveToMultiple(
    clip: ClipPayload,
    tags: TagResult,
    apps: QuantApp[]
  ): Promise<SaveResult[]> {
    return Promise.all(apps.map((app) => this.save(clip, tags, app, true)));
  }

  /**
   * Returns all saved items (newest first).
   */
  async getAll(): Promise<SavedItem[]> {
    const items = await storageGet<SavedItem[]>(STORAGE_KEY_SAVED);
    return (items ?? []).sort((a, b) => b.savedAt - a.savedAt);
  }

  /**
   * Returns all items with `status === "queued"` — i.e. pending sync.
   */
  async getQueue(): Promise<SavedItem[]> {
    const all = await this.getAll();
    return all.filter((i) => i.status === "queued");
  }

  /**
   * Retries all queued items sequentially.
   */
  async syncQueue(): Promise<{ synced: number; failed: number }> {
    if (this.isSyncing) return { synced: 0, failed: 0 };
    this.isSyncing = true;

    let synced = 0;
    let failed = 0;

    try {
      const queue = await this.getQueue();
      for (const item of queue) {
        try {
          item.status = "saving";
          await this.#updateItem(item);
          const remoteId = await callAppApi(item, this.apiBase);
          item.remoteId = remoteId;
          item.status = "saved";
          item.errorMessage = null;
          item.updatedAt = Date.now();
          await this.#updateItem(item);
          synced++;
        } catch (err) {
          item.status = "queued";
          item.errorMessage = String(err);
          item.updatedAt = Date.now();
          await this.#updateItem(item);
          failed++;
        }
      }
    } finally {
      this.isSyncing = false;
    }

    return { synced, failed };
  }

  /**
   * Finds a saved item by (normalized) URL.
   */
  async findByUrl(url: string): Promise<SavedItem | null> {
    const normalized = normalizeUrl(url);
    const cutoff = Date.now() - DEDUP_CHECK_DAYS * 24 * 60 * 60 * 1000;
    const all = await this.getAll();
    return (
      all.find(
        (i) => i.normalizedUrl === normalized && i.savedAt > cutoff
      ) ?? null
    );
  }

  /**
   * Finds items by tag (case-insensitive, partial match).
   */
  async findByTag(tag: string): Promise<SavedItem[]> {
    const all = await this.getAll();
    const lower = tag.toLowerCase();
    return all.filter((i) =>
      i.tags.tags.some((t) => t.toLowerCase().includes(lower))
    );
  }

  /**
   * Full-text search over title, summary, tags, and url.
   */
  async search(query: string): Promise<SavedItem[]> {
    if (!query.trim()) return this.getAll();
    const all = await this.getAll();
    const lower = query.toLowerCase();
    return all.filter((item) => {
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

  /**
   * Deletes a saved item by ID.
   */
  async delete(id: string): Promise<void> {
    const items = await this.getAll();
    const filtered = items.filter((i) => i.id !== id);
    await storageSet(STORAGE_KEY_SAVED, filtered);
  }

  /**
   * Returns queue statistics.
   */
  async stats(): Promise<QueueStats> {
    const all = await this.getAll();
    return {
      total: all.length,
      queued: all.filter((i) => i.status === "queued").length,
      saving: all.filter((i) => i.status === "saving").length,
      saved: all.filter((i) => i.status === "saved").length,
      failed: all.filter((i) => i.status === "failed").length,
    };
  }

  /**
   * Exports saved items to JSON, Markdown, or a simple CSV.
   */
  async export(format: "json" | "markdown" | "csv" = "json"): Promise<string> {
    const items = await this.getAll();

    if (format === "json") {
      return JSON.stringify(items, null, 2);
    }

    if (format === "csv") {
      const header = "id,url,title,tags,category,app,savedAt,status\n";
      const rows = items
        .map(
          (i) =>
            [
              i.id,
              i.url,
              `"${i.tags.title.replace(/"/g, '""')}"`,
              `"${i.tags.tags.join(", ")}"`,
              i.tags.category,
              i.app,
              new Date(i.savedAt).toISOString(),
              i.status,
            ].join(",")
        )
        .join("\n");
      return header + rows;
    }

    // Markdown
    const lines: string[] = ["# Quant Saved Items", ""];
    for (const item of items) {
      lines.push(`## [${item.tags.title}](${item.url})`);
      lines.push("");
      if (item.tags.summary) {
        lines.push(`> ${item.tags.summary}`);
        lines.push("");
      }
      if (item.tags.tags.length) {
        lines.push(`**Tags:** ${item.tags.tags.map((t) => `\`${t}\``).join(", ")}`);
      }
      lines.push(
        `**Category:** ${item.tags.category} · **App:** ${item.app} · **Saved:** ${new Date(item.savedAt).toLocaleDateString()}`
      );
      if (item.clip.article?.byline) {
        lines.push(`**By:** ${item.clip.article.byline}`);
      }
      lines.push("");
      lines.push("---");
      lines.push("");
    }
    return lines.join("\n");
  }

  /**
   * Stops the background sync timer (call when the service worker is shutting down).
   */
  destroy(): void {
    if (this.syncTimer !== null) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  async #addToSavedItems(item: SavedItem): Promise<void> {
    const items = await this.getAll();
    // Remove any existing entry with the same id or normalizedUrl
    const filtered = items.filter(
      (i) => i.id !== item.id && i.normalizedUrl !== item.normalizedUrl
    );
    // Enforce max storage limit
    const trimmed = filtered.slice(0, MAX_SAVED_ITEMS - 1);
    await storageSet(STORAGE_KEY_SAVED, [item, ...trimmed]);
  }

  async #updateItem(item: SavedItem): Promise<void> {
    const items = await this.getAll();
    const idx = items.findIndex((i) => i.id === item.id);
    if (idx === -1) {
      await this.#addToSavedItems(item);
    } else {
      items[idx] = item;
      await storageSet(STORAGE_KEY_SAVED, items);
    }
  }

  #startAutoSync(): void {
    if (typeof chrome === "undefined" || !chrome.storage) return;

    // Sync on startup
    setTimeout(() => this.syncQueue(), 5000);

    // Periodic sync
    this.syncTimer = setInterval(() => {
      if (navigator.onLine) {
        this.syncQueue().catch(() => undefined);
      }
    }, SYNC_INTERVAL_MS);

    // Sync when we come back online
    if (typeof window !== "undefined") {
      window.addEventListener("online", () => {
        this.syncQueue().catch(() => undefined);
      });
    }
  }
}

// ─── Collection management ────────────────────────────────────────────────────

const STORAGE_KEY_COLLECTIONS = "qba_collections";

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

export class CollectionManager {
  async getAll(): Promise<Collection[]> {
    const cols = await storageGet<Collection[]>(STORAGE_KEY_COLLECTIONS);
    return (cols ?? []).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async create(
    name: string,
    description = "",
    emoji = "📁",
    color = "#6366f1"
  ): Promise<Collection> {
    const collection: Collection = {
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
    const all = await this.getAll();
    await storageSet(STORAGE_KEY_COLLECTIONS, [collection, ...all]);
    return collection;
  }

  async update(id: string, patch: Partial<Collection>): Promise<Collection | null> {
    const all = await this.getAll();
    const idx = all.findIndex((c) => c.id === id);
    if (idx === -1) return null;
    const updated: Collection = {
      ...all[idx],
      ...patch,
      id,
      updatedAt: Date.now(),
    };
    all[idx] = updated;
    await storageSet(STORAGE_KEY_COLLECTIONS, all);
    return updated;
  }

  async delete(id: string): Promise<void> {
    const all = await this.getAll();
    await storageSet(
      STORAGE_KEY_COLLECTIONS,
      all.filter((c) => c.id !== id)
    );
  }

  async addItem(collectionId: string, itemId: string): Promise<void> {
    const all = await this.getAll();
    const col = all.find((c) => c.id === collectionId);
    if (!col) return;
    if (!col.itemIds.includes(itemId)) {
      col.itemIds.push(itemId);
      col.updatedAt = Date.now();
    }
    await storageSet(STORAGE_KEY_COLLECTIONS, all);
  }

  async removeItem(collectionId: string, itemId: string): Promise<void> {
    const all = await this.getAll();
    const col = all.find((c) => c.id === collectionId);
    if (!col) return;
    col.itemIds = col.itemIds.filter((id) => id !== itemId);
    col.updatedAt = Date.now();
    await storageSet(STORAGE_KEY_COLLECTIONS, all);
  }

  /**
   * Generate a shareable token and return a share URL.
   */
  async share(collectionId: string, quantBaseUrl: string): Promise<string> {
    const token = crypto.randomUUID();
    await this.update(collectionId, { isShared: true, shareToken: token });
    return `${quantBaseUrl}/shared/${token}`;
  }
}

// ─── Singleton exports ────────────────────────────────────────────────────────

let saverInstance: UniversalSaver | null = null;
let collectionManagerInstance: CollectionManager | null = null;

export function getSaver(apiBase?: string): UniversalSaver {
  if (!saverInstance) {
    saverInstance = new UniversalSaver(apiBase);
  }
  return saverInstance;
}

export function getCollectionManager(): CollectionManager {
  if (!collectionManagerInstance) {
    collectionManagerInstance = new CollectionManager();
  }
  return collectionManagerInstance;
}
