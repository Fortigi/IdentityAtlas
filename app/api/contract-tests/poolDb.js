// The connection.js surface (query / queryOne / tx) over a contract test's own
// pg pool. The pool is created in beforeAll, so it is read through a getter.

export function poolDb(getPool) {
  return {
    query: (sql, params) => getPool().query(sql, params),
    queryOne: async (sql, params) => (await getPool().query(sql, params)).rows[0] ?? null,
    tx: async (fn) => {
      const client = await getPool().connect();
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
