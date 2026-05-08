// Desktop entry point — wraps the existing Express API with embedded PostgreSQL.
//
// Packaged by @yao-pkg/pkg into a single IdentityAtlas.exe.
//
// CJS (.cjs) because pkg's bootstrap always uses Module._load (require) to start
// the entry file — ESM .mjs entries throw ERR_REQUIRE_ESM at runtime.
// Dynamic import() works here because --no-bytecode means source runs as normal
// Node.js modules (not vm.Script bytecode), so Node's native import() callback
// is available.

'use strict';

const { exec }          = require('child_process');
const { join }          = require('path');
const { pathToFileURL } = require('url');
const { homedir }       = require('os');
const { mkdirSync, existsSync, readdirSync, copyFileSync, statSync } = require('fs');
const { startWorker }   = require('./desktop-worker.cjs');

// __dirname is provided by CJS — no import.meta.url needed.
// This file lives in app/desktop/; API assets are one level over in app/api/.
const API_SRC  = join(__dirname, '../api/src');
const API_ROOT = join(__dirname, '../api');

const DATA_DIR             = join(homedir(), 'AppData', 'Roaming', 'IdentityAtlas');
const SCRIPTS_DIR          = join(DATA_DIR, 'scripts');
const PG_NATIVE_DIR        = join(DATA_DIR, 'postgres', 'native');
const FRONTEND_DIST_IN_PKG = join(API_ROOT, 'dist-frontend');

// The Express bundle and its runtime assets live here once extracted.
// ESM import() uses native C++ fs (not pkg's patched fs), so the bundle must be
// on the real filesystem.  We extract it on every launch if the exe is newer.
const APP_DIR = join(DATA_DIR, 'app');

// ─── Configure environment before loading index.js ───────────────────────────

process.env.USE_SQL       = 'true';
process.env.PORT          = process.env.PORT || '3001';
process.env.NODE_ENV      = process.env.NODE_ENV || 'production';
process.env.DATABASE_URL  = 'postgres://postgres@127.0.0.1:5433/identity_atlas';

process.env.WORKER_KEY_FILE = join(DATA_DIR, '.builtin-worker-key');
process.env.MASTER_KEY_FILE = join(DATA_DIR, '.master-key');
process.env.UPLOAD_ROOT     = join(DATA_DIR, 'uploads');
process.env.TRACE_DIR       = join(DATA_DIR, 'jobs');

if (process.pkg) {
  process.env.FRONTEND_DIST          = FRONTEND_DIST_IN_PKG;
  process.env.EMBEDDED_PG_NATIVE_DIR = PG_NATIVE_DIR;
}

// ─── Script/binary extraction ─────────────────────────────────────────────────

