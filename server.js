import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { spawn, execSync } from 'child_process';
import { CopilotClient } from '@github/copilot-sdk';
import { Webview } from 'webview-nodejs';

// Compute script directory: works in ESM (dev) and CJS (esbuild bundle)
const _scriptDir = (() => {
  try { return path.dirname(fileURLToPath(import.meta.url)); }
  catch { return __dirname; }
})();

// When running inside a pkg-compiled exe, resolve paths relative to the exe location
const appDir = process.pkg ? path.dirname(process.execPath) : _scriptDir;

const PORT = process.env.PORT || 3847;
const crashLogPath = path.join(appDir, 'crash.log');

// ── Crash Logging ──────────────────────────────────────────────────────────
function logCrash(label, err) {
  const msg = `[${new Date().toISOString()}] ${label}: ${err && err.stack ? err.stack : err}\n`;
  try { fs.appendFileSync(crashLogPath, msg); } catch (_) { /* ignore */ }
  console.error(msg);
}

process.on('uncaughtException', (err) => logCrash('uncaughtException', err));
process.on('unhandledRejection', (reason) => logCrash('unhandledRejection', reason));

process.on('exit', (code) => {
  if (code !== 0) {
    const msg = `[${new Date().toISOString()}] process.exit with code ${code}\n`;
    try { fs.appendFileSync(crashLogPath, msg); } catch (_) { /* ignore */ }
  }
});

// ── State ──────────────────────────────────────────────────────────────────
let agents = [];
let squadClient = null;
let cliProcess = null;
const agentSessions = new Map();
const nativeMessageQueue = [];

// ── WebSocket Broadcast ────────────────────────────────────────────────────
let wss;

function isSendable() {
  return wss && wss.clients.size > 0;
}

function broadcast(type, data) {
  nativeMessageQueue.push({ type, data });
  if (!isSendable()) return;
  const message = JSON.stringify({ type, data });
  for (const client of wss.clients) {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(message);
    }
  }
}

function sendTerminalLog(agentName, emoji, message, type = 'info') {
  broadcast('terminal-log', {
    timestamp: new Date().toISOString(), agentName, emoji, message, type
  });
}

function updateAgentStatus(agentId, status, outputLine) {
  const agent = agents.find(a => a.id === agentId);
  if (!agent) return;
  agent.status = status;
  if (outputLine) {
    agent.output.push(outputLine);
    if (agent.output.length > 100) agent.output.shift();
  }
  broadcast('agent-status-update', { agentId, status, output: agent.output });
}

function updateQueueItem(agentId, queueItem) {
  broadcast('queue-update', { agentId, queueItem });
}

// ── Find system Node.js ────────────────────────────────────────────────────
function findSystemNode() {
  try {
    const cmd = process.platform === 'win32' ? 'where node' : 'which node';
    const nodePath = execSync(cmd, { encoding: 'utf-8' }).trim().split('\n')[0].trim();
    return nodePath;
  } catch {
    return 'node';
  }
}

// ── Find bundled Copilot CLI path ──────────────────────────────────────────
function findCopilotCliPath() {
  const candidates = [
    // Dev mode: node_modules next to server.js
    path.join(_scriptDir, 'node_modules', '@github', 'copilot', 'index.js'),
    path.join(_scriptDir, '..', 'squad-pr', 'node_modules', '@github', 'copilot', 'index.js'),
    // Packaged exe: node_modules next to the exe on disk
    path.join(appDir, 'node_modules', '@github', 'copilot', 'index.js'),
    path.join(appDir, '..', 'squad-pr', 'node_modules', '@github', 'copilot', 'index.js'),
    path.join(appDir, '..', 'squad-desktop', 'node_modules', '@github', 'copilot', 'index.js'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  // Try resolving from system npm global
  try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf-8' }).trim();
    const globalPath = path.join(globalRoot, '@github', 'copilot', 'index.js');
    if (fs.existsSync(globalPath)) return globalPath;
  } catch { /* ignore */ }
  return null;
}

// ── Copilot Connection ─────────────────────────────────────────────────────
let connectionState = 'disconnected';

async function initCopilotClient(retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      connectionState = 'connecting';
      console.log(`[CONN] attempt ${attempt} — starting`);

      if (cliProcess) {
        try { cliProcess.kill(); } catch (_) { /* ignore */ }
        cliProcess = null;
      }

      const cliPath = findCopilotCliPath();
      if (!cliPath) {
        throw new Error('Copilot CLI not found. Ensure @github/copilot is installed.');
      }

      const systemNode = findSystemNode();
      console.log(`[CONN] cli=${cliPath}`);
      console.log(`[CONN] node=${systemNode}`);
      if (attempt === 0) {
        sendTerminalLog('System', '⏳', `Using CLI: ${cliPath}`, 'analyzing');
        sendTerminalLog('System', '⏳', `Using Node: ${systemNode}`, 'analyzing');
      } else {
        sendTerminalLog('System', '⏳', `Retry ${attempt}/${retries}...`, 'analyzing');
      }

      console.log(`[CONN] spawning CLI server...`);
      const cliPort = await startCopilotServer(systemNode, cliPath);
      console.log(`[CONN] CLI server on port ${cliPort}`);
      sendTerminalLog('System', '⏳', `CLI server on port ${cliPort}`, 'analyzing');

      console.log(`[CONN] creating CopilotClient with cliUrl=localhost:${cliPort}`);
      const copilotClient = new CopilotClient({
        cliUrl: `localhost:${cliPort}`,
      });
      console.log(`[CONN] calling copilotClient.start()...`);
      await copilotClient.start();
      console.log(`[CONN] copilotClient started OK`);
      squadClient = copilotClient;

      connectionState = 'connected';
      sendTerminalLog('System', '🟢', 'Connected to GitHub Copilot', 'success');
      return true;
    } catch (err) {
      console.error(`[CONN] FAILED attempt ${attempt}: ${err.stack || err}`);
      logCrash('copilot-connect', err);
      if (attempt < retries) {
        sendTerminalLog('System', '⚠️', `Connection attempt failed, retrying... (${err.message})`, 'error');
        await new Promise(r => setTimeout(r, 2000));
      } else {
        connectionState = 'error';
        sendTerminalLog('System', '🔴', `Copilot connection failed: ${err.message}`, 'error');
        return false;
      }
    }
  }
}

