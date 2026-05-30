'use strict';

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog } = require('electron');
const { join }          = require('path');
const { pathToFileURL } = require('url');
const { homedir }       = require('os');
const { mkdirSync, existsSync } = require('fs');
const { startWorker }   = require('./desktop-worker.cjs');

const DATA_DIR = join(homedir(), 'AppData', 'Roaming', 'IdentityAtlas');
const PORT     = process.env.PORT || '3001';
const API_URL  = `http://localhost:${PORT}`;

let tray   = null;
let splash = null;
let win    = null;

// In packaged mode, extraResources land in process.resourcesPath (real filesystem).
// In dev mode, resolve relative to source tree.
const IS_PACKAGED = app.isPackaged;

function resOf(...parts) {
  return IS_PACKAGED
    ? join(process.resourcesPath, ...parts)
    : join(__dirname, '../api/src', ...parts);
}

function resRootOf(...parts) {
  return IS_PACKAGED
    ? join(process.resourcesPath, ...parts)
    : join(__dirname, '../api', ...parts);
}

// ─── Splash ───────────────────────────────────────────────────────────────────

function createSplash() {
  splash = new BrowserWindow({
    width:           450,
    height:          280,
    frame:           false,
    alwaysOnTop:     true,
    resizable:       false,
    movable:         true,
    backgroundColor: '#1a1a2e',
    webPreferences:  { nodeIntegration: false, contextIsolation: true },
    show:            false,
  });
  splash.loadFile(join(__dirname, 'splash.html'));
  splash.once('ready-to-show', () => {
    if (splash && !splash.isDestroyed()) splash.show();
  });
}

// ─── Main window ──────────────────────────────────────────────────────────────

function createWindow() {
  win = new BrowserWindow({
    width:   1400,
    height:  900,
    title:   'Identity Atlas',
    webPreferences: {
      preload:          join(__dirname, 'preload.js'),
      nodeIntegration:  false,
      contextIsolation: true,
    },
  });
  win.loadURL(API_URL);
  win.on('closed', () => { win = null; });
}

// ─── Tray ─────────────────────────────────────────────────────────────────────

function buildTrayIcon() {
  for (const name of ['icon.ico', 'icon.png']) {
    const iconPath = join(__dirname, 'build', name);
    if (existsSync(iconPath)) return nativeImage.createFromPath(iconPath);
  }
  // Fallback: 16x16 solid indigo square generated from raw RGBA bytes.
  const size = 16;
  const buf  = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    buf[i * 4 + 0] = 99;   // R
    buf[i * 4 + 1] = 102;  // G
    buf[i * 4 + 2] = 241;  // B  (indigo-500)
    buf[i * 4 + 3] = 255;  // A
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    {
      label: 'Open Identity Atlas',
      click: () => {
        if (win) { win.focus(); }
        else     { createWindow(); }
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => app.quit(),
    },
  ]);
}

function createTray() {
  tray = new Tray(buildTrayIcon());
  tray.setToolTip('Identity Atlas');
  tray.setContextMenu(buildTrayMenu());
  tray.on('double-click', () => {
    if (win) { win.focus(); }
    else     { createWindow(); }
  });
}

// ─── Health poll ──────────────────────────────────────────────────────────────

async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`API at ${url} did not become healthy within ${timeoutMs / 1000}s`);
}

// ─── Backend ──────────────────────────────────────────────────────────────────

async function startBackend() {
  mkdirSync(DATA_DIR,                  { recursive: true });
  mkdirSync(join(DATA_DIR, 'uploads'), { recursive: true });
  mkdirSync(join(DATA_DIR, 'jobs'),    { recursive: true });

  process.env.USE_SQL         = 'true';
  process.env.PORT            = PORT;
  process.env.NODE_ENV        = process.env.NODE_ENV || 'production';
  process.env.DESKTOP_MODE    = 'true';
  process.env.WORKER_KEY_FILE = join(DATA_DIR, '.builtin-worker-key');
  process.env.MASTER_KEY_FILE = join(DATA_DIR, '.master-key');
  process.env.UPLOAD_ROOT     = join(DATA_DIR, 'uploads');
  process.env.TRACE_DIR       = join(DATA_DIR, 'jobs');

  if (IS_PACKAGED) {
    process.env.FRONTEND_DIST = join(process.resourcesPath, 'dist-frontend');
    process.env.IA_APP_ROOT   = join(process.resourcesPath, 'bundled-scripts');
  } else {
    process.env.IA_APP_ROOT = join(__dirname, '../..');
  }

  // Initialize PGlite (WebAssembly PostgreSQL, runs in-process — no subprocess, no binary extraction).
  const pgDataDir = join(DATA_DIR, 'pgdata');
  mkdirSync(pgDataDir, { recursive: true });
  const { PGlite } = await import('@electric-sql/pglite');
  const pgInstance = new PGlite(pgDataDir);
  await pgInstance.waitReady;
  globalThis.__pgliteInstance = pgInstance;

  // Import the Express app bundle. connection.js reads globalThis.__pgliteInstance
  // at module-init time, so the instance must be set before this import.
  if (IS_PACKAGED) {
    await import(pathToFileURL(join(process.resourcesPath, 'app-bundle.mjs')).href);
  } else {
    await import(pathToFileURL(join(__dirname, '../api/src/index.js')).href);
  }
}

// ─── App lifecycle ────────────────────────────────────────────────────────────

// Keep the app running when all windows are closed (tray app).
Menu.setApplicationMenu(null);

app.on('window-all-closed', () => app.quit());

// PGlite shuts down cleanly when the Node process exits — no explicit stop needed.

ipcMain.on('quit', () => app.quit());

app.whenReady().then(async () => {
  createTray();
  createSplash();

  try {
    await startBackend();
    await waitForHealth(`${API_URL}/api/health`, 60_000);
  } catch (err) {
    if (splash && !splash.isDestroyed()) splash.close();
    await dialog.showErrorBox(
      'Identity Atlas — Startup Failed',
      err.message || String(err)
    );
    app.quit();
    return;
  }

  if (splash && !splash.isDestroyed()) { splash.close(); splash = null; }

  createWindow();
  startWorker();
});
