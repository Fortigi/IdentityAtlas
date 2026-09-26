// Node.js entry point for the portable launcher (no Electron).
// Initialises the database (PGlite, or a real PostgreSQL the launcher started),
// then loads the Express app bundle.
// Run via:  node.exe bootstrap.mjs

import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { mkdirSync, readFileSync } from 'fs';
import { createRequire } from 'module';
import { resolveDataDir, selectDatabase, apiEnv, installCrashLog } from './launcherConfig.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const require    = createRequire(import.meta.url);

// See launcherConfig.mjs for how each of these is chosen.
const DATA_DIR = resolveDataDir();
const PORT     = process.env.PORT || '3001';
const DATABASE = selectDatabase();

mkdirSync(DATA_DIR,                  { recursive: true });
mkdirSync(join(DATA_DIR, 'uploads'), { recursive: true });
mkdirSync(join(DATA_DIR, 'jobs'),    { recursive: true });

installCrashLog(process, DATA_DIR, { database: DATABASE.label });

Object.assign(process.env, apiEnv({ dataDir: DATA_DIR, appDir: __dirname, port: PORT, external: DATABASE.external }));

// Resolve module version from the bundled .psd1 manifest so the UI footer shows the correct version.
if (!process.env.MODULE_VERSION) {
  try {
    const psd1 = readFileSync(join(__dirname, 'bundled-scripts', 'setup', 'IdentityAtlas.psd1'), 'utf-8');
    const m = psd1.match(/ModuleVersion\s*=\s*'([^']+)'/);
    if (m) process.env.MODULE_VERSION = m[1];
  } catch { /* psd1 not present — version will show as blank */ }
}

console.log('Data directory: ' + DATA_DIR);

if (DATABASE.external) {
  console.log('Database: ' + DATABASE.label);
} else {
  const pgDataDir = join(DATA_DIR, 'pgdata');
  mkdirSync(pgDataDir, { recursive: true });
  console.log('Database: built-in PGlite at ' + pgDataDir);

  const { PGlite }  = await import('@electric-sql/pglite');
  const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
  const pgInstance  = new PGlite(pgDataDir, { extensions: { pg_trgm } });
  await pgInstance.waitReady;

  // Register pg_trgm in the SQL catalog so migrations can create gin_trgm_ops
  // indexes. PGlite loads the extension WASM code at constructor time but does
  // not run CREATE EXTENSION automatically — we do it here once, before
  // migrations run. The migration file also has CREATE EXTENSION IF NOT EXISTS
  // pg_trgm, but we strip that statement in DESKTOP_MODE (migrate.js) to avoid a
  // double-registration WASM abort.
  await pgInstance.exec('CREATE EXTENSION IF NOT EXISTS pg_trgm;');

  globalThis.__pgliteInstance = pgInstance;
}

await import(pathToFileURL(join(__dirname, 'app-bundle.mjs')).href);

// bootstrapWorker() writes the key inside app.listen()'s async callback, so it
// is not guaranteed to exist immediately after the import resolves. Poll until
// the file appears (up to 15 s) before starting the worker.
{
  let key = null;
  for (let i = 0; i < 30; i++) {
    try {
      const k = readFileSync(process.env.WORKER_KEY_FILE, 'utf8').trim();
      if (k) { key = k; break; }
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  if (key) process.env.WORKER_API_KEY = key;
}

const { startWorker } = require('./desktop-worker.cjs');
startWorker();
