const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const orchestrator = require('./src/agent/orchestrator');
const biometricService = require('./src/identity/quantmail_biometric');
const tabManager = require('./src/shell/tab_manager');
const networkGuard = require('./src/shell/network_guard');

let mainWindow;

/** Helper: send a message to the renderer if the window is available */
function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

/** Helper: broadcast a log line to the renderer chat stream */
function streamLog(msg) {
  sendToRenderer('agent:log', msg);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 600,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // Security best practices: disable nodeIntegration and enable contextIsolation
      nodeIntegration: false,
      contextIsolation: true
    },
    backgroundColor: '#0d1117',
    title: 'QuantBrowse AI - Command Center',
    autoHideMenuBar: true
  });

  mainWindow.loadFile('renderer/index.html');
}

// ==========================================
// Quantmail Biometric Identity Integration
// ==========================================

function initBiometricIdentity() {
  // On successful liveness check – notify renderer
  biometricService.on('identity:verified', () => {
    sendToRenderer('identity:status', { verified: true });
  });

  // On failed liveness check – isolate tabs, pause network, force modal
  biometricService.on('identity:failed', (reason) => {
    console.error(`[Kernel] Identity verification FAILED: ${reason}`);

    tabManager.isolateAll(streamLog);
    networkGuard.pause(streamLog);

    sendToRenderer('identity:status', {
      verified: false,
      reason,
      tabs: tabManager.getTabStates(),
    });
  });

  // On re-verification – resume tabs and network
  biometricService.on('identity:reverified', () => {
    tabManager.resumeAll(streamLog);
    networkGuard.resume(streamLog);

    sendToRenderer('identity:status', {
      verified: true,
      tabs: tabManager.getTabStates(),
    });
  });

  // Start the 15-second liveness validation loop
  biometricService.start(streamLog);
}

// ==========================================
// App Lifecycle
// ==========================================

app.whenReady().then(() => {
  createWindow();
  initBiometricIdentity();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  biometricService.stop();
  if (process.platform !== 'darwin') app.quit();
});

// ==========================================
// IPC Handlers (Renderer -> Main -> Orchestrator)
// ==========================================

ipcMain.handle('orchestrator:start-task', async (event, intent) => {
  // Block task execution while identity is not verified
  if (!biometricService.isVerified) {
    return { success: false, error: 'Identity not verified. Please complete biometric re-verification.' };
  }
  if (networkGuard.isPaused) {
    return { success: false, error: 'Network is paused pending identity re-verification.' };
  }

  try {
    console.log(`[Kernel] Received task intent: "${intent}"`);
    
    // Pass the task to the Autonomous Orchestrator
    const result = await orchestrator.executeTask(intent, (logMessage) => {
        // Callback to stream logs back to the Renderer UI in real-time
        sendToRenderer('agent:log', logMessage);
    });

    return { success: true, result };
  } catch (err) {
    console.error(`[Kernel] Error executing task:`, err);
    return { success: false, error: err.message };
  }
});

// Identity re-verification request from the renderer
ipcMain.handle('identity:reverify', async () => {
  biometricService.reverify(streamLog);
  return { success: true };
});

// Request current identity & tab state
ipcMain.handle('identity:status', async () => {
  return {
    verified: biometricService.isVerified,
    tabs: tabManager.getTabStates(),
    networkPaused: networkGuard.isPaused,
  };
});
