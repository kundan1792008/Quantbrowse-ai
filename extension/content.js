/**
 * content.js — Quantbrowse AI Ambient + OS Shell Content Script
 *
 * Provides usage heartbeat tracking, dashboard overlay, redirect nudges,
 * AI assistant overlay UI, tab registration, and DOM extraction.
 */

(() => {
  const STATE = {
    heartbeatTimer: null,
    lastHeartbeat: 0,
    dashboardHost: null,
    dashboardRoot: null,
    dashboardVisible: false,
    dashboardData: null,
    nudgeHost: null,
    nudgeCountdownTimer: null,
    nudgeActive: false,
    lastVisibility: document.visibilityState,
  };

  const HEARTBEAT_INTERVAL_MS = 30000;
  const HEARTBEAT_THROTTLE_MS = 5000;
  const DASHBOARD_REFRESH_MS = 60000;
  const DASHBOARD_ID = "quantbrowse-ambient-dashboard";
  const NUDGE_ID = "quantbrowse-ambient-nudge";
  const NUDGE_NO_AUTO_REDIRECT = 0;
  const OVERLAY_HOST_ID = "__qba-overlay-host__";

  const DASHBOARD_CSS = `
    :host { all: initial; }
    .qa-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(7, 7, 12, 0.72);
      z-index: 2147483647;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #e6e6f3;
    }
    .qa-panel {
      width: min(880px, 92vw);
      max-height: min(80vh, 760px);
      background: #101019;
      border: 1px solid #232334;
      border-radius: 18px;
      box-shadow: 0 24px 80px rgba(0, 0, 0, 0.65);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .qa-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 20px;
      background: linear-gradient(135deg, #1b1b2b, #191924);
      border-bottom: 1px solid #24243a;
    }
    .qa-title {
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 16px;
      font-weight: 600;
      letter-spacing: 0.3px;
    }
    .qa-pill {
      padding: 4px 10px;
      border-radius: 999px;
      background: rgba(99, 102, 241, 0.15);
      border: 1px solid rgba(99, 102, 241, 0.4);
      color: #c7c9ff;
      font-size: 12px;
    }
    .qa-close {
      background: none;
      border: none;
      color: #b9b9d0;
      font-size: 20px;
      cursor: pointer;
      padding: 4px 8px;
    }
    .qa-body {
      display: grid;
      grid-template-columns: 1.25fr 1fr;
      gap: 18px;
      padding: 18px 20px 20px;
      overflow: auto;
    }
    .qa-card {
      background: #151523;
      border: 1px solid #24243a;
      border-radius: 16px;
      padding: 14px 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .qa-card h3 {
      font-size: 13px;
      font-weight: 600;
      color: #c3c3dd;
      text-transform: uppercase;
      letter-spacing: 0.12em;
    }
    .qa-stat {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 12px;
      background: #1b1b2b;
      border-radius: 12px;
      border: 1px solid #292941;
      font-size: 13px;
    }
    .qa-stat strong {
      color: #f4f4ff;
      font-size: 14px;
    }
    .qa-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .qa-list-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 12px;
      background: #1a1a2b;
      border-radius: 12px;
      border: 1px solid #2a2a44;
      font-size: 13px;
      color: #d6d6ef;
    }
    .qa-tag {
      padding: 4px 8px;
      border-radius: 999px;
      font-size: 11px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      background: rgba(148, 163, 184, 0.15);
      border: 1px solid rgba(148, 163, 184, 0.4);
      color: #ccd4e7;
    }
    .qa-progress {
      height: 10px;
      border-radius: 999px;
      background: #232337;
      overflow: hidden;
    }
    .qa-progress span {
      display: block;
      height: 100%;
      background: linear-gradient(90deg, #6366f1, #8b5cf6);
    }
    .qa-actions {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 10px;
    }
    .qa-action-btn {
      border: 1px solid #323253;
      background: #1a1a2b;
      color: #e6e6f3;
      padding: 10px 12px;
      border-radius: 12px;
      font-size: 13px;
      cursor: pointer;
      transition: background 0.2s ease;
    }
    .qa-action-btn:hover {
      background: #24243a;
    }
    .qa-footer {
      padding: 14px 20px 18px;
      border-top: 1px solid #24243a;
      font-size: 12px;
      color: #9c9cb6;
      display: flex;
      justify-content: space-between;
      gap: 12px;
    }
    .qa-footer span {
      color: #d3d3ec;
    }
    @media (max-width: 820px) {
      .qa-body {
        grid-template-columns: 1fr;
      }
    }
  `;

  const NUDGE_CSS = `
    :host { all: initial; }
    .qa-nudge {
      position: fixed;
      top: 18px;
      right: 18px;
      width: min(360px, 88vw);
      background: rgba(18, 18, 30, 0.96);
      border: 1px solid #2c2c45;
      border-radius: 16px;
      padding: 14px 16px;
      z-index: 2147483647;
      box-shadow: 0 16px 40px rgba(0, 0, 0, 0.45);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #e7e7f6;
    }
    .qa-nudge-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 6px;
    }
    .qa-nudge-sub {
      font-size: 12px;
      color: #b3b3cc;
      margin-bottom: 12px;
    }
    .qa-nudge-actions {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 8px;
    }
    .qa-nudge-btn {
      border-radius: 10px;
      border: 1px solid #343452;
      background: #1b1b2b;
      color: #eaeaf7;
      padding: 8px 10px;
      font-size: 12px;
      cursor: pointer;
      transition: background 0.2s ease;
    }
    .qa-nudge-btn.primary {
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
      border: none;
    }
    .qa-nudge-btn:hover {
      background: #2a2a44;
    }
    .qa-nudge-btn.primary:hover {
      background: linear-gradient(135deg, #5b5ef0, #7c4dff);
    }
    .qa-nudge-meta {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 10px;
      font-size: 11px;
      color: #9c9cb4;
    }
  `;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }

  function init() {
    injectOverlay();
    registerTab();
    setupMessageListener();
    setupHeartbeat();
    setupVisibility();
    setupShortcuts();
    maybeShowNudge();
  }

  // ─── Overlay UI ───────────────────────────────────────────────────────────

  function injectOverlay() {
    if (document.getElementById(OVERLAY_HOST_ID)) return;

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

    const shadow = host.attachShadow({ mode: "closed" });

    shadow.innerHTML = `
      <style>
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

    const fab = shadow.getElementById("qba-fab");
    const panel = shadow.getElementById("qba-panel");
    const header = shadow.getElementById("qba-header");
    const closeBtn = shadow.getElementById("qba-close");
    const runBtn = shadow.getElementById("qba-run");
    const inputEl = shadow.getElementById("qba-input");
    const statusEl = shadow.getElementById("qba-status");
    const resultEl = shadow.getElementById("qba-result");

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

    inputEl.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        runCommand();
      }
    });

    runBtn.addEventListener("click", runCommand);

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

    let isDragging = false;
    let dragOffsetX = 0;
    let dragOffsetY = 0;

    header.addEventListener("mousedown", (event) => {
      isDragging = true;
      const rect = panel.getBoundingClientRect();
      dragOffsetX = event.clientX - rect.left;
      dragOffsetY = event.clientY - rect.top;
      event.preventDefault();
    });

    document.addEventListener("mousemove", (event) => {
      if (!isDragging) return;
      const x = event.clientX - dragOffsetX;
      const y = event.clientY - dragOffsetY;
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

    document.documentElement.appendChild(host);
    window.__qbaOverlay__ = { openPanel, closePanel, togglePanel, showResult };
  }

  function registerTab() {
    chrome.runtime.sendMessage({ type: "REGISTER_TAB" }).catch(() => {
      // Extension may not be ready yet on very early page loads.
    });
  }

  function setupMessageListener() {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message?.type) return false;

      if (message.type === "EXTRACT_DOM") {
        try {
          const domContent = extractVisibleText();
          sendResponse({ success: true, domContent });
        } catch (err) {
          sendResponse({ success: false, error: String(err) });
        }
        return true;
      }

      if (message.type === "SHOW_DASHBOARD") {
        toggleDashboard();
        sendResponse({ success: true });
        return true;
      }

      if (message.type === "REFRESH_DASHBOARD") {
        refreshDashboard();
        sendResponse({ success: true });
        return true;
      }

      if (message.type === "OVERLAY_SHOW") {
        window.__qbaOverlay__?.openPanel();
        sendResponse({ success: true });
        return true;
      }

      if (message.type === "OVERLAY_HIDE") {
        window.__qbaOverlay__?.closePanel();
        sendResponse({ success: true });
        return true;
      }

      if (message.type === "OVERLAY_RESULT") {
        window.__qbaOverlay__?.showResult(message.text, message.isError ?? false);
        sendResponse({ success: true });
        return true;
      }

      if (message.type === "SWARM_BROADCAST") {
        window.dispatchEvent(new CustomEvent("qba:swarm", { detail: message.payload }));
        sendResponse({ success: true });
        return true;
      }

      return false;
    });
  }

  function setupHeartbeat() {
    sendHeartbeat("init");
    STATE.heartbeatTimer = setInterval(() => sendHeartbeat("interval"), HEARTBEAT_INTERVAL_MS);
  }

  function setupVisibility() {
    document.addEventListener("visibilitychange", () => {
      if (STATE.lastVisibility !== document.visibilityState) {
        STATE.lastVisibility = document.visibilityState;
        sendHeartbeat("visibility");
      }
    });
    window.addEventListener("focus", () => sendHeartbeat("focus"));
    window.addEventListener("blur", () => sendHeartbeat("blur"));
  }

  function setupShortcuts() {
    window.addEventListener("keydown", (event) => {
      if (event.altKey && !event.shiftKey && event.key.toLowerCase() === "q") {
        event.preventDefault();
        window.__qbaOverlay__?.togglePanel();
      }
      if (event.altKey && event.shiftKey && event.key.toLowerCase() === "q") {
        event.preventDefault();
        toggleDashboard();
      }
      if (event.altKey && event.shiftKey && event.key.toLowerCase() === "g") {
        event.preventDefault();
        chrome.runtime.sendMessage({ type: "TRIGGER_GROUP_TABS" });
      }
      if (event.altKey && event.shiftKey && event.key.toLowerCase() === "d") {
        event.preventDefault();
        chrome.runtime.sendMessage({ type: "TRIGGER_DIGEST" });
      }
    });
  }

  function sendHeartbeat(reason) {
    const now = Date.now();
    if (now - STATE.lastHeartbeat < HEARTBEAT_THROTTLE_MS && reason !== "visibility") return;
    STATE.lastHeartbeat = now;
    chrome.runtime.sendMessage({
      type: "PAGE_HEARTBEAT",
      url: location.href,
      title: document.title,
      visibility: document.visibilityState,
      reason,
    });
  }

  function toggleDashboard() {
    if (STATE.dashboardVisible) {
      hideDashboard();
      return;
    }
    showDashboard();
  }

  async function showDashboard() {
    if (!STATE.dashboardHost) {
      STATE.dashboardHost = document.createElement("div");
      STATE.dashboardHost.id = DASHBOARD_ID;
      STATE.dashboardRoot = STATE.dashboardHost.attachShadow({ mode: "open" });
      document.documentElement.appendChild(STATE.dashboardHost);
    }

    STATE.dashboardRoot.innerHTML = `<style>${DASHBOARD_CSS}</style>`;
    const backdrop = document.createElement("div");
    backdrop.className = "qa-backdrop";
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) hideDashboard();
    });

    const panel = document.createElement("div");
    panel.className = "qa-panel";

    const header = document.createElement("div");
    header.className = "qa-header";

    const title = document.createElement("div");
    title.className = "qa-title";
    title.innerHTML = `<span>🌌 Quantbrowse Ambient Intelligence</span>`;

    const pill = document.createElement("span");
    pill.className = "qa-pill";
    pill.textContent = "Live Dashboard";
    title.appendChild(pill);

    const closeBtn = document.createElement("button");
    closeBtn.className = "qa-close";
    closeBtn.textContent = "✕";
    closeBtn.addEventListener("click", hideDashboard);

    header.appendChild(title);
    header.appendChild(closeBtn);

    const body = document.createElement("div");
    body.className = "qa-body";

    const leftColumn = document.createElement("div");
    leftColumn.className = "qa-column";

    const rightColumn = document.createElement("div");
    rightColumn.className = "qa-column";

    leftColumn.appendChild(buildUsageCard());
    leftColumn.appendChild(buildProductivityCard());
    rightColumn.appendChild(buildActionCard());
    rightColumn.appendChild(buildNudgeCard());

    body.appendChild(leftColumn);
    body.appendChild(rightColumn);

    const footer = document.createElement("div");
    footer.className = "qa-footer";
    footer.innerHTML = `<div>Quantbrowse Ambient Engine</div><div><span>Alt+Shift+Q</span> toggles this view.</div>`;

    panel.appendChild(header);
    panel.appendChild(body);
    panel.appendChild(footer);

    backdrop.appendChild(panel);
    STATE.dashboardRoot.appendChild(backdrop);
    STATE.dashboardVisible = true;

    await refreshDashboard();
    scheduleDashboardRefresh();
  }

  function hideDashboard() {
    STATE.dashboardVisible = false;
    if (STATE.dashboardRoot) {
      STATE.dashboardRoot.innerHTML = "";
    }
  }

  function scheduleDashboardRefresh() {
    if (!STATE.dashboardVisible) return;
    setTimeout(() => {
      if (STATE.dashboardVisible) {
        refreshDashboard();
        scheduleDashboardRefresh();
      }
    }, DASHBOARD_REFRESH_MS);
  }

  async function refreshDashboard() {
    const response = await chrome.runtime.sendMessage({ type: "REQUEST_DASHBOARD" });
    if (!response?.success) return;
    STATE.dashboardData = response.dashboard;
    updateUsageCard();
    updateProductivityCard();
    updateNudgeCard();
    updateActionCard();
  }

  function buildUsageCard() {
    const card = document.createElement("div");
    card.className = "qa-card";
    card.dataset.qa = "usage";

    const title = document.createElement("h3");
    title.textContent = "Usage Snapshot";

    const stats = document.createElement("div");
    stats.className = "qa-list";
    stats.dataset.qa = "usage-list";

    card.appendChild(title);
    card.appendChild(stats);
    return card;
  }

  function updateUsageCard() {
    const list = STATE.dashboardRoot.querySelector('[data-qa="usage-list"]');
    if (!list || !STATE.dashboardData) return;
    list.innerHTML = "";

    const total = buildStat("Total focus today", formatDuration(STATE.dashboardData.todayTotal));
    const week = buildStat("Last 7 days", formatDuration(STATE.dashboardData.weekTotal));
    list.appendChild(total);
    list.appendChild(week);

    const top = STATE.dashboardData.todayDomains ?? [];
    top.forEach((entry) => {
      list.appendChild(buildListItem(entry.domain, formatDuration(entry.ms), entry.category));
    });
  }

  function buildProductivityCard() {
    const card = document.createElement("div");
    card.className = "qa-card";
    card.dataset.qa = "productivity";

    const title = document.createElement("h3");
    title.textContent = "Productivity Score";

    const scoreWrap = document.createElement("div");
    scoreWrap.className = "qa-stat";
    scoreWrap.dataset.qa = "score";

    const progress = document.createElement("div");
    progress.className = "qa-progress";
    progress.dataset.qa = "score-bar";
    progress.innerHTML = "<span></span>";

    const streak = document.createElement("div");
    streak.className = "qa-stat";
    streak.dataset.qa = "streak";

    card.appendChild(title);
    card.appendChild(scoreWrap);
    card.appendChild(progress);
    card.appendChild(streak);
    return card;
  }

  function updateProductivityCard() {
    const scoreEl = STATE.dashboardRoot.querySelector('[data-qa="score"]');
    const bar = STATE.dashboardRoot.querySelector('[data-qa="score-bar"] span');
    const streak = STATE.dashboardRoot.querySelector('[data-qa="streak"]');
    if (!scoreEl || !bar || !STATE.dashboardData) return;

    const score = STATE.dashboardData.productivityScore ?? 0;
    const weekScore = STATE.dashboardData.weekScore ?? 0;
    scoreEl.innerHTML = `<div>Today</div><strong>${score}</strong><div>Weekly avg ${weekScore}</div>`;
    bar.style.width = `${score}%`;

    const focus = STATE.dashboardData.focusStreak ?? { currentMinutes: 0, longestMinutes: 0 };
    streak.innerHTML = `<div>Focus streak</div><strong>${focus.currentMinutes}m</strong><div>Best ${focus.longestMinutes}m</div>`;
  }

  function buildActionCard() {
    const card = document.createElement("div");
    card.className = "qa-card";
    card.dataset.qa = "actions";

    const title = document.createElement("h3");
    title.textContent = "Ambient Actions";

    const actions = document.createElement("div");
    actions.className = "qa-actions";

    actions.appendChild(buildActionButton("Group tabs", () => chrome.runtime.sendMessage({ type: "TRIGGER_GROUP_TABS" })));
    actions.appendChild(buildActionButton("Send digest", () => chrome.runtime.sendMessage({ type: "TRIGGER_DIGEST" })));
    actions.appendChild(buildActionButton("Surprise bookmark", () => chrome.runtime.sendMessage({ type: "SURPRISE_BOOKMARK" })));
    actions.appendChild(buildActionButton("Refresh data", refreshDashboard));

    card.appendChild(title);
    card.appendChild(actions);
    return card;
  }

  function updateActionCard() {
    const card = STATE.dashboardRoot.querySelector('[data-qa="actions"]');
    if (!card) return;
  }

  function buildNudgeCard() {
    const card = document.createElement("div");
    card.className = "qa-card";
    card.dataset.qa = "nudges";

    const title = document.createElement("h3");
    title.textContent = "Nudges + Rewards";

    const list = document.createElement("div");
    list.className = "qa-list";
    list.dataset.qa = "nudge-list";

    card.appendChild(title);
    card.appendChild(list);
    return card;
  }

  function updateNudgeCard() {
    const list = STATE.dashboardRoot.querySelector('[data-qa="nudge-list"]');
    if (!list || !STATE.dashboardData) return;
    list.innerHTML = "";

    const nudges = STATE.dashboardData.nudges ?? { totalShown: 0, totalAccepted: 0, totalDismissed: 0 };
    list.appendChild(buildStat("Nudges shown", `${nudges.totalShown}`));
    list.appendChild(buildStat("Nudges accepted", `${nudges.totalAccepted}`));
    list.appendChild(buildStat("Nudges dismissed", `${nudges.totalDismissed}`));

    const rewards = STATE.dashboardData.rewards ?? { totalRewards: 0 };
    list.appendChild(buildStat("Rewards unlocked", `${rewards.totalRewards}`));

    const digest = STATE.dashboardData.digestPreview;
    if (digest?.headline) {
      list.appendChild(buildListItem("Digest preview", digest.headline, "digest"));
    }
  }

  function buildActionButton(label, onClick) {
    const btn = document.createElement("button");
    btn.className = "qa-action-btn";
    btn.textContent = label;
    btn.addEventListener("click", onClick);
    return btn;
  }

  function buildStat(label, value) {
    const stat = document.createElement("div");
    stat.className = "qa-stat";
    stat.innerHTML = `<div>${label}</div><strong>${value}</strong>`;
    return stat;
  }

  function buildListItem(label, value, category) {
    const item = document.createElement("div");
    item.className = "qa-list-item";
    const tag = document.createElement("span");
    tag.className = "qa-tag";
    tag.textContent = category;
    item.innerHTML = `<span>${label}</span><strong>${value}</strong>`;
    item.appendChild(tag);
    return item;
  }

  async function maybeShowNudge() {
    if (STATE.nudgeActive) return;
    const response = await chrome.runtime.sendMessage({
      type: "REQUEST_NUDGE_SETTINGS",
      url: location.href,
    });
    if (!response?.success || !response?.nudge) return;

    STATE.nudgeActive = true;
    const nudge = response.nudge;
    showNudgeOverlay(nudge);
  }

  function showNudgeOverlay(nudge) {
    if (STATE.nudgeHost) {
      STATE.nudgeHost.remove();
    }

    STATE.nudgeHost = document.createElement("div");
    STATE.nudgeHost.id = NUDGE_ID;
    const shadow = STATE.nudgeHost.attachShadow({ mode: "open" });
    shadow.innerHTML = `<style>${NUDGE_CSS}</style>`;

    const wrapper = document.createElement("div");
    wrapper.className = "qa-nudge";

    const header = document.createElement("div");
    header.className = "qa-nudge-header";
    header.textContent = `Pause & Pivot → ${nudge.label}`;

    const sub = document.createElement("div");
    sub.className = "qa-nudge-sub";
    sub.textContent = nudge.tone;

    const actions = document.createElement("div");
    actions.className = "qa-nudge-actions";

    const goBtn = document.createElement("button");
    goBtn.className = "qa-nudge-btn primary";
    goBtn.textContent = `Go to ${nudge.label}`;
    goBtn.addEventListener("click", () => {
      recordNudge("accepted", nudge.domain);
      window.location.href = nudge.target;
    });

    const stayBtn = document.createElement("button");
    stayBtn.className = "qa-nudge-btn";
    stayBtn.textContent = "Stay here";
    stayBtn.addEventListener("click", () => {
      recordNudge("dismissed", nudge.domain);
      dismissNudge();
    });

    actions.appendChild(goBtn);
    actions.appendChild(stayBtn);

    const meta = document.createElement("div");
    meta.className = "qa-nudge-meta";
    const countdown = document.createElement("span");
    countdown.textContent = nudge.autoRedirectSeconds !== NUDGE_NO_AUTO_REDIRECT
      ? `Auto-redirect in ${nudge.autoRedirectSeconds}s`
      : "Manual redirect";

    const close = document.createElement("button");
    close.className = "qa-nudge-btn";
    close.textContent = "Dismiss";
    close.addEventListener("click", () => {
      recordNudge("dismissed", nudge.domain);
      dismissNudge();
    });

    meta.appendChild(countdown);
    meta.appendChild(close);

    wrapper.appendChild(header);
    wrapper.appendChild(sub);
    wrapper.appendChild(actions);
    wrapper.appendChild(meta);

    shadow.appendChild(wrapper);
    document.documentElement.appendChild(STATE.nudgeHost);

    recordNudge("shown", nudge.domain);
    if (nudge.autoRedirectSeconds > NUDGE_NO_AUTO_REDIRECT) {
      let remaining = nudge.autoRedirectSeconds;
      STATE.nudgeCountdownTimer = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) {
          clearInterval(STATE.nudgeCountdownTimer);
          recordNudge("accepted", nudge.domain);
          window.location.href = nudge.target;
        } else {
          countdown.textContent = `Auto-redirect in ${remaining}s`;
        }
      }, 1000);
    }
  }

  function dismissNudge() {
    STATE.nudgeActive = false;
    if (STATE.nudgeCountdownTimer) {
      clearInterval(STATE.nudgeCountdownTimer);
      STATE.nudgeCountdownTimer = null;
    }
    if (STATE.nudgeHost) {
      STATE.nudgeHost.remove();
      STATE.nudgeHost = null;
    }
  }

  function recordNudge(event, domain) {
    chrome.runtime.sendMessage({
      type: "NUDGE_EVENT",
      event,
      domain,
    });
  }

  function formatDuration(ms) {
    const totalSeconds = Math.round(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${Math.max(minutes, 1)}m`;
  }

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

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        let parent = node.parentElement;
        while (parent) {
          if (SKIP_TAGS.has(parent.tagName)) {
            return NodeFilter.FILTER_REJECT;
          }
          const style = window.getComputedStyle(parent);
          if (style.display === "none" || style.visibility === "hidden") {
            return NodeFilter.FILTER_REJECT;
          }
          parent = parent.parentElement;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const parts = [];
    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent.trim();
      if (text.length > 0) {
        parts.push(text);
      }
    }

    const fullText = parts.join(" ").replace(/\s{2,}/g, " ").trim();
    return fullText.slice(0, 12000);
  }
})();
