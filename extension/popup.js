/**
 * popup.js — Quantbrowse AI Popup Script
 *
 * Handles AI commands, ambient dashboard controls, and manages the
 * Collections and Clip tabs.
 */

const promptInput = document.getElementById("promptInput");
const runBtn = document.getElementById("runBtn");
const statusEl = document.getElementById("status");
const resultEl = document.getElementById("result");
const swarmStatsEl = document.getElementById("swarm-stats");
const productivityScoreEl = document.getElementById("productivityScore");
const focusTotalEl = document.getElementById("focusTotal");
const topSitesEl = document.getElementById("topSites");
const digestPreviewEl = document.getElementById("digestPreview");
const openDashboardBtn = document.getElementById("openDashboardBtn");
const groupTabsBtn = document.getElementById("groupTabsBtn");
const digestBtn = document.getElementById("digestBtn");
const surpriseBtn = document.getElementById("surpriseBtn");

// ── Tab management ────────────────────────────────────────────────────────────

const tabBtns = document.querySelectorAll(".tab-btn");
const tabPanels = {
  ambient: document.getElementById("tab-ambient"),
  ai: document.getElementById("tab-ai"),
  collections: document.getElementById("tab-collections"),
  clip: document.getElementById("tab-clip"),
};

let activeTab = "ambient";

tabBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    const tab = btn.dataset.tab;
    if (tab === activeTab) return;
    activeTab = tab;

    tabBtns.forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    Object.entries(tabPanels).forEach(([key, panel]) => {
      if (panel) panel.classList.toggle("active", key === tab);
    });

    if (tab === "collections") {
      renderCollectionsPanel();
    }
  });
});

// ── Ambient dashboard ────────────────────────────────────────────────────────

chrome.storage.local.get("lastPrompt", ({ lastPrompt }) => {
  if (lastPrompt && promptInput) promptInput.value = lastPrompt;
  refreshSwarmStats();
});

if (promptInput) {
  promptInput.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      handleRun();
    }
  });
}

if (runBtn) runBtn.addEventListener("click", handleRun);
if (openDashboardBtn) openDashboardBtn.addEventListener("click", () => sendToActiveTab({ type: "SHOW_DASHBOARD" }));
if (groupTabsBtn) groupTabsBtn.addEventListener("click", () => chrome.runtime.sendMessage({ type: "TRIGGER_GROUP_TABS" }));
if (digestBtn) digestBtn.addEventListener("click", () => chrome.runtime.sendMessage({ type: "TRIGGER_DIGEST" }));
if (surpriseBtn) surpriseBtn.addEventListener("click", () => chrome.runtime.sendMessage({ type: "SURPRISE_BOOKMARK" }));

let refreshInterval = null;
startDashboardRefresh();
window.addEventListener("unload", () => {
  if (refreshInterval) {
    clearInterval(refreshInterval);
  }
});

// ── Swarm stats ──────────────────────────────────────────────────────────────

function refreshSwarmStats() {
  if (!swarmStatsEl) return;
  chrome.runtime.sendMessage({ type: "SWARM_STATS" }, (response) => {
    if (chrome.runtime.lastError || !response?.success) {
      swarmStatsEl.innerHTML = "";
      return;
    }
    const { total, pending, running, complete, failed } = response.stats;
    if (total === 0) {
      swarmStatsEl.innerHTML = "";
      return;
    }
    swarmStatsEl.innerHTML = `
      ${running > 0 ? `<span class="stat-pill"><span class="dot dot-running"></span>${running} running</span>` : ""}
      ${pending > 0 ? `<span class="stat-pill"><span class="dot dot-pending"></span>${pending} pending</span>` : ""}
      ${complete > 0 ? `<span class="stat-pill"><span class="dot dot-complete"></span>${complete} done</span>` : ""}
      ${failed > 0 ? `<span class="stat-pill"><span class="dot dot-failed"></span>${failed} failed</span>` : ""}
    `;
  });
}

function setLoading(loading) {
  if (runBtn) runBtn.disabled = loading;
  if (statusEl) statusEl.classList.toggle("visible", loading);
  if (loading && resultEl) {
    resultEl.classList.remove("visible", "error");
    resultEl.textContent = "";
  }
}

function showResult(text, isError = false) {
  if (!resultEl) return;
  resultEl.textContent = text;
  resultEl.classList.add("visible");
  resultEl.classList.toggle("error", isError);
}

