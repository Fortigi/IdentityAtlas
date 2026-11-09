// The contract suite runs its files in parallel, one database clone per worker
// (test-utils/contractWorkerDb.js). These tests pin that mechanism: if a worker
// ever ended up on the shared template — or on another worker's clone — files
// would race on global constraints again, and fail only intermittently.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import {
  CONTRACT_WORKERS, workerDbName, workerDbUrl,
} from '../test-utils/contractWorkerDb.js';

const TEMPLATE = 'postgres://user:p%40ss@db.local:5433/test?sslmode=disable';

describe('workerDbUrl', () => {
  it('swaps only the database name, keeping credentials, host, port and query', () => {
    const u = new URL(workerDbUrl(TEMPLATE, '3'));
    expect(u.pathname).toBe('/contract_w3');
    expect(u.username).toBe('user');
    expect(u.password).toBe('p%40ss');
    expect(u.host).toBe('db.local:5433');
    expect(u.search).toBe('?sslmode=disable');
  });

  it('accepts every pool slot Vitest can hand out, 1..CONTRACT_WORKERS', () => {
    expect(workerDbUrl(TEMPLATE, 1)).toContain('/contract_w1?');
    expect(workerDbUrl(TEMPLATE, String(CONTRACT_WORKERS))).toContain(`/contract_w${CONTRACT_WORKERS}?`);
  });

  it.each([['0'], [String(CONTRACT_WORKERS + 1)], ['1.5'], ['abc'], [undefined]])(
    'refuses pool id %s — there is no clone for it', (id) => {
      expect(() => workerDbUrl(TEMPLATE, id)).toThrow(/has no contract database/);
    });
});

describe('this worker\'s database', () => {
  let pool;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  it('is this worker\'s own clone, not the shared template', async () => {
    const { rows } = await pool.query('SELECT current_database() AS db');
    expect(rows[0].db).toBe(workerDbName(Number(process.env.VITEST_POOL_ID)));
  });

  it('is fully migrated (the clone carries the template\'s schema)', async () => {
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM _migrations');
    expect(rows[0].n).toBeGreaterThan(80);
  });

  it('keeps the 10 s statement timeout, which CREATE DATABASE … TEMPLATE does not copy', async () => {
    const { rows } = await pool.query('SHOW statement_timeout');
    expect(rows[0].statement_timeout).toBe('10s');
  });
});
