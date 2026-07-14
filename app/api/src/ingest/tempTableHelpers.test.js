// Unit tests for ingest/tempTableHelpers.js — the temp-table DDL/DML builders.
// These assert the generated SQL + params (chunking, USER-DEFINED→text mapping,
// uuid-default application). The SQL is also exercised end-to-end against real
// postgres in contract-tests/tempTableHelpers.contract.test.js. (#666: 0 floor.)

import { describe, it, expect, vi } from 'vitest';
import { createTempTable, bulkInsertIntoTemp } from './tempTableHelpers.js';

const COLUMNS = [
  { name: 'id',    sqlTypeName: 'uuid',         hasUuidDefault: true },
  { name: 'label', sqlTypeName: 'text' },
  { name: 'kind',  sqlTypeName: 'USER-DEFINED' }, // → text
  { name: 'num',   sqlTypeName: 'integer' },
];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('createTempTable', () => {
  it('builds a CREATE TEMP TABLE with quoted cols, USER-DEFINED mapped to text, ON COMMIT DROP', async () => {
    const query = vi.fn().mockResolvedValue({});
    await createTempTable({ query }, 'tmp_x', COLUMNS);
    expect(query).toHaveBeenCalledTimes(1);
    const sql = query.mock.calls[0][0];
    expect(sql).toContain('CREATE TEMP TABLE "tmp_x"');
    expect(sql).toContain('"id" uuid');
    expect(sql).toContain('"kind" text'); // USER-DEFINED → text
    expect(sql).toContain('"num" integer');
    expect(sql).toContain('ON COMMIT DROP');
  });
});

describe('bulkInsertIntoTemp', () => {
  it('chunks rows, quotes the column list, and numbers placeholders per chunk', async () => {
    const query = vi.fn().mockResolvedValue({});
    const records = [
      { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', label: 'a', kind: 'x', num: 1 },
      { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', label: 'b', kind: 'y', num: 2 },
      { id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', label: 'c', kind: 'z', num: 3 },
    ];
    await bulkInsertIntoTemp({ query }, 'tmp_x', COLUMNS, records, 2, false);
    // 3 records, chunkSize 2 → 2 INSERT statements.
    expect(query).toHaveBeenCalledTimes(2);
    const [sql1, params1] = query.mock.calls[0];
    expect(sql1).toContain('INSERT INTO "tmp_x" ("id", "label", "kind", "num") VALUES');
    expect(sql1).toContain('($1,$2,$3,$4)');
    expect(sql1).toContain('($5,$6,$7,$8)'); // placeholders re-number within the chunk
    expect(params1).toHaveLength(8);
    expect(params1[0]).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    const [, params2] = query.mock.calls[1];
    expect(params2).toHaveLength(4); // the trailing chunk of 1 row
  });

  it('applies a uuid default only to null hasUuidDefault columns when enabled', async () => {
    const query = vi.fn().mockResolvedValue({});
    await bulkInsertIntoTemp({ query }, 'tmp_x', COLUMNS, [{ label: 'n', kind: 'k' }], 1000, true);
    const params = query.mock.calls[0][1]; // [id, label, kind, num]
    expect(params[0]).toMatch(UUID_RE); // null id → uuid default
    expect(params[1]).toBe('n');
    expect(params[3]).toBeNull();        // undefined num → null (no default)
  });

  it('leaves null values as null when applyUuidDefaults is false', async () => {
    const query = vi.fn().mockResolvedValue({});
    await bulkInsertIntoTemp({ query }, 'tmp_x', COLUMNS, [{ id: null, label: 'n', kind: 'k', num: 9 }], 1000, false);
    const params = query.mock.calls[0][1];
    expect(params[0]).toBeNull();
    expect(params[3]).toBe(9);
  });
});
