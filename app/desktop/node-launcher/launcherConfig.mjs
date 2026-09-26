// Pure helpers for the portable launcher's bootstrap.mjs.
//
// Kept apart from bootstrap.mjs because importing that file boots the whole app;
// everything here is side-effect free on import, so it can be unit tested
// (app/desktop/launcherConfig.test.js). Start-IdentityAtlas.ps1 also runs this
// file directly with --print-data-dir, so the launcher and the Node process
// resolve the data directory with one piece of code rather than two copies that
// could drift apart.

import { join, resolve } from 'path';
import { existsSync, appendFileSync } from 'fs';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

// Where the database and keys live.
//
//   1. IA_DATA_DIR, when set — an explicit choice always wins, and is the escape
//      hatch when the default lands somewhere slow.
//   2. The existing Roaming folder, when it already holds data — an installed
//      copy must never lose sight of its database because the default moved.
//   3. LOCALAPPDATA for a fresh install.
//
// Roaming is the wrong home for a database on a managed Windows machine, which
// is only obvious once you hit it: enterprises redirect or sync AppData\Roaming
// (roaming profiles, folder redirection to a file server, OneDrive Known Folder
// Move), so every page PGlite writes can be travelling over the network and
// being scanned on the way. LOCALAPPDATA is explicitly excluded from all of
// that, which is exactly what a local database wants.
export function resolveDataDir(env = process.env, { home = homedir(), exists = existsSync } = {}) {
  if (env.IA_DATA_DIR) return env.IA_DATA_DIR;
  const roaming = join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'IdentityAtlas');
  if (exists(join(roaming, 'pgdata'))) return roaming;          // an existing install stays put
  const local = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  return join(local, 'IdentityAtlas');
}

// PGlite or a real PostgreSQL?
//
// PGlite is the zero-setup default and it has a hard ceiling: it is PostgreSQL
// compiled to 32-bit WebAssembly running INSIDE this process, so it can address
// at most 4 GB however much memory the machine has, its buffer pool is fixed at
// 128 MB (ALTER SYSTEM is accepted and ignored), and it is single-threaded, so
// every query on a page queues behind the last.
//
// DATABASE_URL or POSTGRES_HOST selects a real server instead. The launcher sets
// POSTGRES_* itself when it starts the bundled PostgreSQL. The label is what gets
// logged, so it never includes DATABASE_URL, which carries the password.
export function selectDatabase(env = process.env) {
  if (env.DATABASE_URL) return { external: true, label: 'external PostgreSQL (DATABASE_URL)' };
  if (env.POSTGRES_HOST) {
    const port = env.POSTGRES_PORT ? ':' + env.POSTGRES_PORT : '';
    return { external: true, label: `external PostgreSQL (${env.POSTGRES_HOST}${port})` };
  }
  return { external: false, label: 'built-in PGlite' };
}

// The environment the API bundle reads at import time.
//
// HOST is pinned to loopback in BOTH modes. index.js binds to 127.0.0.1 only
// when DESKTOP_MODE is set and to HOST (default 0.0.0.0) otherwise, and
// DESKTOP_MODE has to be off against a real server: it also makes connection.js
// route every query to PGlite, migrate.js strip CREATE EXTENSION, and
// matrixViews.js give up CONCURRENTLY refreshes. Without the pin, switching to a
// real PostgreSQL would quietly expose an unauthenticated API to the network.
export function apiEnv({ env = process.env, dataDir, appDir, port, external }) {
  const out = {
    USE_SQL:               'true',
    PORT:                  String(port),
    HOST:                  '127.0.0.1',
    NODE_ENV:              env.NODE_ENV || 'production',
    WORKER_KEY_FILE:       join(dataDir, '.builtin-worker-key'),
    MASTER_KEY_FILE:       join(dataDir, '.master-key'),
    UPLOAD_ROOT:           join(dataDir, 'uploads'),
    TRACE_DIR:             join(dataDir, 'jobs'),
    FRONTEND_DIST:         join(appDir, 'dist-frontend'),
    IA_APP_ROOT:           join(appDir, 'bundled-scripts'),
    CRAWLER_MANIFESTS_DIR: join(appDir, 'bundled-scripts', 'tools', 'crawlers'),
  };
  if (!external) out.DESKTOP_MODE = 'true';
  return out;
}

export const CRASH_LOG_NAME = 'startup-error.log';

// One entry in the crash log: enough for a user to mail it and for us to read it
// without the console that has usually closed by then. Secrets stay out: only
// the error, the database label (see selectDatabase) and the runtime.
export function formatCrashReport(kind, err, { now = new Date(), database = '', nodeVersion = process.version } = {}) {
  const detail = err instanceof Error ? (err.stack || err.message) : String(err);
  return [
    `=== ${now.toISOString()} ${kind} ===`,
    `node ${nodeVersion}${database ? ', database: ' + database : ''}`,
    detail,
    '',
  ].join('\n');
}

// A failed start used to leave no trace: the console window closes with the
// process and the stack trace goes with it. Append every uncaught error to a file
// in the data directory, then exit non-zero so the launcher reports the code.
export function installCrashLog(proc, dataDir, { database = '', append = appendFileSync, log = console.error } = {}) {
  const file = join(dataDir, CRASH_LOG_NAME);
  const handler = (kind) => (err) => {
    try {
      append(file, formatCrashReport(kind, err, { database, nodeVersion: proc.version }));
      log(`Identity Atlas stopped on an unexpected error. Details were written to ${file}`);
    } catch { /* the data directory itself may be the problem — still exit */ }
    log(err);
    proc.exit(1);
  };
  proc.on('uncaughtException', handler('uncaughtException'));
  proc.on('unhandledRejection', handler('unhandledRejection'));
  return file;
}

// `node launcherConfig.mjs --print-data-dir` — used by Start-IdentityAtlas.ps1.
export function runCli(argv, env, write) {
  if (!argv.includes('--print-data-dir')) return 2;
  write(resolveDataDir(env) + '\n');
  return 0;
}

/* c8 ignore next 3 -- entry-point guard; runCli itself is tested */
if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === resolve(process.argv[1]).toLowerCase()) {
  process.exitCode = runCli(process.argv.slice(2), process.env, s => process.stdout.write(s));
}
