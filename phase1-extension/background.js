// background.js - The Orchestrator Agent (Managed by CEO)

// Import the API Specialist's logic
importScripts('scripts/llm_api.js');

// Listen for messages from the popup or content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'EXECUTE_INTENT') {
    handleIntentExecution(request.payload.text, sendResponse);
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

    // Step 2: Inject the content script to scrape the DOM (Mock A11y Tree)
    // We execute a function that lives in content.js to get the page snapshot
    let pageSnapshot;
    const injectionResult = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.getA11ySnapshot ? window.getA11ySnapshot() : { error: "Content script not ready" }
    });

    pageSnapshot = injectionResult[0].result;

    if (pageSnapshot && pageSnapshot.error) {
       // If content.js wasn't injected yet, inject the whole file first
       await chrome.scripting.executeScript({
         target: { tabId: tab.id },
         files: ['scripts/content.js']
       });
       
       // Try getting the snapshot again
       const retryResult = await chrome.scripting.executeScript({
         target: { tabId: tab.id },
         func: () => window.getA11ySnapshot()
       });
       pageSnapshot = retryResult[0].result;
    }

    console.log("Captured Page State:", pageSnapshot);

    // Step 3: Call the Planner Agent (LLM) using the API Specialist's module
    let agentCommand = await callPlannerAgentAPI(intent, pageSnapshot);
    console.log("Agent reasoning:", agentCommand.reasoning);
    
    // ==========================================
    // 🛡️ ANTI-HALLUCINATION GUARDRAIL (Deterministic Validation)
    // ==========================================
    if (agentCommand.action !== 'NONE') {
        // We do not trust the LLM. We verify mathematically that the ID exists on the page.
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
       sendResponse({ status: 'error', message: agentCommand.reason || "Agent couldn't figure out what to do." });
       return;
    }

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (command) => window.executeAction(command),
      args: [agentCommand]
    });

    sendResponse({ status: 'success', message: `${agentCommand.action} executed. Reasoning: ${agentCommand.reasoning || ''}` });

  } catch (error) {
    console.error("Execution failed:", error);
    sendResponse({ status: 'error', message: error.message });
  }
}
