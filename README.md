# Squad Desktop

AI Agent Monitoring & Control — a lightweight PWA desktop application for managing Squad agents in real time.

## Overview

Squad Desktop provides a real-time dashboard for monitoring and controlling AI agents spawned by [Squad](https://github.com/bradygaster/squad). It shows agent status, terminal output, and connection state via a WebSocket-powered UI.

**Architecture:** Node.js Express server + Progressive Web App (PWA) frontend. No Electron — zero native process dependencies, no `child-process-gone` crashes.

## Prerequisites

- **Node.js** ≥ 20
- **npm** ≥ 9
- **GitHub Copilot CLI** authenticated (`gh copilot` must work)
- **Squad SDK** — expects `@bradygaster/squad-sdk` at `../squad-pr/packages/squad-sdk`

## Quick Start

```bash
# Install dependencies
npm install

# Start the server (opens browser automatically)
npm start
```

The server starts on **http://localhost:3847** and opens your default browser. The PWA is installable — look for the install prompt in your browser's address bar.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT`   | `3847`  | HTTP/WebSocket server port |

## Project Structure

```
squad-desktop/
├── server.js              # Express + WebSocket server (main entry point)
├── public/                # PWA frontend (served as static files)
│   ├── index.html         # App shell with manifest + service worker registration
│   ├── renderer.js        # UI logic — agent cards, terminal, status updates
│   ├── styles.css         # Dark theme styling
│   ├── squadAPI.js        # Browser-side API bridge (fetch + WebSocket)
│   ├── manifest.json      # PWA manifest (standalone, dark theme)
│   └── service-worker.js  # Cache-first for app shell, network-first for API
├── package.json           # Dependencies and build scripts
├── dist/                  # Build output (exe + bundled assets)
├── main.js                # (legacy) Original Electron main process
├── preload.cjs            # (legacy) Original Electron preload bridge
└── renderer/              # (legacy) Original Electron renderer files
```

## How It Works

### Server (`server.js`)

- **Express** serves the PWA from `public/`
- **WebSocket** pushes real-time updates to all connected clients:
  - `terminal-log` — CLI output lines
  - `agent-status-update` — agent state changes
  - `queue-update` — work queue changes
  - `initial-state` — full state snapshot on connect
- **REST API** exposes endpoints for the frontend:
  - `GET /api/status` — connection status
  - `GET /api/agents` — list all agents
  - `POST /api/connect` — start Copilot CLI session
  - `POST /api/disconnect` — stop CLI session
  - `POST /api/send-message` — send a message to the CLI
  - `POST /api/queue-task` — add a task to the queue
- **Copilot CLI** is spawned as a child process and managed with graceful shutdown

### Frontend (`public/`)

- **`squadAPI.js`** provides `window.squadAPI` — a drop-in replacement for the old Electron preload bridge. Uses `fetch()` for REST calls and WebSocket for real-time push, with automatic reconnection (exponential backoff from 500ms to 30s).
- **`renderer.js`** renders agent cards, terminal output, and connection state. It works identically whether served by the dev server or the packaged exe.
- **Service Worker** caches the app shell (cache-first) and proxies API calls (network-first) for offline resilience.

## Building the Windows Executable

Squad Desktop can be packaged as a standalone Windows `.exe` that bundles Node.js, the server, and all dependencies.

### Build

```bash
npm run build
```

This runs three steps:
1. **`build:bundle`** — esbuild bundles `server.js` + all dependencies into `dist/server.cjs` (single CJS file, Node 20 target)
2. **`build:copy`** — copies `public/` to `dist/public/` (static PWA assets)
3. **`build:exe`** — `@yao-pkg/pkg` compiles `dist/server.cjs` into `dist/squad-desktop.exe` (node20-win-x64)

### Output

```
dist/
├── squad-desktop.exe    # ~44MB standalone executable
├── public/              # PWA frontend assets (must stay next to the exe)
└── server.cjs           # Intermediate bundle (can be deleted)
```

### Running the Executable

```bash
# Just double-click squad-desktop.exe, or from the command line:
.\dist\squad-desktop.exe
```

The exe starts the server and opens your default browser to `http://localhost:3847`.

> **Note:** The `dist/public/` folder must remain alongside `squad-desktop.exe`. If distributing, copy both the exe and the `public/` folder together.

### Build Dependencies

| Package | Purpose |
|---------|---------|
| `esbuild` | Bundles ESM server + deps into a single CJS file |
| `@yao-pkg/pkg` | Compiles Node.js app into a standalone executable |

## Development

```bash
# Start in development mode (auto-opens browser)
npm start

# The server watches no files — restart manually after changes:
# Ctrl+C, then npm start
```

### API Bridge

The frontend communicates with the server through `window.squadAPI`, which mirrors the original Electron IPC interface:

```javascript
// Check connection status
const status = await window.squadAPI.getConnectionStatus();

// Connect to Copilot CLI
await window.squadAPI.connect();

// Send a message
await window.squadAPI.sendMessage('Hello, agents!');

// Listen for real-time updates
window.squadAPI.onTerminalLog((data) => { /* terminal output */ });
window.squadAPI.onAgentStatusUpdate((data) => { /* agent changed */ });
window.squadAPI.onQueueUpdate((data) => { /* queue changed */ });
```

## Migration from Electron

This project was originally built with Electron but suffered from `child-process-gone` crashes (Windows `STATUS_CONTROL_C_EXIT` / code -1073741510) caused by Electron's utility process management. The migration to a PWA eliminated all native process dependencies while preserving the exact same UI and API surface.

**What changed:**
- `main.js` (Electron main process) → `server.js` (Express + WebSocket)
- `preload.cjs` (Electron IPC bridge) → `public/squadAPI.js` (fetch + WebSocket)
- `renderer/` (Electron renderer) → `public/` (standard web files)

**What stayed the same:**
- All UI code (`renderer.js`, `styles.css`)
- The `window.squadAPI` interface (drop-in compatible)
- Agent management logic and Copilot CLI integration

The original Electron files (`main.js`, `preload.cjs`, `renderer/`) are preserved in the repo as reference.

## License

See [squad-pr](../squad-pr) for license information.
