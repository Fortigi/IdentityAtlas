// Postgres connection pool + query helpers + a thin mssql-compat shim.
//
// Two parallel APIs are exposed:
//
//   1. Native postgres helpers — `db.query(text, params)`,
//      `db.queryOne(text, params)`, `db.tx(fn)`. Use these in any new code.
//
//   2. mssql-compat shim — `getPool().request().input(name, val).query(sqlText)`.
//      Used by the v4 route files that haven't been rewritten yet. The shim
//      converts `@name` placeholders to `$N`, runs the query via pg, and
//      mimics the mssql result shape (`recordset`, `recordsets`, `rowsAffected`).
//      It does NOT translate the SQL itself — that has to be done in each
//      route file (camelCase identifiers must be double-quoted, ValidTo
//      filters removed, GETDATE() → now(), etc.). The shim only provides
//      the surface compatibility that makes the rewriting tractable.
//
// Why both? The migration plan said "no abstraction layer". In practice,
// translating 8000+ lines of route code in one session is too risky; the shim
// lets us migrate route by route while keeping a working stack the entire time.
// Any new code should prefer the native helpers.

import pg from 'pg';

const { Pool } = pg;

let pool = null;

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

// ─── mssql-compat shim ───────────────────────────────────────────
// Returns an object with .request() that produces a Request-shaped helper
// supporting .input(name, value).query(sqlText). The query method converts
// `@name` placeholders to `$N` and runs through pg, returning a result
// shaped like an mssql result so existing route code works unchanged.
function makeCompatRequest() {
  const inputs = new Map();
  const request = {
    input(name, value) {
      // mssql also accepts (name, type, value); we accept both shapes.
      // The "type" arg (if present) is ignored — pg infers from JS values.
      if (arguments.length === 3) {
        inputs.set(name, arguments[2]);
      } else {
        inputs.set(name, value);
      }
      return request;
    },
    output() { return request; }, // mssql output params — no-op
    parameters: { _params: inputs },
    timeout: 0,
    async query(sqlText) {
      // Convert @name → $1, $2, ... preserving order. Repeated @names share
      // the same $N. Quoted strings ('foo @bar') are NOT placeholders — skip them.
      const paramOrder = [];
      const pgSql = replaceMssqlParams(sqlText, (name) => {
        let idx = paramOrder.indexOf(name);
        if (idx === -1) {
          paramOrder.push(name);
          idx = paramOrder.length - 1;
        }
        return '$' + (idx + 1);
      });
      const params = paramOrder.map(p => inputs.get(p));

      // Detect multi-statement queries (the v4 mssql code occasionally returns
      // two recordsets — typically a SELECT for data and a SELECT for the COUNT).
      // pg's prepared-statement protocol can't handle multiple statements in one
      // query, so we split on `;` and run each statement separately, returning
      // both results in a recordsets array.
      const statements = splitSqlStatements(pgSql);

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

      // Multiple statements: run them sequentially on a checked-out client
      // so they share state. Each statement may reference a different SUBSET of
      // the global @name parameters (e.g. data query uses @limit, @offset, @search;
      // count query only uses @search). We re-renumber placeholders per-statement
      // and pass only the values that statement actually uses, otherwise pg's
      // prepared-statement protocol complains about extra parameters.
      //
      // The safe approach: re-process each statement from the ORIGINAL @name
      // SQL (not the post-renumbered one) so we can rebuild a per-statement
      // params list. We re-split the original sqlText into statements.
      const origStatements = splitSqlStatements(sqlText);
      const client = await p.connect();
      const results = [];
      try {
        for (const origStmt of origStatements) {
          const stmtOrder = [];
          const stmtSql = replaceMssqlParams(origStmt, (name) => {
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
function replaceMssqlParams(sql, cb) {
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

// Async wrapper kept for parity with the old `getPool()` signature so route
// files that already use `await db.getPool()` continue to work without
// rewriting every call site. The returned object has .request() that yields
// the mssql-compat shim above.
export async function getPool() {
  // Return an object with a `.request()` method that produces the compat shim
  // (used by v4-style routes), AND with the pg-native pool methods passed
  // through (used by the ingest sessions code which needs `pool.connect()`).
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
  const p = getPoolSync();
  return p.query(text, params);
}

export async function queryOne(text, params = []) {
  const r = await query(text, params);
  return r.rows[0] ?? null;
}

export async function tx(fn) {
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
