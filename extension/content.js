/**
 * content.js — Quantbrowse AI OS Shell Content Script
 *
 * Responsibilities:
 *  1. Inject the AI Assistant overlay UI via Shadow DOM (zero CSS leakage)
 *  2. Register this tab with the background SwarmCoordinator
 *  3. Extract visible page text for the AI backend
 *  4. Handle cross-tab broadcast messages relayed by the background service worker
 */

// ─── Shadow DOM Overlay ────────────────────────────────────────────────────

const OVERLAY_HOST_ID = "__qba-overlay-host__";

/**
 * Injects the AI Assistant floating UI into a closed Shadow DOM host.
 * Idempotent — safe to call more than once on the same page.
 */
function injectOverlay() {
  if (document.getElementById(OVERLAY_HOST_ID)) return;

  // The host element sits at the very top of <html> with the highest z-index.
  // It has no dimensions of its own so it never disrupts page layout.
  const host = document.createElement("div");
  host.id = OVERLAY_HOST_ID;
  Object.assign(host.style, {
    position: "fixed",
    bottom: "0",
    right: "0",
    width: "0",
    height: "0",
    zIndex: "2147483647",
    pointerEvents: "none",
    overflow: "visible",
  });

  // Closed shadow root — page scripts cannot reach inside.
  const shadow = host.attachShadow({ mode: "closed" });

  shadow.innerHTML = `
    <style>
      /* Reset all inherited styles from the host page */
      :host { all: initial; }

      #qba-fab {
        position: fixed;
        bottom: 20px;
        right: 20px;
        width: 46px;
        height: 46px;
        background: linear-gradient(135deg, #6366f1, #8b5cf6);
        border: none;
        border-radius: 50%;
        box-shadow: 0 4px 20px rgba(99, 102, 241, 0.5);
        cursor: pointer;
        font-size: 20px;
        display: flex;
        align-items: center;
        justify-content: center;
        pointer-events: auto;
        transition: transform 0.15s ease;
        z-index: 2147483647;
      }
      #qba-fab:hover { transform: scale(1.1); }

      #qba-panel {
        position: fixed;
        bottom: 76px;
        right: 20px;
        width: 340px;
        background: #0f0f13;
        border: 1px solid #2a2a3c;
        border-radius: 12px;
        box-shadow: 0 8px 40px rgba(0, 0, 0, 0.6), 0 0 0 1px #6366f133;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 13px;
        color: #e8e8f0;
        overflow: hidden;
        pointer-events: auto;
        display: none;
        z-index: 2147483647;
      }
      #qba-panel.visible { display: block; }

      #qba-header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 14px;
        background: #13131a;
        border-bottom: 1px solid #1e1e2e;
        cursor: move;
        user-select: none;
      }
      #qba-logo {
        width: 22px;
        height: 22px;
        background: linear-gradient(135deg, #6366f1, #8b5cf6);
        border-radius: 6px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 12px;
        flex-shrink: 0;
      }
      #qba-title { font-weight: 600; font-size: 12px; color: #c4c4d4; flex: 1; }
      #qba-close {
        width: 20px;
        height: 20px;
        background: #2a2a3c;
        border: none;
        border-radius: 4px;
        color: #7c7c9c;
        font-size: 12px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        padding: 0;
        line-height: 1;
      }
      #qba-close:hover { background: #3d1a1a; color: #f87171; }

      #qba-body {
        padding: 12px 14px;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      #qba-input {
        width: 100%;
        background: #1a1a24;
        border: 1px solid #2a2a3c;
        border-radius: 8px;
        color: #e8e8f0;
        font-family: inherit;
        font-size: 12px;
        line-height: 1.5;
        padding: 8px 10px;
        resize: none;
        height: 60px;
        outline: none;
        box-sizing: border-box;
        transition: border-color 0.15s;
      }
      #qba-input::placeholder { color: #4a4a6a; }
      #qba-input:focus { border-color: #6366f1; }

      #qba-run {
        width: 100%;
        padding: 8px;
        background: linear-gradient(135deg, #6366f1, #8b5cf6);
        border: none;
        border-radius: 8px;
        color: #fff;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        letter-spacing: 0.2px;
        transition: opacity 0.15s;
      }
      #qba-run:hover:not(:disabled) { opacity: 0.9; }
      #qba-run:disabled { opacity: 0.5; cursor: not-allowed; }

      #qba-status {
        display: none;
        align-items: center;
        gap: 6px;
        font-size: 11px;
        color: #7c7c9c;
      }
      #qba-status.visible { display: flex; }

      .qba-spinner {
        width: 12px;
        height: 12px;
        border: 2px solid #2a2a3c;
        border-top-color: #6366f1;
        border-radius: 50%;
        animation: qba-spin 0.8s linear infinite;
        flex-shrink: 0;
      }
      @keyframes qba-spin { to { transform: rotate(360deg); } }

      #qba-result {
        display: none;
        background: #1a1a24;
        border: 1px solid #2a2a3c;
        border-radius: 8px;
        padding: 8px 10px;
        font-size: 12px;
        line-height: 1.65;
        color: #d4d4e8;
        max-height: 200px;
        overflow-y: auto;
        white-space: pre-wrap;
        word-break: break-word;
      }
      #qba-result.visible { display: block; }
      #qba-result.error { color: #f87171; border-color: #3d1a1a; background: #1c1010; }

      #qba-result::-webkit-scrollbar { width: 4px; }
      #qba-result::-webkit-scrollbar-track { background: transparent; }
      #qba-result::-webkit-scrollbar-thumb { background: #2a2a3c; border-radius: 3px; }
    </style>

    <button id="qba-fab" title="Quantbrowse AI">🤖</button>

    <div id="qba-panel">
      <div id="qba-header">
        <div id="qba-logo">🤖</div>
        <span id="qba-title">Quantbrowse AI</span>
        <button id="qba-close" title="Close">✕</button>
      </div>
      <div id="qba-body">
        <textarea id="qba-input" placeholder="Ask anything about this page…&#10;e.g. &quot;Summarize&quot; or &quot;Extract all links&quot;"></textarea>
        <button id="qba-run">✦ Run AI Command</button>
        <div id="qba-status">
          <div class="qba-spinner"></div>
          <span>Analyzing page…</span>
        </div>
        <div id="qba-result"></div>
      </div>
    </div>
  `;

  // ── Element references ────────────────────────────────────────────────────
  const fab = shadow.getElementById("qba-fab");
  const panel = shadow.getElementById("qba-panel");
  const header = shadow.getElementById("qba-header");
  const closeBtn = shadow.getElementById("qba-close");
  const runBtn = shadow.getElementById("qba-run");
  const inputEl = shadow.getElementById("qba-input");
  const statusEl = shadow.getElementById("qba-status");
  const resultEl = shadow.getElementById("qba-result");

  // ── Panel open/close ──────────────────────────────────────────────────────
  function openPanel() {
    panel.classList.add("visible");
    fab.style.display = "none";
    inputEl.focus();
  }

  function closePanel() {
    panel.classList.remove("visible");
    fab.style.display = "flex";
  }

  function togglePanel() {
    panel.classList.contains("visible") ? closePanel() : openPanel();
  }

  fab.addEventListener("click", openPanel);
  closeBtn.addEventListener("click", closePanel);

  // Ctrl/Cmd+Enter submits from the textarea
  inputEl.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      runCommand();
    }
  });

  runBtn.addEventListener("click", runCommand);

  // ── Loading / result helpers ──────────────────────────────────────────────
  function setLoading(loading) {
    runBtn.disabled = loading;
    statusEl.classList.toggle("visible", loading);
    if (loading) {
      resultEl.classList.remove("visible", "error");
      resultEl.textContent = "";
    }
  }

  function showResult(text, isError = false) {
    resultEl.textContent = text;
    resultEl.classList.add("visible");
    resultEl.classList.toggle("error", isError);
  }

  // ── Run command ───────────────────────────────────────────────────────────
  function runCommand() {
    const prompt = inputEl.value.trim();
    if (!prompt) {
      showResult("⚠ Please enter a command before running.", true);
      return;
    }

    setLoading(true);

    chrome.runtime.sendMessage(
      { type: "RUN_AI_COMMAND", prompt, source: "overlay" },
      (response) => {
        setLoading(false);

        if (chrome.runtime.lastError) {
          showResult(`Error: ${chrome.runtime.lastError.message}`, true);
          return;
        }

        if (!response) {
          showResult("No response received from background.", true);
          return;
        }

        response.success
          ? showResult(response.result)
          : showResult(`⚠ ${response.error ?? "An unknown error occurred."}`, true);
      }
    );
  }

  // ── Drag to reposition ────────────────────────────────────────────────────
  let isDragging = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;

  header.addEventListener("mousedown", (e) => {
    isDragging = true;
    const rect = panel.getBoundingClientRect();
    dragOffsetX = e.clientX - rect.left;
    dragOffsetY = e.clientY - rect.top;
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!isDragging) return;
    const x = e.clientX - dragOffsetX;
    const y = e.clientY - dragOffsetY;
    Object.assign(panel.style, {
      left: `${x}px`,
      top: `${y}px`,
      right: "auto",
      bottom: "auto",
    });
  });

  document.addEventListener("mouseup", () => {
    isDragging = false;
  });

  // ── Mount the host ────────────────────────────────────────────────────────
  document.documentElement.appendChild(host);

  // Expose controlled surface for message-driven interactions
  window.__qbaOverlay__ = { openPanel, closePanel, togglePanel, showResult };
}

