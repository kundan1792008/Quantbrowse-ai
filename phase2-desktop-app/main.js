const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const orchestrator = require('./src/agent/orchestrator');

let mainWindow;

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

app.whenReady().then(() => {
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

// ==========================================
// IPC Handlers (Renderer -> Main -> Orchestrator)
// ==========================================

ipcMain.handle('orchestrator:start-task', async (event, intent) => {
  try {
    console.log(`[Kernel] Received task intent: "${intent}"`);
    
    // Pass the task to the Autonomous Orchestrator
    const result = await orchestrator.executeTask(intent, (logMessage) => {
        // Callback to stream logs back to the Renderer UI in real-time
        if (mainWindow) {
            mainWindow.webContents.send('agent:log', logMessage);
        }
    });

    return { success: true, result };
  } catch (err) {
    console.error(`[Kernel] Error executing task:`, err);
    return { success: false, error: err.message };
  }
});
