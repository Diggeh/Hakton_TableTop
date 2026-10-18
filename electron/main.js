import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../database/index.js';
import { createRepositories } from '../database/repositories.js';
import { seedIfEmpty } from '../database/seed.js';
import { startServer } from '../backend/server.js';
import { DEFAULT_PORT } from '../shared/events.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEV_URL = process.env.VITE_DEV_SERVER_URL; // set by `npm run dev`

let db = null;
let server = null;
let mainWindow = null;

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

async function bootstrap() {
  // 1. Storage
  db = openDatabase(path.join(app.getPath('userData'), 'hakton.db'));
  const repos = createRepositories(db);
  seedIfEmpty(repos);

  // 2. Embedded backend (Socket.io + PeerJS signaling)
  const port = Number(process.env.HAKTON_PORT) || DEFAULT_PORT;
  server = await startServer({ repos, port });
  console.log(`[hakton] backend listening on :${server.port}`);

  // 3. IPC: renderer asks where the local backend lives
  ipcMain.handle('hakton:server-info', () => ({
    url: `http://127.0.0.1:${server.port}`,
    port: server.port,
  }));

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
  Promise.resolve(server?.close())
    .catch(() => {})
    .finally(() => {
      db?.close();
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
