// Contract test — ingest/tempTableHelpers.js against real PostgreSQL 16.
//
// createTempTable / bulkInsertIntoTemp build + populate ON COMMIT DROP temp
// tables used by the bulk-ingest path (engine.js, sessions.js). They emit real
// DDL/DML against a pg client, so a mock can't verify they actually work — this
// drives them against a real connection inside a transaction. (#666 — the file
// sat at a 0 coverage floor.)

import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'crypto';
import { createTempTable, bulkInsertIntoTemp } from '../src/ingest/tempTableHelpers.js';

let pool, client;

const COLUMNS = [
  { name: 'id',    sqlTypeName: 'uuid',         hasUuidDefault: true },
  { name: 'label', sqlTypeName: 'text' },
  { name: 'kind',  sqlTypeName: 'USER-DEFINED' }, // mapped to text
  { name: 'num',   sqlTypeName: 'integer' },
];

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });
});

afterEach(async () => {
  if (client) { await client.query('ROLLBACK').catch(() => {}); client.release(); client = null; }
});

afterAll(async () => { await pool.end(); });

describe('createTempTable + bulkInsertIntoTemp', () => {
  it('creates the temp table and chunk-inserts rows, applying uuid defaults', async () => {
    client = await pool.connect();
    await client.query('BEGIN'); // temp table is ON COMMIT DROP — keep the txn open
    await createTempTable(client, 'tmp_contract', COLUMNS);

    const explicitId = randomUUID();
    const records = [
      { id: explicitId, label: 'a', kind: 'x', num: 1 },
      { id: null,       label: 'b', kind: 'y', num: 2 }, // null id → gets a uuid default
      { label: 'c',     kind: 'z' },                     // undefined id/num → null → id defaulted
    ];
    // chunkSize 2 over 3 records exercises the multi-chunk loop (2 INSERT statements).
    await bulkInsertIntoTemp(client, 'tmp_contract', COLUMNS, records, 2, true);

    const { rows } = await client.query('SELECT * FROM "tmp_contract" ORDER BY "label"');
    expect(rows).toHaveLength(3);
    // Every id is populated (explicit kept; nulls/undefined got a uuid default).
    expect(rows.every(r => r.id != null)).toBe(true);
    expect(rows.find(r => r.label === 'a').id).toBe(explicitId);
    // USER-DEFINED column stored as text.
    expect(rows.find(r => r.label === 'x' || r.kind === 'x')).toBeDefined();
    expect(rows.find(r => r.label === 'a').kind).toBe('x');
    // undefined value → NULL.
    expect(rows.find(r => r.label === 'c').num).toBeNull();
  });

  it('leaves null ids as NULL when applyUuidDefaults is false', async () => {
    client = await pool.connect();
    await client.query('BEGIN');
    await createTempTable(client, 'tmp_contract2', COLUMNS);
    await bulkInsertIntoTemp(client, 'tmp_contract2', COLUMNS, [{ id: null, label: 'n', kind: 'k', num: 9 }], 1000, false);
    const { rows } = await client.query('SELECT * FROM "tmp_contract2"');
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBeNull();
    expect(rows[0].num).toBe(9);
  });
});