function startCopilotServer(nodePath, cliPath) {
  return new Promise((resolve, reject) => {
    const args = [
      cliPath,
      '--headless',
      '--no-auto-update',
      '--log-level', 'warning',
      '--port', '0'
    ];

    const env = { ...process.env };
    delete env.NODE_DEBUG;
    delete env.ELECTRON_RUN_AS_NODE;

    cliProcess = spawn(nodePath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: process.cwd(),
      env,
      windowsHide: true
    });

    let stdout = '';
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error('CLI server startup timed out (15s)'));
      }
    }, 15000);

    cliProcess.stdout.on('data', (data) => {
      stdout += data.toString();
      const match = stdout.match(/listening on port (\d+)/i);
      if (match && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve(parseInt(match[1], 10));
      }
    });

    cliProcess.stderr.on('data', (data) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (line.trim()) console.error(`[CLI] ${line}`);
      }
    });

    cliProcess.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(err);
      }
    });

    cliProcess.on('exit', (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(new Error(`CLI exited with code ${code}`));
      } else {
        console.error(`[CLI] Process exited unexpectedly with code ${code}`);
        logCrash('cli-exit', new Error(`CLI process exited with code ${code} after startup`));
        connectionState = 'error';
        cliProcess = null;
        squadClient = null;
        sendTerminalLog('System', '🔴', `Copilot CLI process died (code ${code}). Click reconnect.`, 'error');
      }
    });
  });
}

async function getOrCreateSession(agentId) {
  let entry = agentSessions.get(agentId);
  if (entry?.session) return entry;

  const agent = agents.find(a => a.id === agentId);
  if (!agent || !squadClient) return null;

  try {
    const session = await squadClient.createSession({
      systemMessage: {
        mode: 'append',
        content: `You are ${agent.name}, a ${agent.role} AI agent. You work as part of a Squad team. Be concise and actionable in your responses. Focus on your role expertise.`
      }
    });

    entry = { session, busy: false };
    agentSessions.set(agentId, entry);

    sendTerminalLog(agent.name, '🔗', `${agent.name} session created (${session.sessionId.slice(0, 8)}...)`, 'success');
    return entry;
  } catch (err) {
    logCrash('session-create', err);
    sendTerminalLog(agent.name, '🔴', `Session creation failed: ${err.message}`, 'error');
    return null;
  }
}

