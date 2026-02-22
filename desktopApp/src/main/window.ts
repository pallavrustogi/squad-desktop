import { app, BrowserWindow } from 'electron';
import * as path from 'path';

export function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    center: true,
    show: true,
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

  if (isDev) {
    win.loadURL('http://localhost:5173').catch(() => {
      // Vite not ready — show fallback, no crash
      win.loadURL('data:text/html,' + encodeURIComponent(
        '<html><body style="background:#1a1a2e;color:#8be9fd;font-family:monospace;padding:40px">' +
        '<h1>Squad Desktop</h1><p>Waiting for dev server on localhost:5173...</p></body></html>'
      ));
    });
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  return win;
}
