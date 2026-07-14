// Schema-readiness state for the resilient startup sequence.
//
// The web server now binds its port BEFORE database migrations run, so a slow
// migration can never leave the port closed and crash-loop the container into
// an Azure "Application Error" (migrations that exceeded App Service's 230s
// startup probe used to be killed mid-run, roll back, and re-run forever). The
// migration + worker bootstrap runs in the background after app.listen().
//
// To preserve the invariant that NO crawler ever runs against a mid-migration
// schema, the worker data-plane endpoints (job claim/complete + ingest) consult
// isSchemaReady() and return 503 until the schema is upgraded. See index.js
// (which drives the state) and app.js (which applies the gate).
//
// The gate is INERT until the real process entry point (index.js) arms it, so
// unit tests that build the app with createApp() are unaffected — they never
// arm it, so isSchemaReady() stays true and the worker endpoints behave as
// before.

let armed = false;         // index.js sets this at real startup; tests never do
let ready = false;         // flipped true once migrations complete
let lastError = null;      // message of the most recent migration failure
let failedAttempts = 0;    // how many migration attempts have thrown

// Arm the gate at the start of a real boot (SQL mode). Until markSchemaReady()
// runs, the worker data-plane is closed.
export function armStartupGate() {
  armed = true;
  ready = false;
  lastError = null;
}

// Migrations completed — open the worker data-plane.
export function markSchemaReady() {
  ready = true;
  lastError = null;
}

// Migrations threw — keep the gate closed and record why (for logs / health).
export function markSchemaFailed(err) {
  ready = false;
  lastError = err?.message ?? String(err);
  failedAttempts += 1;
}

// The gate consults this. True (open) unless the gate was armed and the schema
// isn't ready yet — so it is a no-op in tests and in non-SQL/mock mode.
export function isSchemaReady() {
  return !armed || ready;
}

export function getStartupStatus() {
  return { armed, schemaReady: ready, lastError, failedAttempts };
}

// Test-only: reset module state between cases.
export function _resetForTest() {
  armed = false;
  ready = false;
  lastError = null;
  failedAttempts = 0;
}
