// Unit tests for the per-system ingest boundary (SEC-2026-09 C-01 / H-04).
//
// The pure decisions are asserted directly. The SQL builders are asserted on the
// predicate each table gets — which column carries ownership is the decision, and
// a wrong one would let a restricted key reach another system's rows. Whether the
// SQL returns the right rows against a real schema is the job of
// contract-tests/ingestSystemBoundary.integration.test.js (the db mock is SQL-blind).

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db/connection.js');
import { query } from '../db/connection.js';
import {
  NO_SYSTEM_COLUMN_TABLES, SERVER_MANAGED_COLUMNS, writableCoreColumns, restrictedSystemIds,
  ownedRowPredicate, recordSystemDenial, unscopedFullSyncDenial, foreignExistingRowSql,
  foreignParentSql, foreignRowDenial, systemBoundaryDenial,
} from './systemBoundary.js';

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('restrictedSystemIds', () => {
  it('is null for an unrestricted key (systemIds null) — the built-in worker is not boundary-checked', () => {
    expect(restrictedSystemIds({ id: 1, systemIds: null })).toBeNull();
    expect(restrictedSystemIds(undefined)).toBeNull();
  });

  it('returns the integer allow-list, dropping anything that is not an integer', () => {
    expect(restrictedSystemIds({ systemIds: [7, '9', 'x', 2.5] })).toEqual([7, 9]);
  });

  it('an EMPTY allow-list is still a restriction (it allows nothing), not "unrestricted"', () => {
    expect(restrictedSystemIds({ systemIds: [] })).toEqual([]);
  });
});

describe('writableCoreColumns', () => {
  it('removes server-managed columns but keeps systemId and source columns', () => {
    const cols = ['id', 'systemId', 'displayName', 'riskScore', 'riskTier', 'deletedAt',
      'linkConfidence', 'analystOverride', 'createdAt', 'updatedAt', 'managerId'];
    expect(writableCoreColumns(cols)).toEqual(['id', 'systemId', 'displayName', 'managerId']);
  });

  it('does not treat systemId as server-managed (it is stamped and access-checked instead)', () => {
    expect(SERVER_MANAGED_COLUMNS.has('systemId')).toBe(false);
  });
});

describe('recordSystemDenial', () => {
  const allowed = [7];

  it('denies a record whose own systemId is outside the allow-list, naming the record', () => {
    const err = recordSystemDenial([{ systemId: 7 }, { systemId: 1 }], allowed);
    expect(err).toMatch(/^Record 1: systemId 1 /);
  });

  it('denies a context whose scopeSystemId is outside the allow-list', () => {
    expect(recordSystemDenial([{ scopeSystemId: 3 }], allowed)).toMatch(/scopeSystemId 3/);
  });

  it('accepts the allowed system given as a string (JSON bodies are not typed)', () => {
    expect(recordSystemDenial([{ systemId: '7', scopeSystemId: 7 }], allowed)).toBeNull();
  });

  it('accepts records that carry no system at all, and null values', () => {
    expect(recordSystemDenial([{ id: 'x' }, { systemId: null }], allowed)).toBeNull();
  });
});

describe('unscopedFullSyncDenial', () => {
  it('refuses an unscoped FULL sync on a table without a systemId column', () => {
    for (const table of NO_SYSTEM_COLUMN_TABLES) {
      expect(unscopedFullSyncDenial(table, 'full', {}), table).toContain(`full sync of ${table} needs a scope`);
    }
  });

  it('allows it once a scope is given', () => {
    expect(unscopedFullSyncDenial('Contexts', 'full', { variant: 'synced' })).toBeNull();
  });

  it('does not apply to a delta, or to a table the envelope systemId already bounds', () => {
    expect(unscopedFullSyncDenial('Identities', 'delta', {})).toBeNull();
    expect(unscopedFullSyncDenial('Principals', 'full', {})).toBeNull();
    expect(unscopedFullSyncDenial('Contexts', 'full', undefined)).toMatch(/needs a scope/);
  });
});

