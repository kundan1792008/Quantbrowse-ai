/**
 * background.js — Quantbrowse AI OS Shell Service Worker
 *
 * Responsibilities:
 *  1. SwarmCoordinator — in-memory manager for up to 1,000 concurrent agent tasks
 *  2. Cross-tab message bus — relay messages between tabs and the background OS
 *  3. AI command handler — orchestrate DOM extraction → API call → response
 *  4. Tab lifecycle management — track which tabs have the content script active
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

    default:
      return false;
  }
});

