// The db/connection.js surface (query, queryOne, tx, getPool) over a contract test's own
// pg pool, so a feature module that takes `db` runs against the real schema.
// Shared by the contract tests that call modules directly instead of routes.

export function poolDb(pool) {
  return {
    query: (sql, params) => pool.query(sql, params),
    getPool: async () => pool,
    queryOne: async (sql, params) => (await pool.query(sql, params)).rows[0] ?? null,
    tx: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(client);
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
  };
}
