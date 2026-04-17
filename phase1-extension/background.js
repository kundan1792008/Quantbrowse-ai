// background.js - The Orchestrator Agent (Managed by CEO)

// Import the API Specialist's logic as an ES module
import { callPlannerAgentAPI } from './scripts/llm_api.js';

// Listen for messages from the popup or content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'EXECUTE_INTENT') {
    const intent = request.payload?.text;

    // Validate intent before any async work
    if (!intent || typeof intent !== 'string' || intent.trim().length === 0) {
      sendResponse({ status: 'error', message: 'A non-empty intent string is required.' });
      return false;
    }

    if (intent.length > 500) {
      sendResponse({ status: 'error', message: 'Intent exceeds the 500-character limit.' });
      return false;
    }

    handleIntentExecution(intent.trim(), sendResponse);
    return true; // Keep the message channel open for async response
  }
});

async function handleIntentExecution(intent, sendResponse) {
  try {
    // Step 1: Get the current active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
      throw new Error("No active tab found to execute on.");
    }

    // Step 2: Get the accessibility snapshot from the content script.
    // content.js is auto-injected via manifest content_scripts, but we guard
    // against pages loaded before the extension was installed.
    let pageSnapshot;
    try {
      const injectionResult = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => window.getA11ySnapshot ? window.getA11ySnapshot() : null
      });
      pageSnapshot = injectionResult[0]?.result ?? null;
    } catch {
      pageSnapshot = null;
    }

    if (!pageSnapshot) {
      // Content script not yet present — inject it now and retry
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['scripts/content.js']
      });
      const retryResult = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => window.getA11ySnapshot ? window.getA11ySnapshot() : null
      });
      pageSnapshot = retryResult[0]?.result ?? null;
    }

    if (!pageSnapshot) {
      sendResponse({ status: 'error', message: 'Could not capture page state. The page may be restricted.' });
      return;
    }

    console.log("Captured Page State:", pageSnapshot);

    // Step 3: Call the Planner Agent (LLM) using the API Specialist's module
    let agentCommand = await callPlannerAgentAPI(intent, pageSnapshot);
    console.log("Agent reasoning:", agentCommand.reasoning);
    
    // ==========================================
    // 🛡️ ANTI-HALLUCINATION GUARDRAIL (Deterministic Validation)
    // ==========================================
    if (agentCommand.action !== 'NONE') {
        // We do not trust the LLM. We verify that the ID exists on the page.
        const elementExists = pageSnapshot.elements.find(el => el.id === agentCommand.elementId);
        
        if (!elementExists) {
            console.warn(`[Guardrail Alert] AI hallucinated element ID: ${agentCommand.elementId}. Overriding to NONE.`);
            agentCommand = { 
                action: 'NONE', 
                reason: "Safety Guardrail Triggered: The AI specified an element that does not exist on this page." 
            };
        } else {
            console.log(`[Guardrail Passed] Element ${agentCommand.elementId} verified on page.`);
        }
    }
    
    console.log("Final Validated Agent Command:", agentCommand);

    // Step 4: Execute the action in the tab
    if (agentCommand.action === 'NONE') {
       sendResponse({ status: 'error', message: agentCommand.reason || "Agent couldn't determine the right action." });
       return;
    }

    const execResult = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (command) => window.executeAction(command),
      args: [agentCommand]
    });

    const actionResult = execResult[0]?.result;
    if (actionResult && !actionResult.success) {
      sendResponse({ status: 'error', message: actionResult.reason || 'Action failed in the page.' });
      return;
    }

    sendResponse({ status: 'success', message: `${agentCommand.action} executed. Reasoning: ${agentCommand.reasoning || ''}` });

  } catch (error) {
    console.error("Execution failed:", error);
    sendResponse({ status: 'error', message: error.message });
  }
}
