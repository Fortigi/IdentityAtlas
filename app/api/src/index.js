// Process entry point. Builds the Express app (see app.js) and owns all the
// startup side-effects that must NOT run on a bare `import` (so tests can
// import createApp without binding a port or hitting the DB):
//   - performance collector enable
//   - production auth warning
//   - initial auth-config load
//   - app.listen + worker bootstrap
//   - graceful shutdown

import { createApp } from './app.js';
import { enable as enablePerf, isEnabled as isPerfEnabled } from './perf/collector.js';
import { loadAuthConfig, isAuthEnabled } from './config/authConfig.js';
import { bootstrapWorker, migrateDatabase } from './bootstrap.js';

const port       = process.env.PORT || 3001;
// Desktop mode binds to 127.0.0.1 only — the portable is a local app and should
// not be reachable from other machines on the network (H-03 / portable variant).
const host       = process.env.DESKTOP_MODE === 'true' ? '127.0.0.1' : (process.env.HOST || '0.0.0.0');
const isProduction = process.env.NODE_ENV === 'production';
const isDesktop    = process.env.DESKTOP_MODE === 'true';
// Snapshot of AUTH_ENABLED at boot — used only for the production warning below.
// The live value is read via isAuthEnabled() (DB-backed, hot-reloadable).
const authEnabledAtBoot = process.env.AUTH_ENABLED === 'true';
// Performance monitoring is ON by default — opt-out by setting PERF_METRICS_ENABLED=false.
// The runtime toggle in the Performance page still works to enable/disable per session.
const perfEnabled = process.env.PERF_METRICS_ENABLED !== 'false';

// ─── Performance metrics (opt-out via PERF_METRICS_ENABLED=false) ─
if (perfEnabled) {
  enablePerf();
}

// ─── Startup env validation ──────────────────────────────────────
if (isProduction && !authEnabledAtBoot) {
  console.warn('WARNING: AUTH_ENABLED is not set to "true" in production. All API endpoints are unauthenticated until configured via Admin → Authentication.');
}
if (isDesktop && !authEnabledAtBoot) {
  console.warn('WARNING: Identity Atlas is running in portable mode with authentication disabled. The API is accessible to any process on this machine. Enable authentication via Admin → Authentication if this machine is shared or connected to an untrusted network.');
}
// Auth is on, but with no AUTH_REQUIRED_ROLES backstop any signed-in tenant user
// can still READ all data (roleless users are denied write/admin since C-01, but
// read endpoints aren't permission-gated). Nudge operators to lock sign-in down.
if (authEnabledAtBoot && !process.env.AUTH_REQUIRED_ROLES) {
  console.warn('WARNING: AUTH_ENABLED is true but AUTH_REQUIRED_ROLES is not set. Any authenticated tenant user can read data (they cannot perform admin/write actions without a mapped role). Assign Entra app roles and/or set AUTH_REQUIRED_ROLES to restrict who can sign in.');
}

// Load auth config from DB (with env var fallback). Best-effort — if the DB
// isn't reachable yet at startup we'll fall back to env vars and the admin
// page can flip things on later.
loadAuthConfig().catch(err => {
  console.warn('Initial auth config load failed:', err.message);
});

const app = createApp();

// Apply database migrations BEFORE binding the port (see migrateDatabase). The
// worker container starts polling for crawler jobs as soon as the web port is
// up, so the schema must be fully upgraded first — otherwise a crawler can run
// against a mid-migration schema and deadlock against the migration's locks.
// On failure, exit non-zero: Docker restarts the container and retries, and
// because the port never opened, no crawler ever ran against a broken schema.
try {
  await migrateDatabase();
} catch (err) {
  console.error('Database migration failed — refusing to start:', err.message);
  process.exit(1);
}

const server = app.listen(port, host, async () => {
  console.log(`Identity Atlas running on http://localhost:${port}`);
  console.log(`Mode: ${process.env.USE_SQL === 'true' ? 'SQL' : 'Mock data'}`);
  console.log(`Auth: ${isAuthEnabled() ? 'Entra ID' : 'Disabled'}`);
  console.log(`Perf: ${isPerfEnabled() ? 'Enabled (Server-Timing headers + /api/perf)' : 'Disabled'}`);

  // Auto-create built-in worker crawler + infrastructure tables
  await bootstrapWorker();
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nError: port ${port} is already in use.`);
    console.error(`Identity Atlas may already be running. Open http://localhost:${port} in your browser.`);
    process.exit(1);
  }
  throw err;
});

// Graceful shutdown: close SQL pool before exiting.
// Guard flag prevents re-entrant calls (multiple Ctrl+C presses each add a
// server 'close' listener, causing MaxListenersExceededWarning and the loop
// of repeated "SIGINT received" messages).
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down...`);
  server.close(async () => {
    if (process.env.USE_SQL === 'true') {
      const { closePool } = await import('./db/connection.js');
      await closePool();
    }
    process.exit(0);
  });
  // Force exit after 5 s — keep-alive browser connections would otherwise
  // prevent server.close() from firing indefinitely.
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