async function handleRun() {
  const prompt = promptInput?.value.trim();
  if (!prompt) {
    showResult("⚠ Please enter a command before running.", true);
    return;
  }

  chrome.storage.local.set({ lastPrompt: prompt });
  setLoading(true);

  chrome.runtime.sendMessage({ type: "RUN_AI_COMMAND", prompt }, (response) => {
    setLoading(false);
    refreshSwarmStats();

    if (chrome.runtime.lastError) {
      showResult(
        `Error communicating with background script:\n${chrome.runtime.lastError.message}`,
        true
      );
      return;
    }

    if (!response) {
      showResult("No response received from the background service.", true);
      return;
    }

    if (response.success) {
      showResult(response.result);
    } else {
      showResult(`⚠ ${response.error ?? "An unknown error occurred."}`, true);
    }
  });
}

async function refreshDashboard() {
  const response = await chrome.runtime.sendMessage({ type: "REQUEST_DASHBOARD" });
  if (!response?.success) return;
  const dashboard = response.dashboard;
  if (!dashboard) return;

  if (productivityScoreEl) productivityScoreEl.textContent = `${dashboard.productivityScore ?? 0}`;
  if (focusTotalEl) focusTotalEl.textContent = formatDuration(dashboard.todayTotal ?? 0);

  const topSites = dashboard.todayDomains ?? [];
  if (topSitesEl) {
    topSitesEl.innerHTML = "";
    if (!topSites.length) {
      const empty = document.createElement("div");
      empty.className = "list-item";
      empty.textContent = "No sites tracked yet.";
      topSitesEl.appendChild(empty);
    } else {
      topSites.forEach((site) => {
        const item = document.createElement("div");
        item.className = "list-item";
        const title = document.createElement("span");
        title.textContent = site.domain;
        const value = document.createElement("strong");
        value.textContent = formatDuration(site.ms);
        const badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = site.category;
        item.appendChild(title);
        item.appendChild(value);
        item.appendChild(badge);
        topSitesEl.appendChild(item);
      });
    }
  }

  if (digestPreviewEl) {
    if (dashboard.digestPreview?.headline) {
      digestPreviewEl.textContent = dashboard.digestPreview.headline;
    } else {
      digestPreviewEl.textContent = "";
    }
  }
}

function startDashboardRefresh() {
  refreshDashboard();
  if (refreshInterval) {
    clearInterval(refreshInterval);
  }
  refreshInterval = setInterval(refreshDashboard, 60000);
}

function formatDuration(ms) {
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours) {
    return `${hours}h ${minutes}m`;
  }
  return `${Math.max(minutes, 1)}m`;
}

function sendToActiveTab(message) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs?.[0];
    if (!tab?.id) {
      showResult("⚠ No active tab available for this action.", true);
      return;
    }
    chrome.tabs.sendMessage(tab.id, message, () => {
      if (chrome.runtime.lastError) {
        showResult(
          `⚠ Unable to reach the page: ${chrome.runtime.lastError.message}`,
          true
        );
      }
    });
  });
}

// ── Clip tab ──────────────────────────────────────────────────────────────────

const clipPageBtn = document.getElementById("clipPageBtn");
const clipPickBtn = document.getElementById("clipPickBtn");
const clipScreenBtn = document.getElementById("clipScreenBtn");
const clipStatusEl = document.getElementById("clip-status");
const clipStatusText = document.getElementById("clip-status-text");
const clipResultEl = document.getElementById("clip-result");

function setClipLoading(loading, text = "Saving…") {
  if (clipStatusEl) clipStatusEl.style.display = loading ? "flex" : "none";
  if (clipStatusText) clipStatusText.textContent = text;
  if (clipPageBtn) clipPageBtn.disabled = loading;
  if (clipPickBtn) clipPickBtn.disabled = loading;
  if (clipScreenBtn) clipScreenBtn.disabled = loading;
}

function showClipResult(html, isError = false) {
  if (!clipResultEl) return;
  clipResultEl.style.display = "block";
  clipResultEl.style.color = isError ? "#f87171" : "#d4d4e8";
  clipResultEl.style.borderColor = isError ? "#3d1a1a" : "#2a2a3c";
  clipResultEl.style.background = isError ? "#1c1010" : "#1a1a24";
  clipResultEl.innerHTML = html;
}

