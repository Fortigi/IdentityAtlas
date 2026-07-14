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
import { armStartupGate, markSchemaReady, markSchemaFailed } from './startupState.js';

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

// ─── Bind the port FIRST, migrate in the background ──────────────
// Migrations used to run to completion BEFORE app.listen(). That made a slow
// migration fatal on Azure App Service: the platform kills a container that
// doesn't answer on its port within a startup-probe window (230s by default),
// so a migration slower than that left the port closed, got killed mid-run,
// rolled back, and re-ran forever — a permanent "Application Error" crash loop.
//
// Now the port opens immediately (the probe passes) and migrations run after.
// The invariant that no crawler runs against a mid-migration schema is kept by
// arming a startup gate: the worker data-plane (job claim + ingest, wired in
// app.js) returns 503 until markSchemaReady() runs. On failure we do NOT exit
// (that recreates the crash loop); we log and retry with backoff, leaving the
// port open so operators can reach logs and the app self-heals once the DB
// issue clears.
if (process.env.USE_SQL === 'true') armStartupGate();

// Backoff schedule for migration retries; the last value repeats.
const MIGRATION_RETRY_MS = [5_000, 15_000, 30_000, 60_000];

async function startSchemaAndWorker(attempt = 0) {
  try {
    await migrateDatabase();
    markSchemaReady();
    console.log('Schema ready — worker (crawler) endpoints enabled');
    // Auto-create built-in worker crawler + infrastructure tables.
    await bootstrapWorker();
  } catch (err) {
    markSchemaFailed(err);
    const delay = MIGRATION_RETRY_MS[Math.min(attempt, MIGRATION_RETRY_MS.length - 1)];
    console.error(
      `CRITICAL: database migration failed (attempt ${attempt + 1}). ` +
      `Worker endpoints stay disabled; retrying in ${delay / 1000}s. Cause: ${err.message}`
    );
    setTimeout(() => startSchemaAndWorker(attempt + 1), delay).unref();
  }
}

const server = app.listen(port, host, () => {
  console.log(`Identity Atlas running on http://localhost:${port}`);
  console.log(`Mode: ${process.env.USE_SQL === 'true' ? 'SQL' : 'Mock data'}`);
  console.log(`Auth: ${isAuthEnabled() ? 'Entra ID' : 'Disabled'}`);
  console.log(`Perf: ${isPerfEnabled() ? 'Enabled (Server-Timing headers + /api/perf)' : 'Disabled'}`);

  // Run migrations + worker bootstrap WITHOUT blocking the now-open port.
  void startSchemaAndWorker();
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
