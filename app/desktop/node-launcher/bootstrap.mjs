// Node.js entry point for the portable launcher (no Electron).
// Initialises PGlite, then loads the Express app bundle.
// Run via:  node.exe bootstrap.mjs

import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { mkdirSync } from 'fs';
import { homedir } from 'os';
import { createRequire } from 'module';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const require    = createRequire(import.meta.url);

const DATA_DIR = join(homedir(), 'AppData', 'Roaming', 'IdentityAtlas');
const PORT     = process.env.PORT || '3001';

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
process.env.FRONTEND_DIST   = join(__dirname, 'dist-frontend');
process.env.IA_APP_ROOT     = join(__dirname, 'bundled-scripts');

const pgDataDir = join(DATA_DIR, 'pgdata');
mkdirSync(pgDataDir, { recursive: true });

const { PGlite }  = await import('@electric-sql/pglite');
const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
const pgInstance  = new PGlite(pgDataDir, { extensions: { pg_trgm } });
await pgInstance.waitReady;

// Register pg_trgm in the SQL catalog so migrations can create gin_trgm_ops indexes.
// PGlite loads the extension WASM code at constructor time but does not run
// CREATE EXTENSION automatically — we do it here once, before migrations run.
// The migration file also has CREATE EXTENSION IF NOT EXISTS pg_trgm, but we
// strip that statement in DESKTOP_MODE (migrate.js) to avoid a double-registration
// WASM abort.
await pgInstance.exec('CREATE EXTENSION IF NOT EXISTS pg_trgm;');

globalThis.__pgliteInstance = pgInstance;

await import(pathToFileURL(join(__dirname, 'app-bundle.mjs')).href);

const { startWorker } = require('./desktop-worker.cjs');
startWorker();
