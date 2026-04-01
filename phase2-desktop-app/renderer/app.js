const chat = document.getElementById('chat');
const userInput = document.getElementById('userInput');
const sendBtn = document.getElementById('sendBtn');
const statusText = document.querySelector('.status');
const statusDot = document.querySelector('.status-dot');
const identityModal = document.getElementById('identityModal');
const identityFailReason = document.getElementById('identityFailReason');
const reverifyBtn = document.getElementById('reverifyBtn');

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

// ==========================================
// Tab status helpers
// ==========================================

function updateTabIndicators(tabs) {
    if (!tabs) return;
    tabs.forEach(function (tab) {
        var el = document.getElementById('tab-' + tab.id);
        if (el) {
            if (tab.isolated) {
                el.classList.add('isolated');
            } else {
                el.classList.remove('isolated');
            }
        }
    });
}

// ==========================================
// Quantmail Biometric Identity handling
// ==========================================

window.electronAPI.onIdentityStatus(function (status) {
    if (!status.verified) {
        // Show forced re-verification modal
        identityFailReason.textContent = status.reason || 'Unknown failure';
        identityModal.classList.add('visible');

        // Update tab indicators to isolated state
        updateTabIndicators(status.tabs);

        setAgentStatus('IDENTITY BLOCKED');
        appendMessage('system', '🔒 TLS handshake failed – all tabs isolated, network paused.');
    } else {
        // Hide modal if it was visible
        identityModal.classList.remove('visible');

        // Update tab indicators to active state
        updateTabIndicators(status.tabs);

        setAgentStatus('Idle');
    }
});

reverifyBtn.addEventListener('click', async function () {
    reverifyBtn.disabled = true;
    reverifyBtn.textContent = 'Verifying…';

    try {
        await window.electronAPI.reverifyIdentity();
        identityModal.classList.remove('visible');
        appendMessage('system', '🔓 Identity re-verified – tabs resumed, network restored.');
    } catch (err) {
        identityFailReason.textContent = 'Re-verification failed. Please try again.';
    } finally {
        reverifyBtn.disabled = false;
        reverifyBtn.textContent = 'Re-Verify Identity';
    }
});

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
