const chat = document.getElementById('chat');
const userInput = document.getElementById('userInput');
const sendBtn = document.getElementById('sendBtn');
const statusText = document.querySelector('.status');
const statusDot = document.querySelector('.status-dot');

function appendMessage(role, text) {
  const el = document.createElement('div');
  el.className = `message ${role}`;
  el.textContent = text;
  el.style.whiteSpace = 'pre-wrap';
  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
  return el; // Return so we can update it if needed
}

function createStatusDot(backgroundColor) {
  const dot = document.createElement('div');
  dot.className = 'status-dot';
  dot.style.backgroundColor = backgroundColor;
  dot.style.boxShadow = `0 0 8px ${backgroundColor}`;
  return dot;
}

function setAgentStatus(status, isThinking = false) {
    statusText.replaceChildren();

    if (isThinking) {
        statusText.appendChild(createStatusDot('#f2cc60'));
        const thinking = document.createElement('span');
        thinking.className = 'thinking';
        thinking.textContent = status;
        statusText.appendChild(thinking);
    } else if (status === 'Idle') {
        statusText.appendChild(createStatusDot('#3fb950'));
        statusText.append(' Agent Idle');
    } else if (status.includes('Error')) {
        statusText.appendChild(createStatusDot('#f85149'));
        statusText.append(` ${status}`);
    } else {
        statusText.appendChild(createStatusDot('#1f6feb'));
        statusText.append(` ${status}`);
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
