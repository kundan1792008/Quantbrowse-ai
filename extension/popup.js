/**
 * popup.js — Quantbrowse AI Popup Script
 *
 * Handles AI commands and ambient dashboard controls.
 */

const promptInput = document.getElementById("promptInput");
const runBtn = document.getElementById("runBtn");
const statusEl = document.getElementById("status");
const resultEl = document.getElementById("result");
const productivityScoreEl = document.getElementById("productivityScore");
const focusTotalEl = document.getElementById("focusTotal");
const topSitesEl = document.getElementById("topSites");
const digestPreviewEl = document.getElementById("digestPreview");
const openDashboardBtn = document.getElementById("openDashboardBtn");
const groupTabsBtn = document.getElementById("groupTabsBtn");
const digestBtn = document.getElementById("digestBtn");
const surpriseBtn = document.getElementById("surpriseBtn");

chrome.storage.local.get("lastPrompt", ({ lastPrompt }) => {
  if (lastPrompt) promptInput.value = lastPrompt;
});

promptInput.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    handleRun();
  }
});

runBtn.addEventListener("click", handleRun);
openDashboardBtn.addEventListener("click", () => sendToActiveTab({ type: "SHOW_DASHBOARD" }));
groupTabsBtn.addEventListener("click", () => chrome.runtime.sendMessage({ type: "TRIGGER_GROUP_TABS" }));
digestBtn.addEventListener("click", () => chrome.runtime.sendMessage({ type: "TRIGGER_DIGEST" }));
surpriseBtn.addEventListener("click", () => chrome.runtime.sendMessage({ type: "SURPRISE_BOOKMARK" }));

refreshDashboard();
const refreshInterval = setInterval(refreshDashboard, 60000);
window.addEventListener("unload", () => clearInterval(refreshInterval));

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

async function handleRun() {
  const prompt = promptInput.value.trim();
  if (!prompt) {
    showResult("⚠ Please enter a command before running.", true);
    return;
  }

  chrome.storage.local.set({ lastPrompt: prompt });
  setLoading(true);

  chrome.runtime.sendMessage({ type: "RUN_AI_COMMAND", prompt }, (response) => {
    setLoading(false);

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

  productivityScoreEl.textContent = `${dashboard.productivityScore ?? 0}`;
  focusTotalEl.textContent = formatDuration(dashboard.todayTotal ?? 0);

  const topSites = dashboard.todayDomains ?? [];
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

  if (dashboard.digestPreview?.headline) {
    digestPreviewEl.textContent = dashboard.digestPreview.headline;
  } else {
    digestPreviewEl.textContent = "";
  }
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
