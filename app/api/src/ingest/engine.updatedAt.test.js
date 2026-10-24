// "updatedAt means when this row was last ingested."
//
// The update set of an upsert is built from the PAYLOAD's columns, and no
// crawler sends `updatedAt`. So before this stamp, re-ingesting a row left the
// column at its first-insert value — invisible for most tables and wrong for
// `PrincipalActivity`, where `updatedAt` IS the measurement moment every
// activity report counts back from. A daily sync would have left every "measured
// on" pinned to the day the account was first seen, and every staleness window
// anchored to it.
//
// The real ingest() is driven here with only db/connection mocked, so the SQL
// asserted on is the SQL the engine actually emits.

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db/connection.js');
import { query } from '../db/connection.js';
import { ingest, updatedAtStamp } from './engine.js';

const PA_KEYS = ['principalId', 'resourceId', 'activityType'];
const PA_COLUMNS = [
  'principalId', 'resourceId', 'activityType', 'lastSignInDateTime',
  'signInCount', 'extendedAttributes', 'updatedAt',
];
const PA_RECORD = {
  principalId: 'p1', resourceId: '00000000-0000-0000-0000-000000000000',
  activityType: 'SignIn', lastSignInDateTime: '2026-09-01T00:00:00.000Z',
};

// Stage a table whose schema is `columns`, so the engine's own column discovery
// drives the generated SQL.
function stageTable(table, columns) {
  query.mockImplementation(async (sql) => {
    const s = String(sql);
    if (/information_schema\.columns/.test(s)) {
      return { rows: columns.map((column_name) => ({ column_name })), rowCount: columns.length };
    }
    if (new RegExp(`^\\s*INSERT INTO "${table}"`).test(s)) {
      return { rows: [{ wasInsert: false }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
}

const upsertSql = (table) =>
  query.mock.calls.map(c => String(c[0]))
    .find(s => new RegExp(`^\\s*INSERT INTO "${table}"`).test(s));

beforeEach(() => { query.mockReset(); });

describe('updatedAtStamp', () => {
  const col = name => ({ name });

  it('stamps when the table has the column and the payload does not', () => {
    expect(updatedAtStamp([col('id'), col('updatedAt')], [col('id')]))
      .toBe(', "updatedAt" = now()');
  });

  it('stays out of the way when the payload carries its own updatedAt', () => {
    // A source that reports its own modification time owns the value; the
    // engine must not overwrite it with the ingest moment.
    expect(updatedAtStamp([col('id'), col('updatedAt')], [col('id'), col('updatedAt')])).toBe('');
  });

  it('emits nothing for a table without the column', () => {
    expect(updatedAtStamp([col('id'), col('displayName')], [col('id')])).toBe('');
  });
});

describe('ingest() — the updatedAt stamp on a delta upsert', () => {
  it('advances updatedAt when the same activity record is ingested again', async () => {
    stageTable('PrincipalActivity', PA_COLUMNS);

    const res = await ingest(null, 'PrincipalActivity', PA_KEYS, [PA_RECORD], { syncMode: 'delta' });

    expect(res).toMatchObject({ updated: 1 });
    const sql = upsertSql('PrincipalActivity');
    expect(sql).toContain('DO UPDATE SET');
    expect(sql).toContain('"updatedAt" = now()');
  });

  it('keeps the COALESCE semantics of a delta upsert for the payload columns', async () => {
    // The stamp must be an ADDITION to the delta rules, not a replacement:
    // a partial delta record still must not null out what it omits.
    stageTable('PrincipalActivity', PA_COLUMNS);
    await ingest(null, 'PrincipalActivity', PA_KEYS, [PA_RECORD], { syncMode: 'delta' });

    const sql = upsertSql('PrincipalActivity');
    expect(sql).toContain('"lastSignInDateTime" = COALESCE(EXCLUDED."lastSignInDateTime"');
    expect(sql).toContain('"updatedAt" = now()');
  });

  it('stamps on a full sync too', async () => {
    stageTable('PrincipalActivity', PA_COLUMNS);
    await ingest(null, 'PrincipalActivity', PA_KEYS, [PA_RECORD], { syncMode: 'full' });
    expect(upsertSql('PrincipalActivity')).toContain('"updatedAt" = now()');
  });

  it('does not list updatedAt among the inserted columns — the default covers insert', async () => {
    stageTable('PrincipalActivity', PA_COLUMNS);
    await ingest(null, 'PrincipalActivity', PA_KEYS, [PA_RECORD], { syncMode: 'delta' });

    // An INSERT naming "updatedAt" would need a value per row; the column's
    // DEFAULT now() is what fills it, so the insert list must stay payload-only.
    const sql = upsertSql('PrincipalActivity');
    const insertList = /INSERT INTO "PrincipalActivity" \(([^)]*)\)/.exec(sql)[1];
    expect(insertList).not.toContain('updatedAt');
  });

  it('honours an updatedAt the payload DOES carry instead of overriding it', async () => {
    stageTable('PrincipalActivity', PA_COLUMNS);
    await ingest(null, 'PrincipalActivity', PA_KEYS,
      [{ ...PA_RECORD, updatedAt: '2026-01-01T00:00:00.000Z' }], { syncMode: 'full' });

    const sql = upsertSql('PrincipalActivity');
    expect(sql).toContain('"updatedAt" = EXCLUDED."updatedAt"');
    expect(sql).not.toContain('"updatedAt" = now()');
  });
});

describe('ingest() — blast radius of the stamp', () => {
  it('leaves a table without an updatedAt column alone', async () => {
    stageTable('Principals', ['id', 'displayName', 'systemId', 'deletedAt']);
    await ingest(null, 'Principals', ['id'], [{ id: 'p1', displayName: 'Ada' }], { syncMode: 'delta' });

    const sql = upsertSql('Principals');
    expect(sql).not.toContain('"updatedAt"');
    // The soft-delete re-activation it DOES carry is untouched.
    expect(sql).toContain('"deletedAt" = NULL');
  });

  it('combines with soft-delete re-activation when a table has both', async () => {
    stageTable('Resources', ['id', 'displayName', 'deletedAt', 'updatedAt']);
    await ingest(null, 'Resources', ['id'], [{ id: 'r1', displayName: 'SG-X' }], { syncMode: 'delta' });

    const sql = upsertSql('Resources');
    expect(sql).toContain('"deletedAt" = NULL');
    expect(sql).toContain('"updatedAt" = now()');
  });

  it('upgrades a key-only table from DO NOTHING to stamping the column', async () => {
    // Every column is a key, so there is no payload column to update — but the
    // row WAS re-ingested, and that is exactly what updatedAt records.
    stageTable('KeyOnly', ['a', 'b', 'updatedAt']);
    await ingest(null, 'KeyOnly', ['a', 'b'], [{ a: '1', b: '2' }], { syncMode: 'delta' });

    const sql = upsertSql('KeyOnly');
    expect(sql).toContain('DO UPDATE SET "updatedAt" = now()');
    expect(sql).not.toContain('DO NOTHING');
  });

  it('still uses DO NOTHING for a key-only table with no updatedAt', async () => {
    stageTable('KeyOnlyPlain', ['a', 'b']);
    await ingest(null, 'KeyOnlyPlain', ['a', 'b'], [{ a: '1', b: '2' }], { syncMode: 'delta' });
    expect(upsertSql('KeyOnlyPlain')).toContain('DO NOTHING');
  });
});
