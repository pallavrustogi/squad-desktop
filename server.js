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
const agentProcessingLock = new Map(); // per-agent command serialization

// ── WebSocket Broadcast ────────────────────────────────────────────────────
let wss;

function isSendable() {
  return wss && wss.clients.size > 0;
}

function broadcast(type, data) {
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
    // Fallback: check common macOS/Linux Node.js install paths
    const fallbacks = [
      '/opt/homebrew/bin/node',
      '/usr/local/bin/node',
    ];
    for (const p of fallbacks) {
      if (fs.existsSync(p)) return p;
    }
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
    let stderrBuf = '';
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
      const text = data.toString();
      stderrBuf += text;
      const lines = text.split('\n');
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
        reject(new Error(`CLI exited with code ${code}. stderr: ${stderrBuf.slice(0, 500)}`));
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
    const roster = agents.map(a => `- ${a.emoji} ${a.name} (${a.role})${a.id === agentId ? ' ← you' : ''}`).join('\n');
    const session = await squadClient.createSession({
      systemMessage: {
        mode: 'append',
        content: `You are ${agent.name}, a ${agent.role} AI agent. You work as part of a Squad team.\n\nYour team roster:\n${roster}\n\nBe concise and actionable in your responses. Focus on your role expertise. When referring to teammates, use their names.`
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
// Serialize commands per agent — copilot sessions can't handle concurrent sendAndWait
function enqueueCommand(agentId, queueItem) {
  const prev = agentProcessingLock.get(agentId) || Promise.resolve();
  const next = prev.then(() => processCommand(agentId, queueItem)).catch(() => {});
  agentProcessingLock.set(agentId, next);
}

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
      console.error(`[EVENT] ${agent.name}: ${type}`, JSON.stringify(event.data || {}).slice(0, 300));

      if (type === 'assistant.message_delta') {
        const delta = event.data?.deltaContent || event.data?.delta || event.data?.content || '';
        if (delta) {
          fullResponse += delta;
          const chunk = delta.trim();
          if (chunk) {
            sendTerminalLog(agent.name, '→', chunk, 'working');
            updateAgentStatus(agentId, 'WORKING', chunk);
          }
        }
      } else if (type === 'assistant.message') {
        const content = event.data?.content || event.data?.text || '';
        if (content) {
          fullResponse = content;
        }
      }
    });

    const result = await session.sendAndWait({ prompt: command }, 300000);

    unsubAll();

    // Try multiple paths to extract response from result
    if (!fullResponse) {
      const r = result || {};
      fullResponse = r.data?.content || r.content || r.data?.text || r.text
        || r.data?.message || r.message || (typeof r === 'string' ? r : '');
    }
    console.error(`[RESULT] ${agent.name}: fullResponse length=${fullResponse.length}, result keys=${JSON.stringify(Object.keys(result || {}))}`);
    if (result?.data) console.error(`[RESULT] result.data keys=${JSON.stringify(Object.keys(result.data || {}))}`);

    // Log response to terminal
    if (fullResponse) {
      const lines = fullResponse.split('\n').filter(l => l.trim());
      for (const line of lines) {
        sendTerminalLog(agent.name, '💬', line, 'response');
      }
    } else {
      sendTerminalLog(agent.name, '⚠️', `${agent.name} finished but returned no text`, 'error');
    }

    sendTerminalLog(agent.name, '✅', `${agent.name} completed task`, 'success');

    // Push response lines to agent card (covers assistant.message path)
    if (fullResponse && agent.output.length === 0) {
      const lines = fullResponse.split('\n').filter(l => l.trim());
      for (const line of lines) {
        updateAgentStatus(agentId, 'WORKING', line);
      }
    }

    // Response-based delegation: scan for mentions of other agents in the response
    detectResponseDelegations(agent, fullResponse);

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

// ── Response-Based Delegation ──────────────────────────────────────────────
// When an agent's response mentions another agent doing work, auto-route to them.
function detectResponseDelegations(sourceAgent, response) {
  if (!response) return;
  for (const target of agents) {
    if (target.id === sourceAgent.id) continue;
    const n = target.name;
    const nRe = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Patterns: "Ariadne's on it", "I've asked Ariadne to X", "Ariadne will review X",
    // "asking Ariadne to X", "delegating to Ariadne", "Here's Ariadne's review"
    const patterns = [
      new RegExp(`(?:I've |I have |I'll |let me )?(?:ask|asked|asking)\\s+${nRe}\\s+to\\s+(.+?)(?:\\.|\\n|$)`, 'i'),
      new RegExp(`${nRe}\\s+(?:will|can|should|is going to)\\s+(.+?)(?:\\.|\\n|$)`, 'i'),
      new RegExp(`${nRe}'s\\s+on\\s+it`, 'i'),
      new RegExp(`delegat(?:e|ed|ing)\\s+(?:this )?to\\s+${nRe}`, 'i'),
      new RegExp(`(?:here(?:'s| is)\\s+)?${nRe}'s\\s+(review|analysis|assessment|findings|report|feedback|suggestions|recommendations|work|output)`, 'i'),
      new RegExp(`${nRe}\\s+(?:reviewed|analyzed|checked|found|flagged|identified|reported|noted)\\s+(.+?)(?:\\.|\\n|$)`, 'i'),
    ];

    for (const p of patterns) {
      const m = response.match(p);
      if (m) {
        const task = m[1] ? m[1].trim() : `Follow up on ${sourceAgent.name}'s request`;
        // Don't re-delegate if target is already working
        if (target.status === 'WORKING') break;

        sendTerminalLog(sourceAgent.name, '🔀', `${sourceAgent.name} → ${target.name}: "${task}"`, 'info');
        const targetItem = {
          id: randomUUID(), command: task, status: 'PENDING',
          timestamp: new Date().toISOString(), result: null
        };
        target.queue.push(targetItem);
        updateQueueItem(target.id, targetItem);
        enqueueCommand(target.id, targetItem);
        break; // one delegation per agent per response
      }
    }
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

// ── Delegation Detection ───────────────────────────────────────────────────
// Detects ALL "ask X to do Y" patterns in a compound command and returns an array.
function detectDelegations(command, sourceAgent) {
  const results = [];
  let remaining = command;
  for (const target of agents) {
    if (target.id === sourceAgent.id) continue;
    const n = target.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
      new RegExp(`(?:can you |please )?(?:ask|as)\\s+${n}\\s+to\\s+(.+?)(?=\\.|$|\\bask\\s|\\btell\\s|\\bhave\\s|\\bdelegate\\s)`, 'i'),
      new RegExp(`(?:can you |please )?tell\\s+${n}\\s+to\\s+(.+?)(?=\\.|$|\\bask\\s|\\btell\\s|\\bhave\\s|\\bdelegate\\s)`, 'i'),
      new RegExp(`(?:can you |please )?have\\s+${n}\\s+(.+?)(?=\\.|$|\\bask\\s|\\btell\\s|\\bhave\\s|\\bdelegate\\s)`, 'i'),
      new RegExp(`(?:can you |please )?delegate\\s+to\\s+${n}\\s+to\\s+(.+?)(?=\\.|$|\\bask\\s|\\btell\\s|\\bhave\\s|\\bdelegate\\s)`, 'i'),
      new RegExp(`(?:can you |please )?delegate\\s+(?:this\\s+)?to\\s+${n}`, 'i'),
    ];
    for (const p of patterns) {
      const m = remaining.match(p);
      if (m) {
        const task = (m[1] || '').trim().replace(/^"|"$/g, '').replace(/\.\s*$/, '');
        // For patterns without a captured task, derive from the full command
        const finalTask = task || remaining.replace(m[0], '').trim().replace(/^[.,;:\s]+|[.,;:\s]+$/g, '') || `Assist with ${sourceAgent.name}'s request`;
        results.push({ target, task: finalTask, fullMatch: m[0] });
        remaining = remaining.replace(m[0], '');
        break; // one match per agent
      }
    }
  }
  return results;
}

app.post('/api/agents/:id/command', (req, res) => {
  const agentId = req.params.id;
  const agent = agents.find(a => a.id === agentId);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const { command } = req.body;
  if (!command) return res.status(400).json({ error: 'command is required' });

  const delegations = detectDelegations(command, agent);

  const queueItem = {
    id: randomUUID(), command, status: 'PENDING',
    timestamp: new Date().toISOString(), result: null
  };

  agent.queue.push(queueItem);
  updateQueueItem(agentId, queueItem);

  if (delegations.length > 0) {
    // Route each delegation to its target agent
    const names = [];
    for (const d of delegations) {
      const targetItem = {
        id: randomUUID(), command: d.task, status: 'PENDING',
        timestamp: new Date().toISOString(), result: null
      };
      d.target.queue.push(targetItem);
      updateQueueItem(d.target.id, targetItem);
      enqueueCommand(d.target.id, targetItem);
      sendTerminalLog(agent.name, '🔀', `${agent.name} → ${d.target.name}: "${d.task}"`, 'info');
      names.push(d.target.name);
    }

    // Strip delegated parts — if remainder has substance, send to source agent too
    let remainder = command;
    for (const d of delegations) remainder = remainder.replace(d.fullMatch, '');
    remainder = remainder.replace(/[.,;]+\s*/g, ' ').trim();

    if (remainder.length > 10) {
      // Source agent still has its own work
      queueItem.command = remainder;
      enqueueCommand(agentId, queueItem);
      sendTerminalLog(agent.name, '📋', `${agent.name} also working on: "${remainder}"`, 'info');
    } else {
      queueItem.status = 'DONE';
      queueItem.result = `Delegated to ${names.join(', ')}`;
      updateQueueItem(agentId, queueItem);
    }
  } else {
    enqueueCommand(agentId, queueItem);
  }

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
  // Inject native-mode flag AND initial state so the UI works even if bind
  // callbacks can't fire (w.show() blocks the Node event loop, so Promises
  // from w.bind() may never resolve).
  const initialState = JSON.stringify({ agents, connectionState });
  html = html.replace('<script src="squadAPI.js"></script>',
    `<script>window.__NATIVE_MODE__ = true; window.__SQUAD_STATE__ = ${initialState};</script>\n<script>${apiJs}</script>`);
  html = html.replace('<script src="renderer.js"></script>', `<script>${rendererJs}</script>`);
  // Remove service worker registration (not needed in native window)
  html = html.replace(/<script>\s*if\s*\('serviceWorker'[\s\S]*?<\/script>/, '');

  // Bind API functions — these execute inside the webview message loop.
  // First arg from webview-nodejs bind() is the webview instance (w), then the JS args follow.
  w.bind('nativeGetAgents', (_w) => JSON.stringify(agents));

  w.bind('nativeAddAgent', (_w, name, role, emoji) => {
    const newAgent = { id: randomUUID(), name, role, emoji: emoji || '🤖', status: 'IDLE', output: [], queue: [] };
    agents.push(newAgent);
    return JSON.stringify(agents);
  });

  w.bind('nativeRemoveAgent', (_w, agentId) => {
    const entry = agentSessions.get(agentId);
    if (entry?.session) {
      try { entry.session.destroy(); } catch (_) { /* ignore */ }
      agentSessions.delete(agentId);
    }
    agents = agents.filter(a => a.id !== agentId);
    return JSON.stringify(agents);
  });

  w.bind('nativeSendCommand', (_w, agentId, command) => {
    const agent = agents.find(a => a.id === agentId);
    if (!agent) return JSON.stringify({ error: 'Agent not found' });
    if (!command) return JSON.stringify({ error: 'command is required' });

    const queueItem = {
      id: randomUUID(), command, status: 'PENDING',
      timestamp: new Date().toISOString(), result: null
    };
    agent.queue.push(queueItem);
    updateQueueItem(agentId, queueItem);
    enqueueCommand(agentId, queueItem);
    return JSON.stringify(queueItem);
  });

  w.bind('nativeGetQueue', (_w, agentId) => {
    const agent = agents.find(a => a.id === agentId);
    if (!agent) return JSON.stringify([]);
    return JSON.stringify(agent.queue);
  });

  w.bind('nativeGetConnectionStatus', (_w) => {
    return JSON.stringify({ status: connectionState });
  });

  w.bind('nativeReconnectCopilot', (_w) => {
    initCopilotClient();
    return JSON.stringify({ status: connectionState });
  });

  w.bind('nativePoll', (_w) => {
    return JSON.stringify(nativeMessageQueue.splice(0));
  });

  w.html(html);
  w.show(); // Blocks — but bind callbacks still fire via message loop
  shutdown();
}

// ── GUI Launcher (parent process) ──────────────────────────────────────────
// Spawns itself as the server process, waits for READY, then opens a native
// WebView2 window pointing at the Express server.  w.show() blocks this
// process's event loop, but the server runs in the child with its own loop.
function launchGUI() {
  const args = process.pkg ? [] : [process.argv[1]];
  const child = spawn(process.execPath, args, {
    env: { ...process.env, SQUAD_SERVER_MODE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });

  let launched = false;
  let buf = '';

  const startupTimeout = setTimeout(() => {
    if (!launched) {
      console.error('[GUI] Server startup timed out (30s)');
      try { child.kill(); } catch (_) {}
      process.exit(1);
    }
  }, 30000);

  child.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    const m = buf.match(/SQUAD_READY:(\d+)/);
    if (m && !launched) {
      launched = true;
      clearTimeout(startupTimeout);
      const port = m[1];
      console.log(`[GUI] Server ready on port ${port}, opening window...`);

      const w = new Webview();
      w.title('Squad Desktop');
      w.size(1200, 800);
      w.navigate(`http://localhost:${port}`);
      w.show(); // Blocks until window closes — server keeps running in child

      try { child.kill(); } catch (_) {}
      process.exit(0);
    }
  });

  child.stderr.on('data', (chunk) => {
    process.stderr.write(chunk);
  });

  child.on('exit', (code) => {
    if (!launched) {
      clearTimeout(startupTimeout);
      console.error(`[GUI] Server exited (code ${code}) before ready`);
      process.exit(1);
    }
  });

  process.on('exit', () => { try { child.kill(); } catch (_) {} });
}

// ── Startup ────────────────────────────────────────────────────────────────
if (process.env.SQUAD_SERVER_MODE === '1') {
  // Server mode: run Express + copilot (the GUI parent opens a WebView to us)
  seedAgents();
  server.listen(PORT, async () => {
    // Signal the parent (GUI) process that we're ready
    console.log(`SQUAD_READY:${PORT}`);
    console.log(`[SERVER] Squad Desktop running at http://localhost:${PORT}`);
    sendTerminalLog('System', '⏳', 'Connecting to GitHub Copilot...', 'analyzing');
    await initCopilotClient();
  });
} else {
  // GUI mode: launch server as child process, open native WebView window
  launchGUI();
}

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
