/**
 * background.js — Quantbrowse AI OS Shell Service Worker
 *
 * Responsibilities:
 *  1. SwarmCoordinator — in-memory manager for up to 1,000 concurrent agent tasks
 *  2. Cross-tab message bus — relay messages between tabs and the background OS
 *  3. AI command handler — orchestrate DOM extraction → API call → response
 *  4. Tab lifecycle management — track which tabs have the content script active
 *  5. Universal Web Clipper — context menu "Save to Quant", screenshot capture,
 *     save-queue management, and AI auto-tagging integration
 *
 * The backend URL is configurable; call
 *   chrome.storage.local.set({ apiBaseUrl: "https://your-app.vercel.app" })
 * from the DevTools console while the extension is loaded in developer mode.
 */

const DEFAULT_API_BASE_URL = "http://localhost:3000";

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
  static MAX_TASKS = 1000;

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
   * Returns all tasks that originated from a specific tab.
   * @param {number} tabId
   * @returns {AgentTask[]}
   */
  getByTab(tabId) {
    return [...this.#tasks.values()].filter((t) => t.tabId === tabId);
  }

  /**
   * Returns a summary of the swarm's current state.
   * @returns {{ total: number, pending: number, running: number, complete: number, failed: number }}
   */
  stats() {
    let pending = 0, running = 0, complete = 0, failed = 0;
    for (const t of this.#tasks.values()) {
      if (t.status === "pending") pending++;
      else if (t.status === "running") running++;
      else if (t.status === "complete") complete++;
      else failed++;
    }
    return { total: this.#tasks.size, pending, running, complete, failed };
  }

  /** Removes the single oldest completed/failed task to free one slot. */
  #evictOldestCompleted() {
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
 * @param {object}  payload       Message object to broadcast
 * @param {number|null} [excludeTabId]  Tab to skip (usually the sender)
 * @returns {Promise<PromiseSettledResult[]>}
 */
async function broadcastToTabs(payload, excludeTabId = null) {
  const sends = [];
  for (const tabId of activeTabs) {
    if (tabId === excludeTabId) continue;
    sends.push(
      chrome.tabs.sendMessage(tabId, payload).catch(() => {
        // Tab navigated or closed — prune the stale entry
        activeTabs.delete(tabId);
      })
    );
  }
  return Promise.allSettled(sends);
}

// Keep activeTabs consistent with tab lifecycle events
chrome.tabs.onRemoved.addListener((tabId) => activeTabs.delete(tabId));

// Auto-register any tab that completes navigation so activeTabs stays accurate
// even when the content script fires before the service worker was ready.
chrome.webNavigation.onCompleted.addListener(({ tabId, frameId }) => {
  // Only care about the top-level frame
  if (frameId !== 0) return;
  activeTabs.add(tabId);
});

// ─── API Helpers ───────────────────────────────────────────────────────────

/**
 * Resolves the current API base URL from chrome.storage (falls back to default).
 * @returns {Promise<string>}
 */
async function getApiBaseUrl() {
  return new Promise((resolve) => {
    chrome.storage.local.get("apiBaseUrl", ({ apiBaseUrl }) => {
      resolve(
        typeof apiBaseUrl === "string" && apiBaseUrl.trim()
          ? apiBaseUrl.trim()
          : DEFAULT_API_BASE_URL
      );
    });
  });
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
    const resp = await chrome.tabs.sendMessage(tabId, { type: "EXTRACT_DOM" });
    if (resp?.success) return resp.domContent ?? "";
  } catch {
    // Content script not running — fall through to injection
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
    const resp = await chrome.tabs.sendMessage(tabId, { type: "EXTRACT_DOM" });
    return resp?.domContent ?? "";
  } catch {
    // Restricted page (chrome://, extensions page, etc.) — proceed with empty context
    return "";
  }
}

// ─── Main Message Handler ──────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const senderTabId = sender.tab?.id ?? null;

  switch (message.type) {
    // ── Content script announces itself ────────────────────────────────────
    case "REGISTER_TAB": {
      if (senderTabId !== null) activeTabs.add(senderTabId);
      sendResponse({ success: true, tabId: senderTabId });
      return false;
    }

    // ── Primary AI command (from popup or the in-page overlay) ─────────────
    case "RUN_AI_COMMAND": {
      const { prompt } = message;

      if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
        sendResponse({ success: false, error: "A non-empty prompt is required." });
        return false;
      }

      if (prompt.length > 2000) {
        sendResponse({ success: false, error: "Prompt exceeds the 2,000-character limit." });
        return false;
      }

      (async () => {
        try {
          // Identify the active tab
          const [tab] = await chrome.tabs.query({
            active: true,
            currentWindow: true,
          });

          if (!tab?.id) {
            sendResponse({ success: false, error: "No active tab found." });
            return;
          }

          // Register the tab and enqueue a new swarm task
          activeTabs.add(tab.id);
          const task = swarm.enqueue(tab.id, prompt.trim());
          swarm.update(task.id, "running");

          // Extract page context and call the AI backend
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
            sendResponse({ success: false, error });
            return;
          }

          const data = await response.json();
          swarm.update(task.id, "complete", { result: data.result });
          sendResponse({ success: true, result: data.result, taskId: task.id });

          // Notify all other tabs that a task completed
          await broadcastToTabs(
            {
              type: "SWARM_BROADCAST",
              payload: { event: "task_complete", taskId: task.id },
            },
            tab.id
          );
        } catch (err) {
          sendResponse({ success: false, error: String(err) });
        }
      })();

      return true; // keep the message channel open for the async response
    }

    // ── Cross-tab relay — forward a payload to all other active tabs ────────
    case "RELAY_TO_TABS": {
      (async () => {
        await broadcastToTabs(
          { type: "SWARM_BROADCAST", payload: message.payload },
          senderTabId
        );
        sendResponse({ success: true });
      })();
      return true;
    }

    // ── Swarm summary stats ─────────────────────────────────────────────────
    case "SWARM_STATS": {
      sendResponse({ success: true, stats: swarm.stats() });
      return false;
    }

    // ── Individual task status lookup ───────────────────────────────────────
    case "TASK_STATUS": {
      const task = swarm.get(message.taskId);
      sendResponse(
        task
          ? { success: true, task }
          : { success: false, error: "Task not found." }
      );
      return false;
    }

    // ── Capture screenshot of the active tab ────────────────────────────────
    case "CAPTURE_SCREENSHOT": {
      (async () => {
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!tab?.windowId) {
            sendResponse({ success: false, error: "No active window found." });
            return;
          }
          const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
            format: "png",
          });

          // If a region was requested, crop in an offscreen canvas via scripting
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
            sendResponse({
              success: true,
              dataUrl: croppedUrl || dataUrl,
            });
          } else {
            sendResponse({ success: true, dataUrl });
          }
        } catch (err) {
          sendResponse({ success: false, error: String(err) });
        }
      })();
      return true;
    }

    // ── Save a clipped item (from content script Alt+S or context menu) ─────
    case "SAVE_CLIP": {
      (async () => {
        try {
          const clip = message.clip;
          if (!clip) {
            sendResponse({ success: false, error: "No clip payload provided." });
            return;
          }

          // Tag the content
          const apiBaseUrl = await getApiBaseUrl();
          const tags = await autoTagClip(clip, apiBaseUrl);

          // Persist to storage queue
          const savedItem = await persistClip(clip, tags);

          // Attempt immediate API save
          const result = await trySaveToApi(savedItem, apiBaseUrl);
          sendResponse({
            success: true,
            item: result.item,
            app: result.item.app,
            isDuplicate: result.isDuplicate,
          });
        } catch (err) {
          sendResponse({ success: false, error: String(err) });
        }
      })();
      return true;
    }

    // ── Sync offline queue ──────────────────────────────────────────────────
    case "SYNC_QUEUE": {
      (async () => {
        try {
          const apiBaseUrl = await getApiBaseUrl();
          const result = await syncOfflineQueue(apiBaseUrl);
          sendResponse({ success: true, ...result });
        } catch (err) {
          sendResponse({ success: false, error: String(err) });
        }
      })();
      return true;
    }

    // ── Get saved items ─────────────────────────────────────────────────────
    case "GET_SAVED_ITEMS": {
      (async () => {
        try {
          const items = await getSavedItems();
          sendResponse({ success: true, items });
        } catch (err) {
          sendResponse({ success: false, error: String(err) });
        }
      })();
      return true;
    }

    // ── Delete a saved item ─────────────────────────────────────────────────
    case "DELETE_SAVED_ITEM": {
      (async () => {
        try {
          await deleteSavedItem(message.itemId);
          sendResponse({ success: true });
        } catch (err) {
          sendResponse({ success: false, error: String(err) });
        }
      })();
      return true;
    }

    // ── Get / manage collections ────────────────────────────────────────────
    case "GET_COLLECTIONS": {
      (async () => {
        try {
          const collections = await getCollections();
          sendResponse({ success: true, collections });
        } catch (err) {
          sendResponse({ success: false, error: String(err) });
        }
      })();
      return true;
    }

    case "SAVE_COLLECTIONS": {
      (async () => {
        try {
          await chrome.storage.local.set({ qba_collections: message.collections });
          sendResponse({ success: true });
        } catch (err) {
          sendResponse({ success: false, error: String(err) });
        }
      })();
      return true;
    }

    default:
      return false;
  }
});

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

