# Squad Desktop

A Windows desktop app for monitoring and controlling [Squad](https://github.com/bradygaster/squad) AI agent teams in real time.

Squad Desktop gives you a visual interface to see what each agent is doing, issue commands directly to agents, queue tasks, and watch the terminal output — all from a native Electron window.

## Features

- **Agent Panel** — See all agents, their roles, and live status (idle / busy / error)
- **Terminal Output** — Scrolling log of all agent activity with timestamps
- **Command Queue** — Track pending, running, and completed commands
- **Command Input** — Send tasks to specific agents or broadcast to the team
- **Roster Manager** — Add/remove agents from the UI
- **Squad SDK Integration** — Launches `npx github:bradygaster/squad` under the hood

## Layout

| Left (240px) | Center (flex) | Right (320px) |
|---|---|---|
| Agent list + status | Terminal output log | Command queue |
| | Command input bar (bottom) | |

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- npm

### Run from source

```bash
cd desktopApp
npm install
npm run dev
```

### Build portable Windows exe

```bash
cd desktopApp
npm run package
```

The exe will be at `desktopApp/dist-packaged/Squad Desktop 0.1.0.exe`.

## How It Works

Squad Desktop wraps the Squad CLI (`npx github:bradygaster/squad`) as a child process. Commands you type in the UI are sent to the CLI via stdin; output is parsed line-by-line from stdout and rendered in the terminal pane.

When the CLI is unavailable, the app falls back to a local command processor with simulated agent responses so you can explore the UI without a live CLI connection.

## Tech Stack

- **Electron 28** — native desktop shell
- **React 18** — renderer UI
- **Zustand** — state management
- **Vite** — fast dev/build
- **TypeScript** — end to end

## License

MIT
