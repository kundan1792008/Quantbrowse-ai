import { buildSearchIndex, deepClone, mergeDeep } from "./utils.js";

export const STORAGE_KEYS = {
  collections: "qba_collections",
  offlineQueue: "qba_offline_queue",
  preferences: "qba_preferences",
  stats: "qba_stats",
  meta: "qba_meta",
};

export const DEFAULT_PREFERENCES = {
  autoTagging: true,
  syncEnabled: true,
  syncOnMetered: true,
  summaryMode: "smart",
  clipTextLimit: 20000,
  selectionLimit: 8000,
  defaultCollection: "Inbox",
  highlightColor: "#6366f1",
  showNotifications: true,
  exportIncludeContent: true,
  exportIncludeMetadata: true,
  exportIncludeTags: true,
  exportIncludeHighlights: true,
  sortOrder: "newest",
  viewDensity: "comfortable",
  openCollectionsOnSave: false,
};

export const DEFAULT_STATS = {
  clipsSaved: 0,
  clipsQueued: 0,
  clipsSynced: 0,
  clipsFailed: 0,
  lastSavedAt: null,
  lastSyncedAt: null,
  lastQueueFlushAt: null,
  averageReadTime: 0,
};

export const DEFAULT_META = {
  schemaVersion: 1,
  lastMigrationAt: null,
};

function withDefaults(raw, defaults) {
  return mergeDeep(defaults, raw || {});
}

export class StorageService {
  async getState() {
    const result = await chrome.storage.local.get({
      [STORAGE_KEYS.collections]: [],
      [STORAGE_KEYS.offlineQueue]: [],
      [STORAGE_KEYS.preferences]: DEFAULT_PREFERENCES,
      [STORAGE_KEYS.stats]: DEFAULT_STATS,
      [STORAGE_KEYS.meta]: DEFAULT_META,
    });

    return {
      collections: result[STORAGE_KEYS.collections] || [],
      offlineQueue: result[STORAGE_KEYS.offlineQueue] || [],
      preferences: withDefaults(result[STORAGE_KEYS.preferences], DEFAULT_PREFERENCES),
      stats: withDefaults(result[STORAGE_KEYS.stats], DEFAULT_STATS),
      meta: withDefaults(result[STORAGE_KEYS.meta], DEFAULT_META),
    };
  }

  async ensureSchema() {
    const state = await this.getState();
    await chrome.storage.local.set({
      [STORAGE_KEYS.collections]: state.collections,
      [STORAGE_KEYS.offlineQueue]: state.offlineQueue,
      [STORAGE_KEYS.preferences]: state.preferences,
      [STORAGE_KEYS.stats]: state.stats,
      [STORAGE_KEYS.meta]: state.meta,
    });
    return state;
  }

  async updateCollections(updater) {
    const state = await this.getState();
    const nextCollections = updater(deepClone(state.collections));
    await chrome.storage.local.set({
      [STORAGE_KEYS.collections]: nextCollections,
    });
    return nextCollections;
  }

  async updateQueue(updater) {
    const state = await this.getState();
    const nextQueue = updater(deepClone(state.offlineQueue));
    await chrome.storage.local.set({
      [STORAGE_KEYS.offlineQueue]: nextQueue,
    });
    return nextQueue;
  }

  async updatePreferences(updater) {
    const state = await this.getState();
    const nextPrefs = updater(deepClone(state.preferences));
    await chrome.storage.local.set({
      [STORAGE_KEYS.preferences]: nextPrefs,
    });
    return nextPrefs;
  }

  async updateStats(updater) {
    const state = await this.getState();
    const nextStats = updater(deepClone(state.stats));
    await chrome.storage.local.set({
      [STORAGE_KEYS.stats]: nextStats,
    });
    return nextStats;
  }

  async addClip(clip) {
    const normalized = {
      ...clip,
      searchIndex: buildSearchIndex([
        clip.title,
        clip.excerpt,
        clip.url,
        ...(clip.tags || []).map((tag) => tag.label),
      ]),
    };

    const collections = await this.updateCollections((items) => {
      const existingIndex = items.findIndex((item) => item.id === clip.id);
      if (existingIndex >= 0) {
        items[existingIndex] = normalized;
      } else {
        items.unshift(normalized);
      }
      return items;
    });

    return { clip: normalized, collections };
  }

  async updateClip(clipId, patch) {
    let updatedClip = null;
    const collections = await this.updateCollections((items) => {
      const index = items.findIndex((item) => item.id === clipId);
      if (index < 0) return items;
      const updated = { ...items[index], ...patch };
      updated.searchIndex = buildSearchIndex([
        updated.title,
        updated.excerpt,
        updated.url,
        ...(updated.tags || []).map((tag) => tag.label),
      ]);
      items[index] = updated;
      updatedClip = updated;
      return items;
    });
    return { clip: updatedClip, collections };
  }

  async deleteClip(clipId) {
    return this.updateCollections((items) => items.filter((item) => item.id !== clipId));
  }

  async addQueueItem(queueItem) {
    return this.updateQueue((items) => {
      const existingIndex = items.findIndex((item) => item.id === queueItem.id);
      if (existingIndex >= 0) {
        items[existingIndex] = queueItem;
      } else {
        items.push(queueItem);
      }
      return items;
    });
  }

  async removeQueueItem(queueId) {
    return this.updateQueue((items) => items.filter((item) => item.id !== queueId));
  }

  async replaceQueue(queue) {
    await chrome.storage.local.set({
      [STORAGE_KEYS.offlineQueue]: queue,
    });
    return queue;
  }

  async setPreferences(prefs) {
    const next = withDefaults(prefs, DEFAULT_PREFERENCES);
    await chrome.storage.local.set({
      [STORAGE_KEYS.preferences]: next,
    });
    return next;
  }

  async setStats(stats) {
    const next = withDefaults(stats, DEFAULT_STATS);
    await chrome.storage.local.set({
      [STORAGE_KEYS.stats]: next,
    });
    return next;
  }
}
