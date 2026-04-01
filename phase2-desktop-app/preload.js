const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  startTask: (intent) => ipcRenderer.invoke('orchestrator:start-task', intent),
  onAgentLog: (callback) => ipcRenderer.on('agent:log', (_event, value) => callback(value)),

  // Quantmail Biometric Identity APIs
  onIdentityStatus: (callback) => ipcRenderer.on('identity:status', (_event, value) => callback(value)),
  reverifyIdentity: () => ipcRenderer.invoke('identity:reverify'),
  getIdentityStatus: () => ipcRenderer.invoke('identity:status'),
});
