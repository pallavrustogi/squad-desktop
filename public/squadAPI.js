// squadAPI.js — drop-in replacement for Electron's preload bridge.
// Provides window.squadAPI backed by fetch() + WebSocket (browser) or w.bind() (native WebView).

(function () {
  const NATIVE = window.__NATIVE_MODE__ === true;
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

  // In NATIVE mode, w.show() blocks the Node event loop so w.bind() Promises
  // never resolve.  Use the server-injected __SQUAD_STATE__ for reads and
  // keep a local mirror that write operations update optimistically.
  var _state = window.__SQUAD_STATE__ || { agents: [], connectionState: 'disconnected' };

  window.squadAPI = {
    getEmojis: NATIVE
      ? function () { return Promise.resolve(_state.emojis || []); }
      : function () { return fetchJSON('/api/emojis'); },

    getAgents: NATIVE
      ? function () { return Promise.resolve(_state.agents); }
      : function () { return fetchJSON('/api/agents'); },

    addAgent: NATIVE
      ? function (name, role, emoji) {
          var a = { id: Date.now().toString(36) + Math.random().toString(36).slice(2,8),
                    name: name, role: role, emoji: emoji || '🤖',
                    status: 'IDLE', output: [], queue: [] };
          _state.agents.push(a);
          return Promise.resolve(_state.agents);
        }
      : function (name, role, emoji) {
          return fetchJSON('/api/agents', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: name, role: role, emoji: emoji }),
          });
        },

    removeAgent: NATIVE
      ? function (agentId) {
          _state.agents = _state.agents.filter(function (a) { return a.id !== agentId; });
          return Promise.resolve(_state.agents);
        }
      : function (agentId) {
          return fetchJSON('/api/agents/' + encodeURIComponent(agentId), {
            method: 'DELETE',
          });
        },

    sendCommand: NATIVE
      ? function (agentId, command) {
          var agent = _state.agents.find(function (a) { return a.id === agentId; });
          if (!agent) return Promise.resolve({ error: 'Agent not found' });
          var item = { id: Date.now().toString(36), command: command,
                       status: 'PENDING', timestamp: new Date().toISOString(), result: null };
          agent.queue.push(item);
          return Promise.resolve(item);
        }
      : function (agentId, command) {
          return fetchJSON('/api/agents/' + encodeURIComponent(agentId) + '/command', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command: command }),
          });
        },

    getQueue: NATIVE
      ? function (agentId) {
          var agent = _state.agents.find(function (a) { return a.id === agentId; });
          return Promise.resolve(agent ? agent.queue : []);
        }
      : function (agentId) {
          return fetchJSON('/api/agents/' + encodeURIComponent(agentId) + '/queue');
        },

    getConnectionStatus: NATIVE
      ? function () { return Promise.resolve(_state.connectionState); }
      : function () { return fetchJSON('/api/connection-status').then(function (r) { return r.status; }); },

    reconnectCopilot: NATIVE
      ? function () { return Promise.resolve({ status: _state.connectionState }); }
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

  // Boot: native mode uses injected state (no polling needed); browser uses WebSocket
  if (!NATIVE) {
    connectWebSocket();
  }
})();