async function sendClipMessage(type) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id;
      if (!tabId) { reject(new Error("No active tab")); return; }
      chrome.tabs.sendMessage(tabId, { type }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response?.success) reject(new Error(response?.error || "Failed"));
        else resolve(response);
      });
    });
  });
}

async function handleClipPage() {
  setClipLoading(true, "Extracting page content…");
  clipResultEl.style.display = "none";
  try {
    const resp = await sendClipMessage("CLIP_FULL_PAGE");
    setClipLoading(true, "Saving to Quant…");
    chrome.runtime.sendMessage({ type: "SAVE_CLIP", clip: resp.clip }, (saveResp) => {
      setClipLoading(false);
      if (chrome.runtime.lastError || !saveResp?.success) {
        showClipResult(`⚠ ${saveResp?.error || "Save failed"}`, true);
        return;
      }
      const item = saveResp.item;
      showClipResult(`
        <strong style="display:block;margin-bottom:4px">✓ Saved to ${item.app}</strong>
        <span style="color:#8a8aa8;font-size:11px">${item.tags?.title || item.url}</span>
      `);
    });
  } catch (err) {
    setClipLoading(false);
    showClipResult(`⚠ ${err.message}`, true);
  }
}

async function handleClipPick() {
  setClipLoading(true, "Click an element on the page…");
  clipResultEl.style.display = "none";
  try {
    const resp = await sendClipMessage("START_ELEMENT_PICKER");
    setClipLoading(true, "Saving to Quant…");
    chrome.runtime.sendMessage({ type: "SAVE_CLIP", clip: resp.clip }, (saveResp) => {
      setClipLoading(false);
      if (chrome.runtime.lastError || !saveResp?.success) {
        showClipResult(`⚠ ${saveResp?.error || "Save failed"}`, true);
        return;
      }
      const item = saveResp.item;
      showClipResult(`
        <strong style="display:block;margin-bottom:4px">✓ Saved to ${item.app}</strong>
        <span style="color:#8a8aa8;font-size:11px">${item.tags?.title || item.url}</span>
      `);
    });
  } catch (err) {
    setClipLoading(false);
    if (err.message !== "Cancelled by user") {
      showClipResult(`⚠ ${err.message}`, true);
    }
  }
}

