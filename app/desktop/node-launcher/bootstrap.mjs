// Bootstrap for the Identity Atlas portable node launcher.
// Sets up PGlite, wires it into globalThis, loads the API bundle, then
// starts the desktop worker (crawler job dispatcher).

import { createRequire } from 'module';
import { join, dirname }  from 'path';
import { homedir }        from 'os';
import { mkdirSync }      from 'fs';
import { pathToFileURL }  from 'url';
import { fileURLToPath }  from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const require    = createRequire(import.meta.url);

// ── Data directory ────────────────────────────────────────────────────────────
const DATA_DIR  = join(homedir(), 'AppData', 'Roaming', 'IdentityAtlas');
const PG_DIR    = join(DATA_DIR, 'pgdata');
mkdirSync(PG_DIR, { recursive: true });

// ── Env vars (read by connection.js, routes, worker) ─────────────────────────
process.env.DESKTOP_MODE    = 'true';
process.env.USE_SQL         = 'true';
process.env.DATA_DIR        = DATA_DIR;
process.env.FRONTEND_DIST   = join(__dirname, 'dist-frontend');
process.env.IA_APP_ROOT     = join(__dirname, 'bundled-scripts');
process.env.PORT            = process.env.PORT || '3001';

// ── PGlite initialisation ─────────────────────────────────────────────────────
const { PGlite }  = await import('@electric-sql/pglite');
const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');

const pgInstance = new PGlite(PG_DIR, { extensions: { pg_trgm } });
await pgInstance.waitReady;
globalThis.__pgliteInstance = pgInstance;

console.log('PGlite ready at', PG_DIR);

// ── Load API bundle (registers Express app + migrations) ─────────────────────
await import(pathToFileURL(join(__dirname, 'app-bundle.mjs')).href);

// ── Start desktop worker (crawler job dispatcher) ─────────────────────────────
const { startWorker } = require('./desktop-worker.cjs');
startWorker();