// ── Command Processing ─────────────────────────────────────────────────────
async function processCommand(agentId, queueItem) {
  const agent = agents.find(a => a.id === agentId);
  if (!agent) return;

  const { command } = queueItem;

  updateAgentStatus(agentId, 'WORKING');
  queueItem.status = 'RUNNING';
  updateQueueItem(agentId, queueItem);

  sendTerminalLog(agent.name, '📦', `${agent.name} received: "${command}"`, 'received');

  const entry = await getOrCreateSession(agentId);
  if (!entry) {
    sendTerminalLog(agent.name, '🔴', 'No Copilot session — cannot process', 'error');
    queueItem.status = 'FAILED';
    queueItem.result = 'No Copilot connection';
    updateQueueItem(agentId, queueItem);
    updateAgentStatus(agentId, 'ERROR');
    return;
  }

  const { session } = entry;
  let fullResponse = '';

  try {
    sendTerminalLog(agent.name, '⚡', `${agent.name} is thinking...`, 'analyzing');

    const unsubAll = session.on((event) => {
      const type = event.type || 'unknown';
      console.log(`[EVENT] ${agent.name}: ${type}`, JSON.stringify(event.data || {}).slice(0, 200));

      if (type === 'assistant.message_delta') {
        const delta = event.data?.deltaContent || event.data?.delta || '';
        if (delta) {
          fullResponse += delta;
          const chunk = delta.trim();
          if (chunk) {
            sendTerminalLog(agent.name, '→', chunk, 'working');
            updateAgentStatus(agentId, 'WORKING', chunk);
          }
        }
      } else if (type === 'assistant.message') {
        const content = event.data?.content || '';
        if (content && !fullResponse) {
          fullResponse = content;
        }
      }
      // Tool start/complete events are logged to console only — too noisy for the terminal UI
    });

    const result = await session.sendAndWait({ prompt: command }, 300000);

    unsubAll();

    if (!fullResponse && result?.data?.content) {
      fullResponse = result.data.content;
    }

    if (fullResponse && !fullResponse.includes('\n')) {
      sendTerminalLog(agent.name, '💬', fullResponse, 'response');
    } else if (fullResponse) {
      for (const line of fullResponse.split('\n').filter(l => l.trim())) {
        sendTerminalLog(agent.name, '💬', line, 'response');
      }
    }

    sendTerminalLog(agent.name, '✅', `${agent.name} completed task`, 'success');

    queueItem.status = 'DONE';
    queueItem.result = fullResponse.slice(0, 500) || 'Task completed';
    updateQueueItem(agentId, queueItem);
    updateAgentStatus(agentId, 'IDLE');

  } catch (err) {
    logCrash('processCommand', err);
    sendTerminalLog(agent.name, '🔴', `Error: ${err.message}`, 'error');
    queueItem.status = 'FAILED';
    queueItem.result = err.message;
    updateQueueItem(agentId, queueItem);
    updateAgentStatus(agentId, 'ERROR');
    setTimeout(() => updateAgentStatus(agentId, 'IDLE'), 3000);
  }
}

// ── Agent Seed ─────────────────────────────────────────────────────────────
function seedAgents() {
  agents = [
    { id: randomUUID(), name: 'Cobb', role: 'Lead / Architect', emoji: '🏗️', status: 'IDLE', output: [], queue: [] },
    { id: randomUUID(), name: 'Ariadne', role: 'Frontend Dev', emoji: '⚛️', status: 'IDLE', output: [], queue: [] },
    { id: randomUUID(), name: 'Eames', role: 'Systems Dev', emoji: '⚙️', status: 'IDLE', output: [], queue: [] },
  ];
}

// ── Express App ────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(appDir, 'public')));

// REST API — replaces IPC handlers
app.get('/api/agents', (_req, res) => {
  res.json(agents);
});

app.post('/api/agents', (req, res) => {
  const { name, role, emoji } = req.body;
  if (!name || !role) return res.status(400).json({ error: 'name and role are required' });
  const newAgent = { id: randomUUID(), name, role, emoji: emoji || '🤖', status: 'IDLE', output: [], queue: [] };
  agents.push(newAgent);
  res.status(201).json(agents);
});

app.delete('/api/agents/:id', async (req, res) => {
  const agentId = req.params.id;
  const entry = agentSessions.get(agentId);
  if (entry?.session) {
    try { await entry.session.destroy(); } catch (_) { /* ignore */ }
    agentSessions.delete(agentId);
  }
  agents = agents.filter(a => a.id !== agentId);
  res.json(agents);
});

app.post('/api/agents/:id/command', (req, res) => {
  const agentId = req.params.id;
  const agent = agents.find(a => a.id === agentId);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const { command } = req.body;
  if (!command) return res.status(400).json({ error: 'command is required' });

  const queueItem = {
    id: randomUUID(), command, status: 'PENDING',
    timestamp: new Date().toISOString(), result: null
  };

  agent.queue.push(queueItem);
  updateQueueItem(agentId, queueItem);
  processCommand(agentId, queueItem);
  res.status(202).json(queueItem);
});

app.get('/api/agents/:id/queue', (req, res) => {
  const agent = agents.find(a => a.id === req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  res.json(agent.queue);
});

app.get('/api/connection-status', (_req, res) => {
  res.json({ status: connectionState });
});

app.post('/api/reconnect', async (_req, res) => {
  const result = await initCopilotClient();
  res.json({ success: result, status: connectionState });
});

// ── HTTP + WebSocket Server ────────────────────────────────────────────────
const server = createServer(app);

wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log(`[WS] Client connected (${wss.clients.size} total)`);
  // Send current state on connect so the client is caught up
  ws.send(JSON.stringify({ type: 'initial-state', data: { agents, connectionState } }));
  ws.on('close', () => {
    console.log(`[WS] Client disconnected (${wss.clients.size} total)`);
  });
});

