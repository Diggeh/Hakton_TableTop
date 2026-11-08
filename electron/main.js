import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkpoint } from '../database/index.js';
import { openDatabaseWithRecovery } from '../database/recovery.js';
import { createBackup, startBackupSchedule } from '../database/backup.js';
import { createRepositories } from '../database/repositories.js';
import { seedIfEmpty } from '../database/seed.js';
import { initStorage } from '../storage/index.js';
import {
  getLocalIpAddresses,
  getServerStatus,
  startServer,
  stopServer,
} from '../backend/server.js';
import { createAssetService } from '../backend/assetService.js';
import { registerAssetIpcHandlers } from './assetIpc.js';
import { DEFAULT_PORT } from '../shared/events.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEV_URL = process.env.VITE_DEV_SERVER_URL; // set by `npm run dev`

let db = null;
let repos = null;
let storage = null;
let server = null;
let mainWindow = null;
let recoveryInfo = null;
let stopBackups = null;

// Only one Hakton instance: a second one would fight over the port and SQLite file.
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.whenReady().then(bootstrap).catch(fatal);
}

function buildServerInfo() {
  if (!server) {
    return {
      running: false,
      url: null,
      port: null,
      hostSecret: null,
      sessionId: null,
      lanIps: getLocalIpAddresses(),
      lanUrls: [],
      status: getServerStatus(),
    };
  }
  return {
    running: true,
    url: server.localUrl,
    port: server.port,
    hostSecret: server.hostSecret,
    sessionId: server.sessionId,
    lanIps: server.lanIps,
    lanUrls: server.lanUrls,
    status: server.getStatus(),
  };
}

function registerIpcHandlers() {
  ipcMain.handle('hakton:server-info', () => buildServerInfo());

  ipcMain.handle('hakton:server-status', () => getServerStatus());

  ipcMain.handle('hakton:recovery-status', () => recoveryInfo);

  ipcMain.handle('hakton:server-start', async (_event, opts = {}) => {
    try {
      if (server) {
        await stopServer();
        server = null;
      }
      const targetPort =
        opts?.port !== undefined
          ? Number(opts.port)
          : Number(process.env.HAKTON_PORT) || DEFAULT_PORT;

      server = await startServer({
        repos,
        storage,
        port: targetPort,
        host: opts?.host || '0.0.0.0',
        sessionId: opts?.sessionId,
        sessionName: opts?.sessionName,
      });
      console.log(`[hakton] backend listening on :${server.port}`);
      return {
        ok: true,
        ...buildServerInfo(),
      };
    } catch (err) {
      console.error('[hakton] failed to start host server:', err.message);
      return {
        ok: false,
        error: err.message,
        code: err.code || 'E_SERVER_START_FAILED',
        ...buildServerInfo(),
      };
    }
  });

  ipcMain.handle('hakton:server-stop', async () => {
    try {
      await stopServer();
      server = null;
      console.log('[hakton] backend stopped');
      return {
        ok: true,
        ...buildServerInfo(),
      };
    } catch (err) {
      return {
        ok: false,
        error: err.message,
        ...buildServerInfo(),
      };
    }
  });

  // Narrowly scoped Asset Management & Catalog IPC operations
  const assetService = createAssetService({
    storage,
    repos,
    getBaseUrl: () => (server ? server.localUrl ?? `http://127.0.0.1:${server.port}` : null),
  });
  registerAssetIpcHandlers({
    ipcMain,
    dialog,
    getMainWindow: () => mainWindow,
    assetService,
  });
}

async function bootstrap() {
  // 1. Storage & Database (integrity check + automatic backup restore)
  storage = initStorage(app.getPath('userData'));
  const opened = openDatabaseWithRecovery({
    filePath: storage.dbPath,
    backupDir: storage.backupsDir,
  });
  db = opened.db;
  recoveryInfo = opened.recovery;

  if (recoveryInfo.recovered) {
    console.warn(`[hakton] recovered database from ${recoveryInfo.backupUsed}`);
  }
  if (recoveryInfo.corruptFile) {
    console.warn(`[hakton] corrupt database preserved at ${recoveryInfo.corruptFile}`);
  }

  repos = createRepositories(db);
  await seedIfEmpty(repos, storage);

  // Snapshot every five minutes so a hard crash never loses more than that.
  stopBackups = startBackupSchedule(db, storage.backupsDir, { intervalMs: 5 * 60 * 1000 });

  // 2. Register IPC bridge handlers before launching renderer
  registerIpcHandlers();

  // 3. Embedded backend (Socket.IO + PeerJS signaling)
  const port = Number(process.env.HAKTON_PORT) || DEFAULT_PORT;
  try {
    server = await startServer({ repos, storage, port });
    console.log(`[hakton] backend listening on :${server.port}`);
  } catch (err) {
    console.error(`[hakton] initial host startup failed on port ${port}:`, err.message);
  }

  // 4. UI
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#091540',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), // preload must be CommonJS
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => (mainWindow = null));

  // Never navigate the app window to external content; open links in the OS browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (DEV_URL) {
    mainWindow.loadURL(DEV_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

let shuttingDown = false;
app.on('before-quit', (event) => {
  if (shuttingDown) return;
  shuttingDown = true;
  event.preventDefault();
  stopBackups?.();
  stopBackups = null;
  Promise.resolve(stopServer())
    .catch(() => {})
    .finally(() => {
      server = null;
      // Final snapshot + WAL checkpoint so the next launch starts clean.
      try {
        if (db && storage?.backupsDir) createBackup(db, storage.backupsDir);
      } catch (error) {
        console.warn('[hakton] shutdown backup failed:', error?.message ?? error);
      }
      try {
        if (db) checkpoint(db);
      } catch {
        // Ignore checkpoint errors during shutdown.
      }
      try {
        db?.close();
      } catch {
        // Ignore close errors during shutdown.
      }
      app.exit(0);
    });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

function fatal(err) {
  console.error('[hakton] fatal during bootstrap:', err);
  app.exit(1);
}
