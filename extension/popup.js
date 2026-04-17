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

// ── Swarm stats ──────────────────────────────────────────────────────────────

/**
 * Fetches swarm stats from the background and renders pill badges.
 * Called once on popup open; refreshed after each AI command completes.
 */
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
      ${running > 0 ? `<span class="stat-pill"><span class="dot dot-running"></span>${running} running</span>` : ""}
      ${pending > 0 ? `<span class="stat-pill"><span class="dot dot-pending"></span>${pending} pending</span>` : ""}
      ${complete > 0 ? `<span class="stat-pill"><span class="dot dot-complete"></span>${complete} done</span>` : ""}
      ${failed > 0 ? `<span class="stat-pill"><span class="dot dot-failed"></span>${failed} failed</span>` : ""}
    `;
  });
}

// Refresh immediately when popup opens
refreshSwarmStats();

// ── Restore last prompt ──────────────────────────────────────────────────────

// Restore last prompt from storage (nice UX touch)
chrome.storage.local.get("lastPrompt", ({ lastPrompt }) => {
  if (lastPrompt) promptInput.value = lastPrompt;
});

// ── Input handling ───────────────────────────────────────────────────────────

// Allow Ctrl+Enter / Cmd+Enter to submit
promptInput.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    handleRun();
  }
});

runBtn.addEventListener("click", handleRun);

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

  // Persist the prompt for convenience
  chrome.storage.local.set({ lastPrompt: prompt });

  setLoading(true);

  chrome.runtime.sendMessage(
    { type: "RUN_AI_COMMAND", prompt },
    (response) => {
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
    }
  );
}