describe('ownedRowPredicate — the column that carries ownership, per table', () => {
  it('uses systemId for a table that has one', () => {
    expect(ownedRowPredicate('Principals', 't', '$2')).toBe('t."systemId" = ANY($2::int[])');
    expect(ownedRowPredicate('ResourceAssignments', 'x', '$5')).toBe('x."systemId" = ANY($5::int[])');
  });

  it('uses the row id for Systems', () => {
    expect(ownedRowPredicate('Systems', 't', '$2')).toBe('t."id" = ANY($2::int[])');
  });

  it('owns only SYNCED contexts scoped to an allowed system (never generated or manual ones)', () => {
    const sql = ownedRowPredicate('Contexts', 't', '$2');
    expect(sql).toContain(`t."variant" = 'synced'`);
    expect(sql).toContain('t."scopeSystemId" = ANY($2::int[])');
  });

  it('derives a context member from its context', () => {
    const sql = ownedRowPredicate('ContextMembers', 't', '$2');
    expect(sql).toContain('oc."id" = t."contextId"');
    expect(sql).toContain('oc."scopeSystemId" = ANY($2::int[])');
  });

  it('derives identity members and principal activity from the linked principal', () => {
    for (const table of ['IdentityMembers', 'PrincipalActivity']) {
      const sql = ownedRowPredicate(table, 't', '$2');
      expect(sql).toContain('op."id" = t."principalId"');
      expect(sql).toContain('op."systemId" = ANY($2::int[])');
    }
  });

  it('owns an identity only when it links an allowed principal and none outside', () => {
    const sql = ownedRowPredicate('Identities', 't', '$2');
    expect(sql).toMatch(/EXISTS \(SELECT 1 FROM "IdentityMembers" oim JOIN "Principals"/);
    expect(sql).toMatch(/AND NOT EXISTS \(SELECT 1 FROM "IdentityMembers" oim LEFT JOIN "Principals"/);
    expect(sql).toContain('op."systemId" IS NULL OR NOT (op."systemId" = ANY($2::int[]))');
  });
});

describe('foreignExistingRowSql', () => {
  it('joins the incoming keys by position and flags rows the caller does not own', () => {
    const sql = foreignExistingRowSql('ResourceAssignments', ['resourceId', 'principalId'], '"principalId" IS NOT NULL');
    expect(sql).toContain('jsonb_populate_recordset(NULL::"ResourceAssignments", $1::jsonb)');
    expect(sql).toContain('r."resourceId" AS k0, r."principalId" AS k1');
    expect(sql).toContain('t."resourceId" = k.k0 AND t."principalId" = k.k1');
    // COALESCE: a NULL systemId must count as "not owned", not slip through as NULL.
    expect(sql).toContain('WHERE NOT COALESCE((t."systemId" = ANY($2::int[])), false)');
    expect(sql).toContain('AND ("principalId" IS NOT NULL)');
  });

  it('treats a table with no known ownership as owned by nobody', () => {
    // A future table with no systemId column that nobody taught this module about
    // must fail closed.
    expect(ownedRowPredicate('SomeNewTable', 't', '$2')).toMatch(/"systemId"/);
    NO_SYSTEM_COLUMN_TABLES.add('SomeNewTable');
    try {
      expect(foreignExistingRowSql('SomeNewTable', ['id'], null)).toContain('NOT COALESCE((false), false)');
    } finally {
      NO_SYSTEM_COLUMN_TABLES.delete('SomeNewTable');
    }
  });
});

describe('foreignRowDenial', () => {
  it('asks about the existing rows the batch would update, sending only key columns', async () => {
    const err = await foreignRowDenial('Principals', ['id'], [{ id: 'p1', displayName: 'secret', systemId: 7 }], [7], null);
    expect(err).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('FROM "Principals" t');
    expect(JSON.parse(params[0])).toEqual([{ id: 'p1' }]);
    expect(params[1]).toEqual([7]);
  });

  it('denies when a matching row belongs to another system', async () => {
    query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    const err = await foreignRowDenial('Principals', ['id'], [{ id: 'p1' }], [7], null);
    expect(err).toMatch(/would modify a Principals row owned by a system outside/);
  });

  it('checks the PARENT of a link table, so a new link to a foreign principal is refused too', async () => {
    query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    const err = await foreignRowDenial('IdentityMembers', ['identityId', 'principalId'],
      [{ identityId: 'i1', principalId: 'p9' }], [7], null);
    expect(err).toMatch(/links a IdentityMembers row to a system outside/);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('FROM jsonb_populate_recordset(NULL::"IdentityMembers", $1::jsonb) r');
    expect(JSON.parse(params[0])).toEqual([{ principalId: 'p9' }]);
  });

  it('uses the context as the parent of a context member', async () => {
    await foreignRowDenial('ContextMembers', ['contextId', 'memberId'], [{ contextId: 'c1', memberId: 'm1' }], [7], null);
    expect(JSON.parse(query.mock.calls[0][1][0])).toEqual([{ contextId: 'c1' }]);
    expect(query.mock.calls[0][0]).toBe(foreignParentSql('ContextMembers'));
  });

  it('does not query at all for an empty batch', async () => {
    expect(await foreignRowDenial('Principals', ['id'], [], [7], null)).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });
});

describe('systemBoundaryDenial — order of checks', () => {
  const base = { tableName: 'Identities', keyColumns: ['id'], scope: {}, conflictFilter: null, allowed: [7] };

  it('reports a foreign record system before anything reaches the database', async () => {
    const err = await systemBoundaryDenial({ ...base, tableName: 'Principals', records: [{ systemId: 1 }], syncMode: 'delta' });
    expect(err).toMatch(/systemId 1/);
    expect(query).not.toHaveBeenCalled();
  });

  it('reports an unscoped full sync before the row lookup', async () => {
    const err = await systemBoundaryDenial({ ...base, records: [{ id: 'i1' }], syncMode: 'full' });
    expect(err).toMatch(/needs a scope/);
    expect(query).not.toHaveBeenCalled();
  });

  it('falls through to the row lookup when the batch is otherwise in bounds', async () => {
    const err = await systemBoundaryDenial({ ...base, records: [{ id: 'i1' }], syncMode: 'delta' });
    expect(err).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });
});
