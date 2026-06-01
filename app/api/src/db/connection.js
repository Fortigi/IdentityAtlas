// Postgres connection pool + query helpers.
//
// Two APIs are exposed:
//
//   1. Native postgres helpers — `db.query(text, params)`,
//      `db.queryOne(text, params)`, `db.tx(fn)`. Preferred for new code.
//
//   2. Request-style helper — `getPool().request().input(name, val).query(sqlText)`.
//      Converts `@name` placeholders to `$N`, runs the query via pg, and
//      returns results shaped as `{ recordset, recordsets, rowsAffected }`.
//      camelCase identifiers in SQL must be double-quoted.
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

// ─── Request-style helper ────────────────────────────────────────
// Returns an object supporting .input(name, value).query(sqlText).
// Converts `@name` placeholders to `$N` and runs through pg/PGlite, returning
// { recordset, recordsets, rowsAffected }.
function makeCompatRequest() {
  const inputs = new Map();
  const request = {
    input(name, value) {
      // Also accepts (name, type, value); the type arg is ignored — pg infers from JS values.
      // The "type" arg (if present) is ignored — pg infers from JS values.
      if (arguments.length === 3) {
        inputs.set(name, arguments[2]);
      } else {
        inputs.set(name, value);
      }
      return request;
    },
    output() { return request; }, // no-op — output params not used
    parameters: { _params: inputs },
    timeout: 0,
    async query(sqlText) {
      // Convert @name → $1, $2, ... preserving order. Repeated @names share
      // the same $N. Quoted strings ('foo @bar') are NOT placeholders — skip them.
      const paramOrder = [];
      const pgSql = replaceAtParams(sqlText, (name) => {
        let idx = paramOrder.indexOf(name);
        if (idx === -1) {
          paramOrder.push(name);
          idx = paramOrder.length - 1;
        }
        return '$' + (idx + 1);
      });
      const params = paramOrder.map(p => inputs.get(p));

      // Detect multi-statement queries (some routes return two recordsets —
      // typically a SELECT for data and a SELECT for the COUNT).
      const statements = splitSqlStatements(pgSql);

      if (IS_DESKTOP) {
        if (statements.length <= 1) {
          const result = await pgliteQuery(pgSql, params);
          return {
            recordset:    result.rows,
            recordsets:   [result.rows],
            rowsAffected: [result.rowCount],
            output:       {},
          };
        }
        // Multi-statement: run sequentially on PGlite (serialized, no connection needed).
        const origStatements = splitSqlStatements(sqlText);
        const results = [];
        for (const origStmt of origStatements) {
          const stmtOrder = [];
          const stmtSql = replaceAtParams(origStmt, (name) => {
            let idx = stmtOrder.indexOf(name);
            if (idx === -1) { stmtOrder.push(name); idx = stmtOrder.length - 1; }
            return '$' + (idx + 1);
          });
          const stmtParams = stmtOrder.map(p => inputs.get(p));
          results.push(await pgliteQuery(stmtSql, stmtParams));
        }
        return {
          recordset:    results[results.length - 1]?.rows || [],
          recordsets:   results.map(r => r.rows),
          rowsAffected: results.map(r => r.rowCount),
          output:       {},
        };
      }

      // pg path — multi-statement: run them sequentially on a checked-out client
      // so they share state. Each statement may reference a different SUBSET of
      // the global @name parameters (e.g. data query uses @limit, @offset, @search;
      // count query only uses @search). We re-renumber placeholders per-statement
      // and pass only the values that statement actually uses, otherwise pg's
      // prepared-statement protocol complains about extra parameters.
      //
      // The safe approach: re-process each statement from the ORIGINAL @name
      // SQL (not the post-renumbered one) so we can rebuild a per-statement
      // params list. We re-split the original sqlText into statements.
      const p = getPoolSync();
      if (statements.length <= 1) {
        const result = await p.query(pgSql, params);
        return {
          recordset:    result.rows || [],
          recordsets:   [result.rows || []],
          rowsAffected: [result.rowCount || 0],
          output:       {},
        };
      }

      const origStatements = splitSqlStatements(sqlText);
      const client = await p.connect();
      const results = [];
      try {
        for (const origStmt of origStatements) {
          const stmtOrder = [];
          const stmtSql = replaceAtParams(origStmt, (name) => {
            let idx = stmtOrder.indexOf(name);
            if (idx === -1) {
              stmtOrder.push(name);
              idx = stmtOrder.length - 1;
            }
            return '$' + (idx + 1);
          });
          const stmtParams = stmtOrder.map(p => inputs.get(p));
          const r = await client.query(stmtSql, stmtParams);
          results.push(r);
        }
      } finally {
        client.release();
      }
      return {
        recordset:    results[results.length - 1]?.rows || [],
        recordsets:   results.map(r => r.rows || []),
        rowsAffected: results.map(r => r.rowCount || 0),
        output:       {},
      };
    },
  };
  return request;
}

// Split a SQL string into individual statements at semicolons. Skips
// semicolons inside string literals. Empty statements are dropped.
function splitSqlStatements(sql) {
  const out = [];
  let buf = '';
  let i = 0;
  let inString = false;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'" && sql[i - 1] !== '\\') {
      inString = !inString;
      buf += ch;
      i++;
      continue;
    }
    if (!inString && ch === ';') {
      const trimmed = buf.trim();
      if (trimmed) out.push(trimmed);
      buf = '';
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  const trimmed = buf.trim();
  if (trimmed) out.push(trimmed);
  return out;
}

// Walk the SQL string and replace @name with the result of cb(name).
// Skips occurrences inside single-quoted strings (so '@email' stays literal).
function replaceAtParams(sql, cb) {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'" && sql[i - 1] !== '\\') {
      inString = !inString;
      out += ch;
      i++;
      continue;
    }
    if (!inString && ch === '@' && /[A-Za-z_]/.test(sql[i + 1] || '')) {
      let j = i + 1;
      while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j])) j++;
      const name = sql.slice(i + 1, j);
      out += cb(name);
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

// ─── Public API ──────────────────────────────────────────────────

// Returns an object with `.request()` for the request-style helper and
// pg-native pool methods (`query`, `connect`) passed through.
export async function getPool() {
  if (IS_DESKTOP) {
    return {
      request: makeCompatRequest,
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
    request: makeCompatRequest,
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
