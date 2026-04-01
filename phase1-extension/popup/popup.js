document.addEventListener('DOMContentLoaded', () => {
  const intentInput = document.getElementById('intentInput');
  const executeBtn = document.getElementById('executeBtn');
  const statusDiv = document.getElementById('status');

  // Focus input automatically
  intentInput.focus();

  executeBtn.addEventListener('click', () => {
    const intent = intentInput.value.trim();
    
    if (!intent) {
      statusDiv.textContent = 'Please provide an intent first.';
      statusDiv.style.color = '#f85149'; // Error red
      return;
    }

    // Set UI to loading state
    executeBtn.disabled = true;
    intentInput.disabled = true;
    statusDiv.textContent = 'Agent is thinking and processing execution...';
    statusDiv.className = 'agent-thinking';

    // Send intent to Background Orchestrator
    chrome.runtime.sendMessage(
      { action: 'EXECUTE_INTENT', payload: { text: intent } },
      (response) => {
        // Reset UI after execution attempt
        executeBtn.disabled = false;
        intentInput.disabled = false;
        statusDiv.className = '';
        
        if (chrome.runtime.lastError) {
          statusDiv.textContent = 'Error: Could not connect to the Agent orchestrator.';
          statusDiv.style.color = '#f85149';
          console.error(chrome.runtime.lastError);
        } else if (response && response.status === 'success') {
          statusDiv.textContent = `Action Executed: ${response.message || 'Complete'}`;
          statusDiv.style.color = '#3fb950'; // Success green
          intentInput.value = ''; // clear only on success
        } else {
          statusDiv.textContent = `Failed: ${response?.message || 'Unknown error'}`;
          statusDiv.style.color = '#f85149';
        }
      }
    );
  });

  // Allow "Enter" physical key to submit unless holding Shift
  intentInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      executeBtn.click();
    }
  });
});