// Inject immediately when the content script loads
injectOverlay();

// ─── Keyboard Shortcut — Alt+Q toggles the overlay ────────────────────────

document.addEventListener("keydown", (e) => {
  if (e.altKey && e.key === "q") {
    e.preventDefault();
    window.__qbaOverlay__?.togglePanel();
  }
});

// ─── Tab Registration ──────────────────────────────────────────────────────

// Tell the background SwarmCoordinator that this tab is alive.
chrome.runtime.sendMessage({ type: "REGISTER_TAB" }).catch(() => {
  // Extension may not be ready yet on very early page loads — silently ignore.
});

// ─── Message Listener ──────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    // ── DOM extraction (used by background.js before calling the API) ──────
    case "EXTRACT_DOM": {
      try {
        sendResponse({ success: true, domContent: extractVisibleText() });
      } catch (err) {
        sendResponse({ success: false, error: String(err) });
      }
      return true;
    }

    // ── Overlay control commands (sent from background or other tabs) ──────
    case "OVERLAY_SHOW": {
      window.__qbaOverlay__?.openPanel();
      sendResponse({ success: true });
      return true;
    }

    case "OVERLAY_HIDE": {
      window.__qbaOverlay__?.closePanel();
      sendResponse({ success: true });
      return true;
    }

    case "OVERLAY_RESULT": {
      window.__qbaOverlay__?.showResult(message.text, message.isError ?? false);
      sendResponse({ success: true });
      return true;
    }

    // ── Swarm broadcast (relayed by background to all active tabs) ─────────
    case "SWARM_BROADCAST": {
      // Dispatch as a custom DOM event so page-level code can listen if needed
      window.dispatchEvent(
        new CustomEvent("qba:swarm", { detail: message.payload })
      );
      sendResponse({ success: true });
      return true;
    }

    default:
      return false;
  }
});

// ─── Visible Text Extractor ────────────────────────────────────────────────

/**
 * Extracts visible, human-readable text from the current page.
 * Skips script/style tags and hidden elements.
 *
 * @returns {string} Up to 12,000 characters of visible page text.
 */
function extractVisibleText() {
  const SKIP_TAGS = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "SVG",
    "CANVAS",
    "IFRAME",
    "OBJECT",
    "EMBED",
  ]);

  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        let parent = node.parentElement;
        while (parent) {
          if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
          const style = window.getComputedStyle(parent);
          if (style.display === "none" || style.visibility === "hidden") {
            return NodeFilter.FILTER_REJECT;
          }
          parent = parent.parentElement;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    }
  );

  const parts = [];
  let node;
  while ((node = walker.nextNode())) {
    const text = node.textContent.trim();
    if (text.length > 0) parts.push(text);
  }

  return parts.join(" ").replace(/\s{2,}/g, " ").trim().slice(0, 12000);
}

