// Postgres connection pool + query helpers.
//
// The surface is native postgres throughout:
//
//   • `db.query(text, params)` / `db.queryOne(text, params)` / `db.tx(fn)`
//   • `getPool()` → the raw pool (`.query(text, params)`, `.connect()`, `.on()`).
//
// Placeholders are positional `$N`; camelCase identifiers in SQL must be
// double-quoted. The `@name`-rewriting MSSQL compat shim
// (`getPool().request().input().query()` → `{ recordset }`) was removed in #663 —
// every caller is native pg. A static guard (db/nativePg.guard.test.js) fails the
// build if the shim or T-SQL parameter style is reintroduced.
//
// Desktop mode: when DESKTOP_MODE=true, all queries go through a PGlite
// instance (WebAssembly PostgreSQL) stored on globalThis.__pgliteInstance.
// The pg pool is never created. Docker/Azure are completely unaffected.

import pg from 'pg';

const { Pool } = pg;

const IS_DESKTOP = process.env.DESKTOP_MODE === 'true';

let pool   = null;
let pglite = null;

if (IS_DESKTOP) {
  pglite = globalThis.__pgliteInstance;
  if (!pglite) throw new Error('DESKTOP_MODE is set but globalThis.__pgliteInstance is not initialized');
}

// ─── PGlite helpers ──────────────────────────────────────────────

function normalizePGliteResult(r) {
  return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length, fields: r.fields || [] };
}

async function pgliteQuery(text, params = []) {
  if (!params || params.length === 0) {
    const results = await pglite.exec(text);
    const last = results[results.length - 1] ?? { rows: [], affectedRows: 0 };
    return normalizePGliteResult(last);
  }
  return normalizePGliteResult(await pglite.query(text, params));
}

// ─── pg pool helpers ─────────────────────────────────────────────

function buildConfig() {
  if (process.env.DATABASE_URL) {
    return {
      connectionString: process.env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    };
  }
  return {
    host:     process.env.POSTGRES_HOST     || 'postgres',
    port:     parseInt(process.env.POSTGRES_PORT || '5432', 10),
    database: process.env.POSTGRES_DB       || 'identity_atlas',
    user:     process.env.POSTGRES_USER     || 'identity_atlas',
    password: process.env.POSTGRES_PASSWORD || '',
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  };
}

function getPoolSync() {
  if (!pool) {
    pool = new Pool(buildConfig());
    pool.on('error', (err) => {
      console.error('Postgres pool error:', err.message);
      // Don't null the pool — pg auto-reconnects on next acquire
    });
  }
  return pool;
}

// ─── Public API ──────────────────────────────────────────────────

// Returns the pg-native pool surface (`query`, `connect`, `on`). In desktop mode
// the same methods are backed by PGlite.
export async function getPool() {
  if (IS_DESKTOP) {
    return {
      query:   (text, params) => pgliteQuery(text, params),
      connect: () => {
        const client = {
          query:   (text, params = []) => pgliteQuery(text, params),
          release: () => {},
        };
        return Promise.resolve(client);
      },
      on: () => {},
    };
  }
  return {
    query:   (text, params) => getPoolSync().query(text, params),
    connect: () => getPoolSync().connect(),
    on:      (event, fn) => getPoolSync().on(event, fn),
  };
}

export async function closePool() {
  if (pool) {
    try { await pool.end(); }
    catch (err) { console.error('Error closing pool:', err.message); }
    pool = null;
  }
}

// Native pg helpers for new code.
export async function query(text, params = []) {
  if (IS_DESKTOP) return pgliteQuery(text, params);
  return getPoolSync().query(text, params);
}

export async function queryOne(text, params = []) {
  const r = await query(text, params);
  return r.rows[0] ?? null;
}

export async function tx(fn) {
  if (IS_DESKTOP) {
    return pglite.transaction(async (txClient) => {
      const client = {
        // Use exec() for multi-statement SQL (e.g. migration files) — PGlite's
        // query() only handles a single prepared statement. exec() returns an
        // array of Results; we return the last one to match pg client shape.
        query: async (text, params = []) => {
          if (!params || params.length === 0) {
            const results = await txClient.exec(text);
            const last = results[results.length - 1] ?? { rows: [], affectedRows: 0 };
            return normalizePGliteResult(last);
          }
          return txClient.query(text, params).then(normalizePGliteResult);
        },
      };
      return fn(client);
    });
  }
  const p = getPoolSync();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* swallow */ }
    throw err;
  } finally {
    client.release();
  }
}

export default { getPool, closePool, query, queryOne, tx };
