import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { spawn, execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const crashLogPath = path.join(__dirname, 'crash.log');

function logCrash(label, err) {
  const msg = `[${new Date().toISOString()}] ${label}: ${err && err.stack ? err.stack : err}\n`;
  try { fs.appendFileSync(crashLogPath, msg); } catch (_) { /* ignore */ }
  console.error(msg);
}

process.on('uncaughtException', (err) => {
  logCrash('uncaughtException', err);
  try {
    dialog.showErrorBox('Squad Desktop Error', `${err.message}\n\nSee crash.log for details.`);
  } catch (_) { /* app might not be ready */ }
});

process.on('unhandledRejection', (reason) => {
  logCrash('unhandledRejection', reason);
  // Prevent Node.js from exiting on unhandled rejections
});

// Prevent exit on unhandled errors in Electron's main process
process.on('exit', (code) => {
  if (code !== 0) {
    const msg = `[${new Date().toISOString()}] process.exit with code ${code}\n`;
    try { fs.appendFileSync(crashLogPath, msg); } catch (_) { /* ignore */ }
  }
});

// ── State ──────────────────────────────────────────────────────────────────
let mainWindow;
let agents = [];
let squadClient = null;
let cliProcess = null;
const agentSessions = new Map();

function isSendable() {
  return mainWindow && !mainWindow.isDestroyed() &&
    mainWindow.webContents && !mainWindow.webContents.isDestroyed();
}

function sendTerminalLog(agentName, emoji, message, type = 'info') {
  if (isSendable()) {
    mainWindow.webContents.send('terminal-log', {
      timestamp: new Date().toISOString(), agentName, emoji, message, type
    });
  }
}

function updateAgentStatus(agentId, status, outputLine) {
  const agent = agents.find(a => a.id === agentId);
  if (!agent) return;
  agent.status = status;
  if (outputLine) {
    agent.output.push(outputLine);
    if (agent.output.length > 100) agent.output.shift();
  }
  if (isSendable()) {
    mainWindow.webContents.send('agent-status-update', agentId, status, agent.output);
  }
}

function updateQueueItem(agentId, queueItem) {
  if (isSendable()) {
    mainWindow.webContents.send('queue-update', agentId, queueItem);
  }
}

// ── Find system Node.js (not Electron's) ───────────────────────────────────
function findSystemNode() {
  try {
    const nodePath = execSync('where node', { encoding: 'utf-8' }).trim().split('\n')[0].trim();
    return nodePath;
  } catch {
    return 'node'; // hope it's on PATH
  }
}

// ── Find bundled Copilot CLI path ──────────────────────────────────────────
function findCopilotCliPath() {
  // Resolve from the squad-sdk's dependency on @github/copilot
  const candidates = [
    path.join(__dirname, 'node_modules', '@github', 'copilot', 'index.js'),
    path.join(__dirname, '..', 'squad-pr', 'node_modules', '@github', 'copilot', 'index.js'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ── Copilot Connection ─────────────────────────────────────────────────────
// Strategy: spawn Copilot CLI with system Node (not Electron's), connect via TCP
let connectionState = 'disconnected';

async function initCopilotClient(retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      connectionState = 'connecting';
      console.log(`[CONN] attempt ${attempt} — starting`);

      // Kill any leftover CLI process from a previous run
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

      // Spawn CLI server on a random port using system Node.js
      console.log(`[CONN] spawning CLI server...`);
      const cliPort = await startCopilotServer(systemNode, cliPath);
      console.log(`[CONN] CLI server on port ${cliPort}`);
      sendTerminalLog('System', '⏳', `CLI server on port ${cliPort}`, 'analyzing');

      // Use CopilotClient directly (SquadClient passes useLoggedInUser which conflicts with cliUrl)
      console.log(`[CONN] importing CopilotClient...`);
      const { CopilotClient } = await import('@github/copilot-sdk');
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
      '--port', '0' // random port
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
        // CLI died after successful startup
        console.error(`[CLI] Process exited unexpectedly with code ${code}`);
        logCrash('cli-exit', new Error(`CLI process exited with code ${code} after startup`));
        connectionState = 'error';
        cliProcess = null;
        squadClient = null;
        if (isSendable()) {
          sendTerminalLog('System', '🔴', `Copilot CLI process died (code ${code}). Click reconnect.`, 'error');
        }
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

// ── Command Processing (real Copilot) ──────────────────────────────────────
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

    // Use wildcard handler to catch ALL events from the session
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
        // Final complete message
        const content = event.data?.content || '';
        if (content && !fullResponse) {
          fullResponse = content;
        }
      } else if (type.includes('tool') && type.includes('start')) {
        const toolName = event.data?.toolName || event.data?.name || 'unknown';
        sendTerminalLog(agent.name, '🔧', `Using tool: ${toolName}`, 'action');
      } else if (type.includes('tool') && type.includes('complete')) {
        const toolName = event.data?.toolName || event.data?.name || 'unknown';
        sendTerminalLog(agent.name, '✓', `Tool complete: ${toolName}`, 'working');
      }
    });

    // Send prompt and wait for completion (5 min timeout for long tasks)
    const result = await session.sendAndWait({ prompt: command }, 300000);

    unsubAll();

    // Extract final response — from streaming deltas, sendAndWait result, or fallback
    if (!fullResponse && result?.data?.content) {
      fullResponse = result.data.content;
    }

    // Display final response in terminal if we only got it from the result
    if (fullResponse && !fullResponse.includes('\n')) {
      sendTerminalLog(agent.name, '💬', fullResponse, 'response');
    } else if (fullResponse) {
      // Multi-line: show each line
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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    backgroundColor: '#0a1929',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs')
    }
  });

  mainWindow.loadFile('renderer/index.html');
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── IPC Handlers ───────────────────────────────────────────────────────────
ipcMain.handle('get-agents', () => agents);

