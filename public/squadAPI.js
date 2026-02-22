// squadAPI.js — drop-in replacement for Electron's preload bridge.
// Provides window.squadAPI backed by fetch() + WebSocket.

(function () {
  const API_BASE = '';
  const listeners = {
    'agent-status-update': [],
    'terminal-log': [],
    'queue-update': [],
  };

  // --- WebSocket with auto-reconnect (exponential backoff) ---

  let ws = null;
  let reconnectDelay = 500;
  const MAX_RECONNECT_DELAY = 30000;

  function getWsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}`;
  }

  function connectWebSocket() {
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
      return;
    }

    try {
      ws = new WebSocket(getWsUrl());
    } catch (err) {
      scheduleReconnect();
      return;
    }

    ws.onopen = function () {
      reconnectDelay = 500;
    };

    ws.onmessage = function (event) {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (_) {
        return;
      }

      const { type, data } = msg;

      if (type === 'agent-status-update' && data) {
        listeners['agent-status-update'].forEach(function (cb) {
          cb(data.agentId, data.status, data.output);
        });
      } else if (type === 'terminal-log' && data) {
        listeners['terminal-log'].forEach(function (cb) {
          cb(data);
        });
      } else if (type === 'queue-update' && data) {
        listeners['queue-update'].forEach(function (cb) {
          cb(data.agentId, data.queueItem);
        });
      }
    };

    ws.onclose = function () {
      ws = null;
      scheduleReconnect();
    };

    ws.onerror = function () {
      if (ws) {
        ws.close();
      }
    };
  }

  function scheduleReconnect() {
    setTimeout(function () {
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
      connectWebSocket();
    }, reconnectDelay);
  }

  // --- HTTP helpers ---

  async function fetchJSON(url, options) {
    const res = await fetch(API_BASE + url, options);
    if (!res.ok) {
      const text = await res.text().catch(function () { return res.statusText; });
      throw new Error(text || `HTTP ${res.status}`);
    }
    return res.json();
  }

  // --- Public API (matches preload.cjs signatures exactly) ---

  window.squadAPI = {
    getAgents: function () {
      return fetchJSON('/api/agents');
    },

    addAgent: function (name, role, emoji) {
      return fetchJSON('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, role: role, emoji: emoji }),
      });
    },

    removeAgent: function (agentId) {
      return fetchJSON('/api/agents/' + encodeURIComponent(agentId), {
        method: 'DELETE',
      });
    },

    sendCommand: function (agentId, command) {
      return fetchJSON('/api/agents/' + encodeURIComponent(agentId) + '/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: command }),
      });
    },

    getQueue: function (agentId) {
      return fetchJSON('/api/agents/' + encodeURIComponent(agentId) + '/queue');
    },

    getConnectionStatus: function () {
      return fetchJSON('/api/connection-status').then(function (r) { return r.status; });
    },

    reconnectCopilot: function () {
      return fetchJSON('/api/reconnect', { method: 'POST' });
    },

    onAgentStatusUpdate: function (callback) {
      listeners['agent-status-update'].push(callback);
    },

    onTerminalLog: function (callback) {
      listeners['terminal-log'].push(callback);
    },

    onQueueUpdate: function (callback) {
      listeners['queue-update'].push(callback);
    },
  };

  // Boot WebSocket connection
  connectWebSocket();
})();
