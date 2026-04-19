import {
  buildSearchIndex,
  normalizeWhitespace,
  toIsoDate,
} from "./utils.js";

function buildQueueItem(clip) {
  return {
    id: `queue_${clip.id}`,
    clipId: clip.id,
    status: "pending",
    attempts: 0,
    lastError: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

class SyncClient {
  constructor({ getApiBaseUrl }) {
    this.getApiBaseUrl = getApiBaseUrl;
  }

  async syncClip(clip) {
    const apiBaseUrl = await this.getApiBaseUrl();
    if (!apiBaseUrl) return { ok: false, error: "Missing API base URL" };
    try {
      const response = await fetch(`${apiBaseUrl}/api/collections/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clip }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        return { ok: false, error: body.error || `Sync failed (${response.status})` };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  }
}

export class UniversalSaver {
  constructor({ storage, tagger, getApiBaseUrl }) {
    this.storage = storage;
    this.tagger = tagger;
    this.syncClient = new SyncClient({ getApiBaseUrl });
  }

  async saveClip(rawClip) {
    const state = await this.storage.getState();
    const preferences = state.preferences;
    const now = Date.now();

    const clip = {
      ...rawClip,
      collection: rawClip.collection || preferences.defaultCollection || "Inbox",
      updatedAt: now,
    };

    if (preferences.autoTagging) {
      clip.tags = this.tagger.generateTags(clip);
    }

    clip.searchIndex = buildSearchIndex([
      clip.title,
      clip.excerpt,
      clip.url,
      normalizeWhitespace(clip.content?.text || ""),
      ...(clip.tags || []).map((tag) => tag.label),
    ]);

    const { clip: savedClip } = await this.storage.addClip(clip);

    await this.storage.updateStats((stats) => ({
      ...stats,
      clipsSaved: stats.clipsSaved + 1,
      lastSavedAt: now,
    }));

    if (preferences.syncEnabled) {
      await this.enqueueSync(savedClip);
      await this.flushQueue();
    }

    return savedClip;
  }

  async enqueueSync(clip) {
    const queueItem = buildQueueItem(clip);
    const queue = await this.storage.addQueueItem(queueItem);
    await this.storage.updateClip(clip.id, {
      syncState: "queued",
      syncAttempts: 0,
    });

    await this.storage.updateStats((stats) => ({
      ...stats,
      clipsQueued: queue.length,
    }));
    return queueItem;
  }

  async flushQueue() {
    const state = await this.storage.getState();
    const queue = [...state.offlineQueue];
    if (!queue.length) return { synced: 0, failed: 0 };
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      return { synced: 0, failed: 0, offline: true };
    }

    let synced = 0;
    let failed = 0;
    const nextQueue = [];

    for (const item of queue) {
      const clip = state.collections.find((entry) => entry.id === item.clipId);
      if (!clip) continue;

      const result = await this.syncClient.syncClip(clip);
      if (result.ok) {
        synced += 1;
        await this.storage.updateClip(clip.id, {
          syncState: "synced",
          lastSyncedAt: Date.now(),
        });
        await this.storage.updateStats((stats) => ({
          ...stats,
          clipsSynced: stats.clipsSynced + 1,
          lastSyncedAt: Date.now(),
        }));
        continue;
      }

      failed += 1;
      nextQueue.push({
        ...item,
        status: "failed",
        attempts: item.attempts + 1,
        lastError: result.error,
        updatedAt: Date.now(),
      });
      await this.storage.updateClip(clip.id, {
        syncState: "failed",
        syncAttempts: item.attempts + 1,
      });
      await this.storage.updateStats((stats) => ({
        ...stats,
        clipsFailed: stats.clipsFailed + 1,
      }));
    }

    await this.storage.replaceQueue(nextQueue);
    await this.storage.updateStats((stats) => ({
      ...stats,
      clipsQueued: nextQueue.length,
      lastQueueFlushAt: Date.now(),
    }));

    return { synced, failed };
  }

  async refreshTags(clipId) {
    const state = await this.storage.getState();
    const clip = state.collections.find((entry) => entry.id === clipId);
    if (!clip) return null;
    const tags = this.tagger.generateTags(clip);
    const updated = await this.storage.updateClip(clipId, {
      tags,
      updatedAt: Date.now(),
    });
    return updated.clip;
  }

  async updateClip(clipId, patch) {
    return this.storage.updateClip(clipId, {
      ...patch,
      updatedAt: Date.now(),
    });
  }

  async deleteClip(clipId) {
    await this.storage.deleteClip(clipId);
    await this.storage.updateQueue((items) =>
      items.filter((item) => item.clipId !== clipId)
    );
  }

  async exportClips({ clips, format }) {
    const exportTime = toIsoDate(Date.now());
    const payload = {
      exportedAt: exportTime,
      count: clips.length,
      clips,
    };

    switch (format) {
      case "json":
        return {
          mime: "application/json",
          filename: `quantbrowse-clips-${exportTime}.json`,
          content: JSON.stringify(payload, null, 2),
        };
      case "markdown":
        return {
          mime: "text/markdown",
          filename: `quantbrowse-clips-${exportTime}.md`,
          content: clips
            .map(
              (clip) =>
                `### ${clip.title}\n\n${clip.excerpt}\n\n- URL: ${clip.url}\n- Tags: ${(clip.tags || [])
                  .map((tag) => tag.label)
                  .join(", ") || "None"}\n- Saved: ${new Date(
                  clip.createdAt
                ).toLocaleString()}\n\n---\n`
            )
            .join("\n"),
        };
      default:
        return {
          mime: "text/plain",
          filename: `quantbrowse-clips-${exportTime}.txt`,
          content: clips.map((clip) => `${clip.title} - ${clip.url}`).join("\n"),
        };
    }
  }
}