async function handleClipScreen() {
  setClipLoading(true, "Drag to select region…");
  clipResultEl.style.display = "none";
  try {
    const resp = await sendClipMessage("START_REGION_SCREENSHOT");
    setClipLoading(true, "Saving screenshot…");
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      const clip = {
        id: `clip-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        type: "image",
        url: tab?.url || "",
        faviconUrl: `${new URL(tab?.url || "http://example.com").origin}/favicon.ico`,
        title: `Screenshot — ${tab?.title || "page"}`,
        description: "",
        timestamp: Date.now(),
        screenshotDataUrl: resp.dataUrl,
      };
      chrome.runtime.sendMessage({ type: "SAVE_CLIP", clip }, (saveResp) => {
        setClipLoading(false);
        if (chrome.runtime.lastError || !saveResp?.success) {
          showClipResult(`⚠ ${saveResp?.error || "Save failed"}`, true);
          return;
        }
        showClipResult(`
          <strong style="display:block;margin-bottom:4px">✓ Screenshot saved to Quantedits</strong>
          <img src="${resp.dataUrl}" style="max-width:100%;border-radius:4px;margin-top:4px" />
        `);
      });
    });
  } catch (err) {
    setClipLoading(false);
    if (err.message !== "Cancelled by user") {
      showClipResult(`⚠ ${err.message}`, true);
    }
  }
}

if (clipPageBtn) clipPageBtn.addEventListener("click", handleClipPage);
if (clipPickBtn) clipPickBtn.addEventListener("click", handleClipPick);
if (clipScreenBtn) clipScreenBtn.addEventListener("click", handleClipScreen);

// ── Collections tab — lightweight renderer ────────────────────────────────────

let collectionsData = { items: [], collections: [] };
let collectionsSearch = "";
let collectionsActiveCollection = null;

function renderCollectionsPanel() {
  const root = document.getElementById("collections-root");
  if (!root) return;

  root.innerHTML = `
    <div style="
      display:flex;gap:6px;padding:10px 12px;
      border-bottom:1px solid #1e1e2e;
      background:#13131a;
    ">
      <input
        id="col-search"
        type="text"
        placeholder="🔍 Search saves…"
        style="
          flex:1;background:#1a1a24;border:1px solid #2a2a3c;
          border-radius:8px;color:#e8e8f0;font-size:11px;
          outline:none;padding:6px 10px;
        "
      />
      <button id="col-export-json" style="
        background:#1a1a24;border:1px solid #2a2a3c;border-radius:8px;
        color:#8a8aa8;cursor:pointer;font-size:10px;padding:5px 8px;
      " title="Export JSON">⬇</button>
    </div>
    <div id="col-list" style="
      flex:1;overflow-y:auto;padding:8px 10px;
      max-height:390px;
    "></div>
    <div style="
      border-top:1px solid #1e1e2e;color:#4a4a6a;
      display:flex;font-size:10px;gap:8px;
      justify-content:space-between;padding:6px 12px;
    ">
      <span id="col-count">Loading…</span>
      <button id="col-refresh" style="
        background:transparent;border:none;color:#5a5a7a;
        cursor:pointer;font-size:10px;
      " title="Refresh">↺ Refresh</button>
    </div>
  `;

  // Set value via DOM property (not innerHTML) to prevent XSS
  const searchInput = document.getElementById("col-search");
  if (searchInput) {
    searchInput.value = collectionsSearch;
    searchInput.addEventListener("input", (e) => {
      collectionsSearch = e.target.value;
      renderCollectionsList();
    });
  }

  const exportBtn = document.getElementById("col-export-json");
  if (exportBtn) {
    exportBtn.addEventListener("click", exportSavesAsJson);
  }

  const refreshBtn = document.getElementById("col-refresh");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", loadCollectionsData);
  }

  loadCollectionsData();
}

function loadCollectionsData() {
  chrome.runtime.sendMessage({ type: "GET_SAVED_ITEMS" }, (resp) => {
    if (resp?.success) {
      collectionsData.items = resp.items || [];
    }
    renderCollectionsList();
    const countEl = document.getElementById("col-count");
    if (countEl) {
      const queuedCount = collectionsData.items.filter((i) => i.status === "queued").length;
      countEl.textContent = `${collectionsData.items.length} saved${queuedCount > 0 ? ` · ${queuedCount} queued` : ""}`;
    }
  });
}

function renderCollectionsList() {
  const listEl = document.getElementById("col-list");
  if (!listEl) return;

  let items = collectionsData.items;

  if (collectionsSearch.trim()) {
    const lower = collectionsSearch.toLowerCase();
    items = items.filter((item) => {
      const searchable = [
        item.tags?.title,
        item.tags?.summary,
        ...(item.tags?.tags || []),
        item.url,
        item.tags?.category,
      ].join(" ").toLowerCase();
      return searchable.includes(lower);
    });
  }

  // Clear existing content
  listEl.textContent = "";

  if (items.length === 0) {
    const emptyEl = document.createElement("div");
    emptyEl.style.cssText = "color:#5a5a7a;font-size:12px;padding:24px;text-align:center";
    const msgSpan = document.createElement("span");
    msgSpan.textContent = collectionsSearch ? "No results" : "Nothing saved yet";
    const hint = document.createElement("div");
    hint.style.fontSize = "11px";
    hint.style.marginTop = "6px";
    hint.style.color = "#4a4a6a";
    hint.textContent = "Press Alt+S to save the current page";
    emptyEl.appendChild(msgSpan);
    emptyEl.appendChild(hint);
    listEl.appendChild(emptyEl);
    return;
  }

  const statusColors = {
    queued: "#f59e0b", saving: "#6366f1", saved: "#10b981", failed: "#ef4444",
  };
  const appIcons = {
    quantsink: "📡", quanttube: "▶️", quantedits: "🎨",
    quantbrowse: "🌐", quantdocs: "📄", quantcode: "💻",
    quantshop: "🛒", quantrecipes: "🍳", quantmind: "💡",
  };

  function formatDate(ts) {
    const diffMs = Date.now() - ts;
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(diffMs / 3600000);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(diffMs / 86400000);
    if (days < 7) return `${days}d ago`;
    return new Date(ts).toLocaleDateString();
  }

  // Build item cards using DOM API to avoid XSS from user-controlled data
  const fragment = document.createDocumentFragment();

  items.slice(0, 50).forEach((item) => {
    const title = (item.tags?.title || item.url || "").slice(0, 60);
    const summary = (item.tags?.summary || "").slice(0, 80);
    const tags = (item.tags?.tags || []).slice(0, 3);
    const app = item.app || "quantbrowse";
    const status = item.status || "queued";
    const statusColor = statusColors[status] || "#6b7280";

    // Card container
    const card = document.createElement("div");
    card.style.cssText = "background:#13131a;border:1px solid #1e1e2e;border-radius:8px;cursor:pointer;margin-bottom:6px;padding:9px 10px;transition:border-color 0.15s;";
    card.addEventListener("mouseenter", () => { card.style.borderColor = "#2a2a3c"; });
    card.addEventListener("mouseleave", () => { card.style.borderColor = "#1e1e2e"; });
    card.addEventListener("click", () => {
      if (item.url) chrome.tabs.create({ url: item.url });
    });

    // Row 1: favicon + title + status
    const row1 = document.createElement("div");
    row1.style.cssText = "display:flex;align-items:flex-start;gap:6px;margin-bottom:4px";

    const favicon = document.createElement("img");
    favicon.width = 12;
    favicon.height = 12;
    favicon.style.cssText = "border-radius:2px;flex-shrink:0;margin-top:2px";
    favicon.src = item.clip?.faviconUrl || "";
    favicon.addEventListener("error", () => { favicon.style.display = "none"; });

    const titleSpan = document.createElement("span");
    titleSpan.style.cssText = "color:#e8e8f0;font-size:11px;font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    titleSpan.title = title;
    titleSpan.textContent = title || item.url;

    const statusBadge = document.createElement("span");
    statusBadge.style.cssText = `background:${statusColor}22;border:1px solid ${statusColor}44;border-radius:8px;color:${statusColor};font-size:9px;padding:2px 5px;flex-shrink:0;text-transform:uppercase;`;
    statusBadge.textContent = status;

    row1.appendChild(favicon);
    row1.appendChild(titleSpan);
    row1.appendChild(statusBadge);

    // Row 2: summary
    if (summary) {
      const summaryEl = document.createElement("p");
      summaryEl.style.cssText = "color:#7a7a9a;font-size:10px;line-height:1.4;margin-bottom:4px";
      summaryEl.textContent = summary + "…";
      card.appendChild(row1);
      card.appendChild(summaryEl);
    } else {
      card.appendChild(row1);
    }

    // Row 3: tags + meta + delete
    const row3 = document.createElement("div");
    row3.style.cssText = "display:flex;align-items:center;gap:4px;flex-wrap:wrap";

    tags.forEach((tag) => {
      const tagEl = document.createElement("span");
      tagEl.style.cssText = "background:#1a1a24;border:1px solid #2a2a3c;border-radius:10px;color:#7a7a9a;font-size:9px;padding:2px 6px;";
      tagEl.textContent = tag;
      row3.appendChild(tagEl);
    });

    const spacer = document.createElement("div");
    spacer.style.flex = "1";
    row3.appendChild(spacer);

    const appSpan = document.createElement("span");
    appSpan.style.cssText = "color:#4a4a6a;font-size:9px";
    appSpan.textContent = `${appIcons[app] || "🌐"} ${app}`;
    row3.appendChild(appSpan);

    const dot = document.createElement("span");
    dot.style.cssText = "color:#3a3a5a;font-size:9px";
    dot.textContent = "·";
    row3.appendChild(dot);

    const dateSpan = document.createElement("span");
    dateSpan.style.cssText = "color:#4a4a6a;font-size:9px";
    dateSpan.textContent = formatDate(item.savedAt);
    row3.appendChild(dateSpan);

    const delBtn = document.createElement("button");
    delBtn.style.cssText = "background:transparent;border:none;color:#5a5a7a;cursor:pointer;font-size:10px;padding:0 3px;";
    delBtn.title = "Delete";
    delBtn.textContent = "✕";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteItem(item.id);
    });
    row3.appendChild(delBtn);

    card.appendChild(row3);
    fragment.appendChild(card);
  });

  listEl.appendChild(fragment);
}

function escapeAttr(str) {
  return (str || "").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;");
}

function deleteItem(id) {
  chrome.runtime.sendMessage({ type: "DELETE_SAVED_ITEM", itemId: id }, () => {
    loadCollectionsData();
  });
}

function exportSavesAsJson() {
  chrome.runtime.sendMessage({ type: "GET_SAVED_ITEMS" }, (resp) => {
    if (!resp?.success) return;
    const json = JSON.stringify(resp.items, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `quant-saves-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });
}
