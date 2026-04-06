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

// Restore last prompt from storage (nice UX touch)
chrome.storage.local.get("lastPrompt", ({ lastPrompt }) => {
  if (lastPrompt) promptInput.value = lastPrompt;
});

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
