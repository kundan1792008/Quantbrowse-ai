/**
 * popup.js — Quantbrowse AI Popup Script
 *
 * Handles user input, sends the AI command to background.js,
 * and renders the AI's response in the popup.
 */

const promptInput = document.getElementById("promptInput");
const runBtn = document.getElementById("runBtn");
const statusEl = document.getElementById("status");
const resultEl = document.getElementById("result");
const swarmStatsEl = document.getElementById("swarm-stats");
const savePageBtn = document.getElementById("savePageBtn");
const saveSelectionBtn = document.getElementById("saveSelectionBtn");
const openCollectionsBtn = document.getElementById("openCollectionsBtn");
const queueFlushBtn = document.getElementById("queueFlushBtn");
const queueCountEl = document.getElementById("queueCount");
const queueLastSyncEl = document.getElementById("queueLastSync");
const queueFailuresEl = document.getElementById("queueFailures");

// ── Swarm stats ──────────────────────────────────────────────────────────────

function refreshSwarmStats() {
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
      ${
        running > 0
          ? `<span class="stat-pill"><span class="dot dot-running"></span>${running} running</span>`
          : ""
      }
      ${
        pending > 0
          ? `<span class="stat-pill"><span class="dot dot-pending"></span>${pending} pending</span>`
          : ""
      }
      ${
        complete > 0
          ? `<span class="stat-pill"><span class="dot dot-complete"></span>${complete} done</span>`
          : ""
      }
      ${
        failed > 0
          ? `<span class="stat-pill"><span class="dot dot-failed"></span>${failed} failed</span>`
          : ""
      }
    `;
  });
}

// ── Queue stats ──────────────────────────────────────────────────────────────

function refreshQueueStats() {
  chrome.runtime.sendMessage({ type: "QUEUE_STATS" }, (response) => {
    if (chrome.runtime.lastError || !response?.success) {
      queueCountEl.textContent = "0";
      queueLastSyncEl.textContent = "Unavailable";
      queueFailuresEl.textContent = "0";
      return;
    }
    const { queue, stats } = response;
    queueCountEl.textContent = String(queue?.length || 0);
    queueLastSyncEl.textContent = stats?.lastSyncedAt
      ? new Date(stats.lastSyncedAt).toLocaleString()
      : "Never";
    queueFailuresEl.textContent = String(stats?.clipsFailed || 0);
  });
}

refreshSwarmStats();
refreshQueueStats();

chrome.storage.local.get("lastPrompt", ({ lastPrompt }) => {
  if (lastPrompt) promptInput.value = lastPrompt;
});

promptInput.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    handleRun();
  }
});

runBtn.addEventListener("click", handleRun);

savePageBtn.addEventListener("click", () => handleQuickSave("page"));
saveSelectionBtn.addEventListener("click", () => handleQuickSave("selection"));
openCollectionsBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("collections.html") });
});
queueFlushBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "QUEUE_FLUSH" }, () => {
    refreshQueueStats();
  });
});

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

function handleQuickSave(captureMode) {
  chrome.runtime.sendMessage(
    { type: "CLIPPER_SAVE", captureMode },
    (response) => {
      if (chrome.runtime.lastError) {
        showResult(
          `Unable to save clip: ${chrome.runtime.lastError.message}`,
          true
        );
        return;
      }
      if (!response?.success) {
        showResult(`⚠ ${response?.error || "Clip save failed."}`, true);
        return;
      }
      showResult(`Saved: ${response.clip?.title || "Clip"}`);
      refreshQueueStats();
    }
  );
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "CLIP_SAVED") {
    refreshQueueStats();
    refreshSwarmStats();
  }
});
