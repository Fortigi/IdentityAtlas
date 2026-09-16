// Unit tests for the pure helpers extracted from endSession in sessions.js:
// buildUpsertSql (ON CONFLICT SQL construction) and countUpsertResult (insert/
// update tally from the RETURNING rows). These are SQL-string/pure-logic asserts;
// the full end-to-end upsert is exercised against real postgres elsewhere.

import { describe, it, expect } from 'vitest';
import { buildUpsertSql, countUpsertResult } from './sessions.js';

const sessionWith = (overrides = {}) => ({
  tableName: 'Principals',
  tempTable: '_tmp_session_abc',
  keyColumns: ['id'],
  activeColumns: [{ name: 'id' }, { name: 'displayName' }, { name: 'systemId' }],
  conflictFilter: null,
  ...overrides,
});

describe('buildUpsertSql', () => {
  it('builds a DO UPDATE upsert when there are non-key columns', () => {
    const sql = buildUpsertSql(sessionWith());
    expect(sql).toContain('INSERT INTO "Principals" ("id", "displayName", "systemId")');
    expect(sql).toContain('SELECT "id", "displayName", "systemId" FROM "_tmp_session_abc"');
    expect(sql).toContain('ON CONFLICT ("id") DO UPDATE SET');
    expect(sql).toContain('"displayName" = EXCLUDED."displayName"');
    expect(sql).toContain('"systemId" = EXCLUDED."systemId"');
    expect(sql).toContain('RETURNING (xmax = 0) AS "wasInsert"');
    // key column is never in the update set
    expect(sql).not.toContain('"id" = EXCLUDED."id"');
  });

  it('builds a DO NOTHING upsert when every column is a key column', () => {
    const sql = buildUpsertSql(sessionWith({
      keyColumns: ['id', 'systemId'],
      activeColumns: [{ name: 'id' }, { name: 'systemId' }],
    }));
    expect(sql).toContain('ON CONFLICT ("id", "systemId") DO NOTHING');
    expect(sql).not.toContain('DO UPDATE');
    expect(sql).toContain('RETURNING (xmax = 0) AS "wasInsert"');
  });

  it('appends the conflict filter as a WHERE clause when present', () => {
    const sql = buildUpsertSql(sessionWith({ conflictFilter: '"systemId" = 1' }));
    expect(sql).toContain('ON CONFLICT ("id") WHERE "systemId" = 1 DO UPDATE SET');
  });

  it('omits the WHERE clause when there is no conflict filter', () => {
    const sql = buildUpsertSql(sessionWith({ conflictFilter: null }));
    expect(sql).not.toContain('WHERE');
  });
});

describe('countUpsertResult', () => {
  it('counts inserts (xmax = 0) and updates separately', () => {
    const rows = [
      { wasInsert: true },
      { wasInsert: false },
      { wasInsert: true },
      { wasInsert: false },
      { wasInsert: false },
    ];
    expect(countUpsertResult(rows)).toEqual({ inserted: 2, updated: 3 });
  });

  it('returns zeros for an empty result set', () => {
    expect(countUpsertResult([])).toEqual({ inserted: 0, updated: 0 });
  });
});