ipcMain.handle('add-agent', (event, name, role, emoji) => {
  const newAgent = { id: randomUUID(), name, role, emoji, status: 'IDLE', output: [], queue: [] };
  agents.push(newAgent);
  return agents;
});

ipcMain.handle('remove-agent', async (event, agentId) => {
  const entry = agentSessions.get(agentId);
  if (entry?.session) {
    try { await entry.session.destroy(); } catch (_) { /* ignore */ }
    agentSessions.delete(agentId);
  }
  agents = agents.filter(a => a.id !== agentId);
  return agents;
});

ipcMain.handle('send-command', async (event, agentId, command) => {
  const agent = agents.find(a => a.id === agentId);
  if (!agent) return null;

  const queueItem = {
    id: randomUUID(), command, status: 'PENDING',
    timestamp: new Date().toISOString(), result: null
  };

  agent.queue.push(queueItem);
  updateQueueItem(agentId, queueItem);
  processCommand(agentId, queueItem);
  return queueItem;
});

ipcMain.handle('get-queue', (event, agentId) => {
  const agent = agents.find(a => a.id === agentId);
  return agent ? agent.queue : [];
});

ipcMain.handle('get-connection-status', () => connectionState);

ipcMain.handle('reconnect-copilot', async () => {
  return await initCopilotClient();
});

// ── App Lifecycle ──────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  seedAgents();
  createWindow();

  mainWindow.webContents.once('did-finish-load', async () => {
    sendTerminalLog('System', '⏳', 'Connecting to GitHub Copilot...', 'analyzing');
    await initCopilotClient();
  });

  // Handle renderer process crashes
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    logCrash('render-process-gone', new Error(`Renderer crashed: ${details.reason} (code ${details.exitCode})`));
    console.error(`[CRASH] Renderer process gone: ${details.reason}`);
  });

  mainWindow.webContents.on('crashed', () => {
    logCrash('webcontents-crashed', new Error('Renderer process crashed'));
  });

  app.on('child-process-gone', (event, details) => {
    console.error(`[CRASH] Child process gone: ${details.type} ${details.reason} (code ${details.exitCode})`);
    logCrash('child-process-gone', new Error(`Child process gone: ${details.type} ${details.reason} (code ${details.exitCode})`));
    // If the Copilot CLI died, attempt reconnection
    if (details.type === 'Utility' || details.type === 'GPU') {
      console.log('[RECOVERY] Child process lost, checking Copilot connection...');
      if (connectionState !== 'connected') {
        sendTerminalLog('System', '⚠️', 'Connection lost — reconnecting...', 'error');
        setTimeout(() => initCopilotClient(), 3000);
      }
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Synchronous cleanup — no async in quit handlers (Electron doesn't wait)
app.on('before-quit', () => {
  // Kill CLI subprocess synchronously — this is the most important cleanup
  if (cliProcess) {
    try { cliProcess.kill(); } catch (_) { /* ignore */ }
    cliProcess = null;
  }
  // Sessions and squadClient cleanup is best-effort — process is exiting anyway
  squadClient = null;
  agentSessions.clear();
});