function extractDir(srcDir, destDir) {
  mkdirSync(destDir, { recursive: true });
  let entries;
  try {
    entries = readdirSync(srcDir, { withFileTypes: true });
  } catch {
    return;
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

// Extract the Express bundle + its runtime assets to the real filesystem so the
// ESM loader can find them.  The bundle's import.meta.url will be APP_DIR/app-bundle.mjs,
// so co-located files must match what the source expected relative to itself:
//   migrate.js: join(__dirname, 'migrations')  → APP_DIR/migrations/
//   index.js:   join(__dirname, 'openapi.yaml') → APP_DIR/openapi.yaml
function extractApp() {
  if (!process.pkg) return;
  mkdirSync(APP_DIR, { recursive: true });

  // app-bundle.mjs — the whole Express app as a single ESM file.
  const bundleSrc  = join(API_SRC, 'app-bundle.mjs');
  const bundleDest = join(APP_DIR, 'app-bundle.mjs');
  try {
    const srcMtime  = statSync(bundleSrc).mtimeMs;
    const destMtime = existsSync(bundleDest) ? statSync(bundleDest).mtimeMs : 0;
    if (srcMtime > destMtime) copyFileSync(bundleSrc, bundleDest);
  } catch { /* non-fatal */ }

  // migrations/*.sql — loaded by migrate.js relative to the bundle file.
  extractDir(join(API_SRC, 'db', 'migrations'), join(APP_DIR, 'migrations'));

  // openapi.yaml — loaded by index.js relative to the bundle file.
  const openapiSrc  = join(API_SRC, 'openapi.yaml');
  const openapiDest = join(APP_DIR, 'openapi.yaml');
  try {
    const srcMtime  = statSync(openapiSrc).mtimeMs;
    const destMtime = existsSync(openapiDest) ? statSync(openapiDest).mtimeMs : 0;
    if (srcMtime > destMtime) copyFileSync(openapiSrc, openapiDest);
  } catch { /* non-fatal */ }
}

function extractScripts() {
  if (!process.pkg) {
    // In dev mode __dirname is app/desktop/ — repo root is two levels up.
    process.env.IA_APP_ROOT = join(__dirname, '../..');
    return;
  }
  const pkgRoot = join(API_ROOT, 'bundled-scripts');
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

// Module-level reference so the catch handler can stop PG on crash.
let pg = null;

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(join(DATA_DIR, 'uploads'), { recursive: true });
  mkdirSync(join(DATA_DIR, 'jobs'),    { recursive: true });

  extractScripts();

  if (process.pkg) {
    const pgBinSrc = join(API_ROOT, 'node_modules/@embedded-postgres/windows-x64/native');
    extractDir(pgBinSrc, PG_NATIVE_DIR);
  }

  console.log('Identity Atlas Desktop — starting PostgreSQL...');
  console.log(`  Data directory: ${DATA_DIR}`);

  // embedded-postgres is ESM-only but is pre-bundled to CJS by esbuild so we
  // can require() it — pkg's patched CJS resolver reads it from the snapshot.
  const epModule = require('../api/src/embedded-postgres-bundle.cjs');
  const EmbeddedPostgres = epModule.default ?? epModule.EmbeddedPostgres;
  pg = new EmbeddedPostgres({
    port:         5433,
    persistent:   true,
    databaseDir:  join(DATA_DIR, 'pgdata'),
    authMethod:   'trust',
    initdbFlags:  ['--encoding=UTF8', '--locale=C'],
  });

  if (!existsSync(join(DATA_DIR, 'pgdata', 'PG_VERSION'))) {
    await pg.initialise();
  }

  // Stop any leftover process from a previous crash.
  await pg.stop().catch(() => {});
  // pg_ctl stop signals postgres to shut down but returns before Windows fully
  // releases the named shared memory object.  For a single-user desktop exe we
  // own the only PG instance, so it is safe to kill ALL postgres.exe processes
  // and then wait until tasklist confirms they are gone before starting.
  if (process.platform === 'win32') {
    await new Promise(r => exec('taskkill /F /IM postgres.exe /T 2>nul', r));
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const still = await new Promise(r =>
        exec('tasklist /FI "IMAGENAME eq postgres.exe" /NH 2>nul', (_, out) =>
          r(out && out.includes('postgres.exe'))
        )
      );
      if (!still) break;
      await new Promise(r => setTimeout(r, 300));
    }
  }
  await pg.start();

  try {
    await pg.createDatabase('identity_atlas');
  } catch {
    // Already exists on subsequent launches — ignore.
  }

  console.log('PostgreSQL started. Loading API...');

  if (process.pkg) {
    // Extract the bundle + co-located assets to the real filesystem so Node's
    // ESM loader (which uses native C++ fs, not pkg's patched fs) can read it.
    extractApp();
    await import(pathToFileURL(join(APP_DIR, 'app-bundle.mjs')).href);
  } else {
    await import('../api/src/index.js');
  }

  await waitForHealth('http://localhost:3001/api/health', 60_000);
  console.log('Identity Atlas ready at http://localhost:3001');

  const openCmd = process.platform === 'win32' ? 'start' : 'xdg-open';
  exec(`${openCmd} http://localhost:3001`);

  startWorker();

  const stop = async (signal) => {
    console.log(`\n${signal} — shutting down...`);
    try { await pg.stop(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT',  () => stop('SIGINT'));
}

main().catch(err => {
  if (err?.message) {
    console.error('Fatal error:', err.message);
    if (err.stack) console.error(err.stack);
  } else if (err) {
    console.error('Fatal error:', String(err));
  } else {
    console.error('Fatal error: process exited with no error details');
  }
  process.exit(1);
});
