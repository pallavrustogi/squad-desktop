const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('squadAPI', {
  getAgents: () => ipcRenderer.invoke('get-agents'),
  
  addAgent: (name, role, emoji) => ipcRenderer.invoke('add-agent', name, role, emoji),
  
  removeAgent: (agentId) => ipcRenderer.invoke('remove-agent', agentId),
  
  sendCommand: (agentId, command) => ipcRenderer.invoke('send-command', agentId, command),
  
  getQueue: (agentId) => ipcRenderer.invoke('get-queue', agentId),

  getConnectionStatus: () => ipcRenderer.invoke('get-connection-status'),

  reconnectCopilot: () => ipcRenderer.invoke('reconnect-copilot'),
  
  onAgentStatusUpdate: (callback) => {
    ipcRenderer.on('agent-status-update', (event, agentId, status, output) => {
      callback(agentId, status, output);
    });
  },
  
  onTerminalLog: (callback) => {
    ipcRenderer.on('terminal-log', (event, entry) => {
      callback(entry);
    });
  },
  
  onQueueUpdate: (callback) => {
    ipcRenderer.on('queue-update', (event, agentId, queueItem) => {
      callback(agentId, queueItem);
    });
  }
});
