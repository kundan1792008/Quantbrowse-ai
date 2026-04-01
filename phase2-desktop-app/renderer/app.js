const chat = document.getElementById('chat');
const userInput = document.getElementById('userInput');
const sendBtn = document.getElementById('sendBtn');
const statusText = document.querySelector('.status');
const statusDot = document.querySelector('.status-dot');

function appendMessage(role, text) {
  const el = document.createElement('div');
  el.className = `message ${role}`;
  el.innerHTML = text.replace(/\n/g, '<br>');
  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
  return el; // Return so we can update it if needed
}

function setAgentStatus(status, isThinking = false) {
    if (isThinking) {
        statusText.innerHTML = `<div class="status-dot" style="background-color: #f2cc60; box-shadow: 0 0 8px #f2cc60;"></div> <span class="thinking">${status}</span>`;
    } else if (status === 'Idle') {
        statusText.innerHTML = `<div class="status-dot" style="background-color: #3fb950; box-shadow: 0 0 8px #3fb950;"></div> Agent Idle`;
    } else if (status.includes('Error')) {
        statusText.innerHTML = `<div class="status-dot" style="background-color: #f85149; box-shadow: 0 0 8px #f85149;"></div> ${status}`;
    } else {
         statusText.innerHTML = `<div class="status-dot" style="background-color: #1f6feb; box-shadow: 0 0 8px #1f6feb;"></div> ${status}`;
    }
}

// Listen for real-time logs from the background worker
window.electronAPI.onAgentLog((logMessage) => {
    appendMessage('system', `> ${logMessage}`);
});

sendBtn.addEventListener('click', async () => {
  const text = userInput.value.trim();
  if (!text) return;

  // Add User Message
  appendMessage('user', text);
  userInput.value = '';
  userInput.disabled = true;
  sendBtn.disabled = true;

  setAgentStatus('Agent Executing...', true);

  try {
    // Send to Electron Kernel -> Orchestrator
    const response = await window.electronAPI.startTask(text);
    
    if (response.success) {
      appendMessage('agent', `✅ <strong>Task Completed Successfully</strong><br><br>${response.result}`);
      setAgentStatus('Idle');
    } else {
      appendMessage('agent', `❌ <strong>Task Failed</strong><br><br>${response.error}`);
      setAgentStatus('Error');
    }
  } catch (err) {
    appendMessage('agent', `⚠️ <strong>System Error</strong><br><br>Connection to Kernel failed.`);
    setAgentStatus('Error');
  } finally {
    userInput.disabled = false;
    sendBtn.disabled = false;
    userInput.focus();
  }
});

// Enter key support
userInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendBtn.click();
});