// ── Native WebView Window ──────────────────────────────────────────────────
function setupNativeWindow() {
  const w = new Webview();
  w.title('Squad Desktop');
  w.size(1200, 800);

  // Read and inline all frontend files
  const publicDir = path.join(appDir, 'public');
  let html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(publicDir, 'styles.css'), 'utf8');
  const apiJs = fs.readFileSync(path.join(publicDir, 'squadAPI.js'), 'utf8');
  const rendererJs = fs.readFileSync(path.join(publicDir, 'renderer.js'), 'utf8');

  // Inline everything (replace external refs with inline content)
  html = html.replace('<link rel="stylesheet" href="styles.css">', `<style>${css}</style>`);
  html = html.replace('<link rel="manifest" href="manifest.json">', '');
  html = html.replace('<script src="squadAPI.js"></script>', `<script>${apiJs}</script>`);
  html = html.replace('<script src="renderer.js"></script>', `<script>${rendererJs}</script>`);
  // Remove service worker registration (not needed in native window)
  html = html.replace(/<script>\s*if\s*\('serviceWorker'[\s\S]*?<\/script>/, '');

  // Bind API functions — these execute inside the webview message loop
  w.bind('nativeGetAgents', () => JSON.stringify(agents));

  w.bind('nativeAddAgent', (seq, name, role, emoji) => {
    const newAgent = { id: randomUUID(), name, role, emoji: emoji || '🤖', status: 'IDLE', output: [], queue: [] };
    agents.push(newAgent);
    return JSON.stringify(agents);
  });

  w.bind('nativeRemoveAgent', (seq, agentId) => {
    const entry = agentSessions.get(agentId);
    if (entry?.session) {
      try { entry.session.destroy(); } catch (_) { /* ignore */ }
      agentSessions.delete(agentId);
    }
    agents = agents.filter(a => a.id !== agentId);
    return JSON.stringify(agents);
  });

  w.bind('nativeSendCommand', (seq, agentId, command) => {
    const agent = agents.find(a => a.id === agentId);
    if (!agent) return JSON.stringify({ error: 'Agent not found' });
    if (!command) return JSON.stringify({ error: 'command is required' });

    const queueItem = {
      id: randomUUID(), command, status: 'PENDING',
      timestamp: new Date().toISOString(), result: null
    };
    agent.queue.push(queueItem);
    updateQueueItem(agentId, queueItem);
    processCommand(agentId, queueItem);
    return JSON.stringify(queueItem);
  });

  w.bind('nativeGetQueue', (seq, agentId) => {
    const agent = agents.find(a => a.id === agentId);
    if (!agent) return JSON.stringify([]);
    return JSON.stringify(agent.queue);
  });

  w.bind('nativeGetConnectionStatus', () => {
    return JSON.stringify({ status: connectionState });
  });

  w.bind('nativeReconnectCopilot', () => {
    initCopilotClient();
    return JSON.stringify({ status: connectionState });
  });

  w.bind('nativePoll', () => {
    return JSON.stringify(nativeMessageQueue.splice(0));
  });

  w.html(html);
  w.show(); // Blocks — but bind callbacks still fire via message loop
  shutdown();
}

// ── Startup ────────────────────────────────────────────────────────────────
seedAgents();

server.listen(PORT, async () => {
  console.log(`[SERVER] Squad Desktop running at http://localhost:${PORT}`);

  sendTerminalLog('System', '⏳', 'Connecting to GitHub Copilot...', 'analyzing');
  await initCopilotClient();

  try {
    setupNativeWindow();
  } catch (err) {
    console.error('[SERVER] WebView2 failed:', err.message, '— opening browser');
    const url = `http://localhost:${PORT}`;
    try {
      if (process.platform === 'win32') execSync(`start "" "${url}"`, { stdio: 'ignore' });
      else if (process.platform === 'darwin') execSync(`open "${url}"`, { stdio: 'ignore' });
      else execSync(`xdg-open "${url}"`, { stdio: 'ignore' });
    } catch { console.log(`[SERVER] Open manually: ${url}`); }
  }
});

// ── Graceful Shutdown ──────────────────────────────────────────────────────
function shutdown() {
  console.log('[SERVER] Shutting down...');
  if (cliProcess) {
    try { cliProcess.kill(); } catch (_) { /* ignore */ }
    cliProcess = null;
  }
  squadClient = null;
  agentSessions.clear();
  wss.close();
  server.close(() => process.exit(0));
  // Force exit after 3s if graceful close stalls
  setTimeout(() => process.exit(0), 3000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
