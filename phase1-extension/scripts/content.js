// scripts/content.js - The Extension's Eyes and Hands

// Expose these functions to the window object so background.js's executeScript can call them
window.getA11ySnapshot = function() {
    console.log("[QuantBrowse Agent] Scraping page state...");
    
    const elements = [];
    let idCounter = 0;
  
    // We only care about interactive semantic elements to keep the LLM context small
    const interactables = document.querySelectorAll('button, a, input, select, textarea, [role="button"]');
    
    interactables.forEach((el) => {
      // Assign a unique temporary agent-id so we know exactly what to click later
      const agentId = `agent-node-${idCounter++}`;
      el.setAttribute('data-agent-id', agentId);
      
      const rect = el.getBoundingClientRect();
      
      // Filter out invisible elements
      if (rect.width === 0 || rect.height === 0 || el.style.display === 'none' || el.style.visibility === 'hidden') {
          return;
      }
  
      let text = el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '';
      text = text.trim().substring(0, 50); // limit text length
  
      if (text || el.tagName === 'INPUT') { // Keep inputs even if empty
          elements.push({
              id: agentId,
              role: el.tagName.toLowerCase(),
              type: el.getAttribute('type') || null,
              text: text,
              // We don't send coords to the LLM (they are useless for reasoning), but we keep them for context
              isClickable: !el.disabled
          });
      }
    });
  
    return {
      url: window.location.href,
      title: document.title,
      elementCount: elements.length,
      elements: elements // This is the lightweight Mock A11y Tree we send to the LLM
    };
  };
  
  window.executeAction = function(agentCommand) {
      console.log("[QuantBrowse Agent] Executing command:", agentCommand);
      
      if (!agentCommand || !agentCommand.action) {
          console.error("Invalid command format.");
          return { success: false, reason: "Invalid command" };
      }

      // scroll and navigate don't require an elementId
      if (agentCommand.action === 'scroll') {
          const amount = typeof agentCommand.value === 'number' ? agentCommand.value : 300;
          window.scrollBy({ top: amount, behavior: 'smooth' });
          return { success: true };
      }

      if (!agentCommand.elementId) {
          console.error("Command missing elementId.");
          return { success: false, reason: "Missing elementId" };
      }

      // Find the exact element we tagged earlier
      const targetElement = document.querySelector(`[data-agent-id="${agentCommand.elementId}"]`);
      
      if (!targetElement) {
          console.error("Stale DOM: Element not found on page anymore.");
          return { success: false, reason: "Element not found" };
      }

      // Inject human-like events
      try {
          // Highlight it briefly for UX feedback
          const originalOutline = targetElement.style.outline;
          targetElement.style.outline = "3px solid #f2cc60"; // Agent yellow
          targetElement.style.transition = "outline 0.3s";
          
          setTimeout(() => { targetElement.style.outline = originalOutline; }, 1000);

          if (agentCommand.action === 'click') {
              // Simulate real mouse click sequence to bypass simple bot detection
              targetElement.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
              targetElement.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
              targetElement.click();
              targetElement.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
              return { success: true };
          }

          if (agentCommand.action === 'type' && agentCommand.value !== null && agentCommand.value !== undefined) {
              // Focus and type
              targetElement.focus();
              targetElement.value = agentCommand.value;
              // Dispatch input events so React/Vue frameworks register the change
              targetElement.dispatchEvent(new Event('input', { bubbles: true }));
              targetElement.dispatchEvent(new Event('change', { bubbles: true }));
              return { success: true };
          }

          if (agentCommand.action === 'hover') {
              targetElement.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
              targetElement.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
              return { success: true };
          }

          if (agentCommand.action === 'submit') {
              // Try to find the closest form and submit it
              const form = targetElement.closest('form');
              if (form) {
                  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
                  return { success: true };
              }
              // Fallback: click if no form found
              targetElement.click();
              return { success: true };
          }

      } catch (err) {
          console.error("Agent failed to execute action on DOM node:", err);
          return { success: false, reason: err.message };
      }
      
      return { success: false, reason: `Unknown action type: ${agentCommand.action}` };
  };
