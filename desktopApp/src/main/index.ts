import { app, BrowserWindow } from 'electron';
import * as path from 'path';
import { createWindow } from './window';
import { StreamParser } from './cli/stream-parser';
import { Protocol } from './cli/protocol';
import { IPCHandlers } from './ipc/handlers';

// Prevent crash on unhandled errors/rejections
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

let mainWindow: BrowserWindow | null = null;
let ipcHandlers: IPCHandlers | null = null;

app.whenReady().then(() => {
  mainWindow = createWindow();

  const streamParser = new StreamParser(new Map());
  ipcHandlers = new IPCHandlers(streamParser);

  ipcHandlers.setMainWindow(mainWindow);
  ipcHandlers.registerHandlers();
  ipcHandlers.initializeSampleAgents();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
      if (ipcHandlers) {
        ipcHandlers.setMainWindow(mainWindow);
      }
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
