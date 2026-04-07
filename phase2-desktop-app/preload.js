const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  startTask: (intent) => ipcRenderer.invoke('orchestrator:start-task', intent),
  onAgentLog: (callback) => ipcRenderer.on('agent:log', (_event, value) => callback(value))
});
