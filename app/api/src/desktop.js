// Desktop entry point — wraps the existing Express API with embedded PostgreSQL.
//
// Packaged by @yao-pkg/pkg into a single IdentityAtlas.exe.
// On first launch:
//   1. Downloads PG16 binaries to %APPDATA%\IdentityAtlas\postgres\ (~40 MB)
//   2. Initialises a PostgreSQL data directory
//   3. Starts the Express API (migrations run automatically)
//   4. Opens the default browser at http://localhost:3001
//   5. Starts the desktop job worker (polls for crawler jobs, spawns pwsh.exe)
//
// Subsequent launches skip the PG download (binaries already in installationDir)
// and open the existing database (data persists in pgdata\).
//
// Env vars set here override everything in index.js — set them BEFORE the
// dynamic import so they're visible at module evaluation time.

import { exec } from 'child_process';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { mkdirSync, existsSync, readdirSync, copyFileSync, statSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// User data lives here — survives updates, never inside the .exe snapshot.
const DATA_DIR = join(homedir(), 'AppData', 'Roaming', 'IdentityAtlas');

// Scripts are extracted from the pkg snapshot to a writable location so
// PowerShell can execute them (snapshot paths are read-only for execution).
const SCRIPTS_DIR = join(DATA_DIR, 'scripts');

// Frontend static files are bundled as pkg assets under dist-frontend/ relative
// to this file. Express can serve them from the pkg snapshot FS directly.
const FRONTEND_DIST_IN_PKG = join(__dirname, '../dist-frontend');

// ─── Configure environment before loading index.js ───────────────────────────

process.env.USE_SQL       = 'true';
process.env.PORT          = process.env.PORT || '3001';
process.env.NODE_ENV      = process.env.NODE_ENV || 'production';
process.env.DATABASE_URL  = `postgres://postgres@127.0.0.1:5433/identity_atlas`;

// Path overrides — redirect everything that would go to /data/uploads to the
// writable APPDATA directory.
process.env.WORKER_KEY_FILE = join(DATA_DIR, '.builtin-worker-key');
process.env.MASTER_KEY_FILE = join(DATA_DIR, '.master-key');
process.env.UPLOAD_ROOT     = join(DATA_DIR, 'uploads');
process.env.TRACE_DIR       = join(DATA_DIR, 'jobs');
// Only override frontend path inside a pkg bundle — when running directly
// with node, fall back to the normal ../../frontend/dist location.
if (process.pkg) {
  process.env.FRONTEND_DIST = FRONTEND_DIST_IN_PKG;
}

// ─── Script extraction ────────────────────────────────────────────────────────
// Copy PowerShell crawler scripts bundled as pkg assets to a writable location.
// Only copies files that are newer than the destination (version-safe update).

function extractDir(srcDir, destDir) {
  mkdirSync(destDir, { recursive: true });
  let entries;
  try {
    entries = readdirSync(srcDir, { withFileTypes: true });
  } catch {
    return;  // source dir not bundled — skip silently
  }
  for (const entry of entries) {
    const src  = join(srcDir, entry.name);
    const dest = join(destDir, entry.name);
    if (entry.isDirectory()) {
      extractDir(src, dest);
    } else {
      try {
        const srcMtime  = statSync(src).mtimeMs;
        const destMtime = existsSync(dest) ? statSync(dest).mtimeMs : 0;
        if (srcMtime > destMtime) copyFileSync(src, dest);
      } catch { /* non-fatal */ }
    }
  }
}

function extractScripts() {
  if (!process.pkg) {
    // Running directly with node (dev/test) — point straight at the repo root.
    process.env.IA_APP_ROOT = join(__dirname, '../../..');
    return;
  }
  const pkgRoot = join(__dirname, '../bundled-scripts');
  extractDir(pkgRoot, SCRIPTS_DIR);
  if (existsSync(SCRIPTS_DIR)) {
    process.env.IA_APP_ROOT = SCRIPTS_DIR;
  }
}

// ─── Health poll ──────────────────────────────────────────────────────────────

async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`API at ${url} did not become healthy within ${timeoutMs}ms`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(join(DATA_DIR, 'uploads'), { recursive: true });
  mkdirSync(join(DATA_DIR, 'jobs'),    { recursive: true });

  extractScripts();

  console.log('Identity Atlas Desktop — starting PostgreSQL...');
  console.log(`  Data directory: ${DATA_DIR}`);

  // embedded-postgres downloads PG binaries on first run, then reuses them.
  // installationDir and dataDir must be outside the pkg snapshot (writable).
  const epModule = await import('embedded-postgres');
  const EmbeddedPostgres = epModule.default ?? epModule.EmbeddedPostgres;
  const pg = new EmbeddedPostgres({
    port:         5433,
    persistent:   true,
    databaseDir:  join(DATA_DIR, 'pgdata'),
    authMethod:   'trust',
    initdbFlags:  ['--encoding=UTF8', '--locale=C'],
  });

  if (!existsSync(join(DATA_DIR, 'pgdata', 'PG_VERSION'))) {
    await pg.initialise();
  }
  await pg.start();

  try {
    await pg.createDatabase('identity_atlas');
  } catch {
    // Already exists on subsequent launches — ignore.
  }

  console.log('PostgreSQL started. Loading API...');

  // Dynamic import runs after env vars are set, so bootstrap.js picks them up.
  await import('./index.js');

  await waitForHealth('http://localhost:3001/api/health', 60_000);
  console.log('Identity Atlas ready at http://localhost:3001');

  // Open default browser (Windows: start, macOS: open, Linux: xdg-open)
  const openCmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start'
    : 'xdg-open';
  exec(`${openCmd} http://localhost:3001`);

  // Start in-process job worker (polls job queue, spawns pwsh.exe for each job)
  const { startWorker } = await import('./desktop-worker.js');
  startWorker();

  // Graceful shutdown: stop PG cleanly after Express shuts down
  const stop = async (signal) => {
    console.log(`\n${signal} — shutting down...`);
    try { await pg.stop(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT',  () => stop('SIGINT'));
}

main().catch(err => {
  console.error('Fatal error:', err.message || err);
  process.exit(1);
});
