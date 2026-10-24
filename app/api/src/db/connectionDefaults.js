// Session settings applied to every pooled Postgres connection (db/connection.js).
// Kept in its own module so db/connection.js keeps the exact export surface its
// manual mock pins (db/connectionMock.test.js).

// A pooled connection left idle INSIDE an open transaction holds its locks and its
// pool slot until something notices. Postgres closes such a connection after this
// long (SEC-2026-09 M-07). Ingest sessions, which are idle in their transaction
// between batches by design, raise it for their own transaction (ingest/sessions.js).
//
// There is deliberately no pool-wide statement_timeout: matview refreshes, the
// full-sync reconcile of a large tenant and migration index builds legitimately
// run for many minutes (one index build took ~11), and a cap low enough to matter
// against abuse would kill those. Override with PG_IDLE_IN_TRANSACTION_TIMEOUT_MS
// (0 disables).
const DEFAULT_IDLE_IN_TX_TIMEOUT_MS = 10 * 60 * 1000;

export function idleInTransactionTimeoutMs(env = process.env) {
  const raw = String(env.PG_IDLE_IN_TRANSACTION_TIMEOUT_MS ?? '').trim();
  if (!raw) return DEFAULT_IDLE_IN_TX_TIMEOUT_MS;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_IDLE_IN_TX_TIMEOUT_MS;
}

// Applied to every new physical connection. A SET rather than a startup option so
// it also works through a connection pooler that rejects startup parameters; a
// failure is logged and the connection is still used.
export function applyConnectionDefaults(client, timeoutMs = idleInTransactionTimeoutMs()) {
  return client.query(`SET idle_in_transaction_session_timeout = ${Number(timeoutMs)}`)
    .catch(err => console.warn('Could not set idle_in_transaction_session_timeout:', err.message));
}

