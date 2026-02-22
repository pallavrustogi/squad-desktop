// squadAPI.js — drop-in replacement for Electron's preload bridge.
// Provides window.squadAPI backed by fetch() + WebSocket (browser) or w.bind() (native WebView).

(function () {
  const NATIVE = typeof window.nativeGetAgents === 'function';
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

      dispatchMessage(msg);
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

  function dispatchMessage(msg) {
    var type = msg.type;
    var data = msg.data;
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
    getAgents: NATIVE
      ? function () { return window.nativeGetAgents().then(JSON.parse); }
      : function () { return fetchJSON('/api/agents'); },

    addAgent: NATIVE
      ? function (name, role, emoji) { return window.nativeAddAgent(name, role, emoji).then(JSON.parse); }
      : function (name, role, emoji) {
          return fetchJSON('/api/agents', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: name, role: role, emoji: emoji }),
          });
        },

    removeAgent: NATIVE
      ? function (agentId) { return window.nativeRemoveAgent(agentId).then(JSON.parse); }
      : function (agentId) {
          return fetchJSON('/api/agents/' + encodeURIComponent(agentId), {
            method: 'DELETE',
          });
        },

    sendCommand: NATIVE
      ? function (agentId, command) { return window.nativeSendCommand(agentId, command).then(JSON.parse); }
      : function (agentId, command) {
          return fetchJSON('/api/agents/' + encodeURIComponent(agentId) + '/command', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command: command }),
          });
        },

    getQueue: NATIVE
      ? function (agentId) { return window.nativeGetQueue(agentId).then(JSON.parse); }
      : function (agentId) {
          return fetchJSON('/api/agents/' + encodeURIComponent(agentId) + '/queue');
        },

    getConnectionStatus: NATIVE
      ? function () { return window.nativeGetConnectionStatus().then(function (r) { return JSON.parse(r).status; }); }
      : function () { return fetchJSON('/api/connection-status').then(function (r) { return r.status; }); },

    reconnectCopilot: NATIVE
      ? function () { return window.nativeReconnectCopilot().then(JSON.parse); }
      : function () { return fetchJSON('/api/reconnect', { method: 'POST' }); },

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

  // Boot: native polling or WebSocket
  if (NATIVE) {
    setInterval(async function () {
      try {
        var raw = await window.nativePoll();
        var msgs = JSON.parse(raw);
        for (var i = 0; i < msgs.length; i++) {
          dispatchMessage(msgs[i]);
        }
      } catch (_) {}
    }, 500);
  } else {
    connectWebSocket();
  }
})();
