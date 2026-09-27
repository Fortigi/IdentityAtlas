// Unit tests for ingest/reconcileStale.js — the timestamp reconcile a streamed
// full sync ends with. The request parser and the SQL builder are pure; the
// executor is exercised against a mocked db + engine so the statement it runs
// and the bounds it applies can be asserted without Postgres.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDiscoverColumns } = vi.hoisted(() => ({ mockDiscoverColumns: vi.fn() }));

// The shared manual mock (src/db/__mocks__/connection.js), not an inline factory.
vi.mock('../db/connection.js');
import { query as mockQuery } from '../db/connection.js';

vi.mock('./engine.js', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, discoverColumns: mockDiscoverColumns };
});

const {
  parseReconcileRequest, buildReconcileStaleSql, reconcileStale, ReconcileRequestError,
  buildScopeCountSql, countTouched,
} = await import('./reconcileStale.js');
import { queryOne as mockQueryOne } from '../db/connection.js';

const NOW = new Date('2026-09-25T12:00:00.000Z');
const BEFORE = '2026-09-25T10:00:00.000Z';
const cols = (...names) => names.map(name => ({ name }));

beforeEach(() => {
  vi.clearAllMocks();
  mockQuery.mockResolvedValue({ rowCount: 0, rows: [] });
});

describe('parseReconcileRequest', () => {
  it('resolves the entity to its table and normalises before to ISO', () => {
    const p = parseReconcileRequest({ entity: 'resource-assignments', systemId: 7, before: '2026-09-25T10:00:00Z' }, NOW);
    expect(p).toEqual({ entity: 'resource-assignments', tableName: 'ResourceAssignments', systemId: 7, before: BEFORE });
  });

  it('rejects an unknown entity', () => {
    expect(() => parseReconcileRequest({ entity: 'nope', systemId: 1, before: BEFORE }, NOW)).toThrow(/Unknown entity 'nope'/);
  });

  it('refuses every entity without a system scope, by name', () => {
    for (const entity of ['identities', 'identity-members', 'contexts', 'context-members', 'principal-activity']) {
      expect(() => parseReconcileRequest({ entity, systemId: 1, before: BEFORE }, NOW)).toThrow(/no system scope/);
    }
  });

  it('accepts every system-scoped entity', () => {
    for (const entity of ['principals', 'resources', 'resource-assignments', 'resource-assignments-identity', 'resource-relationships', 'principal-relationships']) {
      expect(parseReconcileRequest({ entity, systemId: 1, before: BEFORE }, NOW).entity).toBe(entity);
    }
  });

  it('rejects a missing, zero, negative, fractional or string systemId', () => {
    for (const systemId of [undefined, 0, -1, 1.5, '7']) {
      expect(() => parseReconcileRequest({ entity: 'resources', systemId, before: BEFORE }, NOW)).toThrow(/systemId must be a positive integer/);
    }
  });

  it('rejects a missing, non-string or unparseable before', () => {
    for (const before of [undefined, 1700000000000, 'yesterday']) {
      expect(() => parseReconcileRequest({ entity: 'resources', systemId: 1, before }, NOW)).toThrow(/ISO-8601/);
    }
  });

  it('rejects a before in the future, and allows one equal to now', () => {
    expect(() => parseReconcileRequest({ entity: 'resources', systemId: 1, before: '2026-09-25T12:00:00.001Z' }, NOW)).toThrow(/not be in the future/);
    expect(parseReconcileRequest({ entity: 'resources', systemId: 1, before: NOW.toISOString() }, NOW).before).toBe(NOW.toISOString());
  });

  it('throws the typed error so the route can answer 400', () => {
    expect(() => parseReconcileRequest({}, NOW)).toThrow(ReconcileRequestError);
  });
});

describe('buildReconcileStaleSql', () => {
  it('soft-deletes on a soft-delete table, leaving already-deleted rows alone', () => {
    const { sql, params } = buildReconcileStaleSql('ResourceAssignments', ['t."systemId" = $1', 't."assignmentType" = $2'], [7, 'Direct'], BEFORE);
    expect(sql).toMatch(/^UPDATE "ResourceAssignments" t SET "deletedAt" = now\(\)/);
    expect(sql).toContain('t."systemId" = $1 AND t."assignmentType" = $2 AND t."updatedAt" < $3');
    expect(sql).toContain('AND t."deletedAt" IS NULL');
    expect(params).toEqual([7, 'Direct', BEFORE]);
  });

  it('hard-deletes on any other table', () => {
    const { sql, params } = buildReconcileStaleSql('ResourceRelationships', ['t."systemId" = $1'], [3], BEFORE);
    expect(sql).toMatch(/^DELETE FROM "ResourceRelationships" t WHERE/);
    expect(sql).toContain('t."updatedAt" < $2');
    expect(sql).not.toContain('deletedAt');
    expect(params).toEqual([3, BEFORE]);
  });

  it('appends the scope-delete filter so the principal arm never touches identity rows', () => {
    const { sql } = buildReconcileStaleSql('ResourceAssignments', ['t."systemId" = $1'], [7], BEFORE, '"principalId" IS NOT NULL');
    expect(sql).toContain('AND ("principalId" IS NOT NULL)');
  });

  it('binds before as the parameter right after the bounds', () => {
    const { sql, params } = buildReconcileStaleSql('Resources', [], [], BEFORE);
    expect(sql).toContain('t."updatedAt" < $1');
    expect(params).toEqual([BEFORE]);
  });
});

describe('reconcileStale', () => {
  it('runs the bounded statement and returns the row count', async () => {
    mockDiscoverColumns.mockResolvedValue(cols('id', 'systemId', 'resourceType', 'updatedAt', 'deletedAt'));
    mockQuery.mockResolvedValue({ rowCount: 42 });
    const n = await reconcileStale('Resources', { systemId: 7, scope: { resourceType: 'Entitlement', bogus: 'x' }, before: BEFORE });
    expect(n).toBe(42);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('t."systemId" = $1');
    expect(sql).toContain('t."resourceType" = $2');
    expect(sql).toContain('t."updatedAt" < $3');
    // a scope key the table does not have is dropped, not bound
    expect(sql).not.toContain('bogus');
    expect(params).toEqual([7, 'Entitlement', BEFORE]);
  });

  it('refuses a table without updatedAt or without systemId before touching the db', async () => {
    mockDiscoverColumns.mockResolvedValueOnce(cols('id', 'systemId'));
    await expect(reconcileStale('Resources', { systemId: 7, before: BEFORE })).rejects.toThrow(/cannot be reconciled by timestamp/);
    mockDiscoverColumns.mockResolvedValueOnce(cols('id', 'updatedAt'));
    await expect(reconcileStale('Resources', { systemId: 7, before: BEFORE })).rejects.toThrow(ReconcileRequestError);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('adds the ownership predicate for a key restricted to specific systems', async () => {
    mockDiscoverColumns.mockResolvedValue(cols('id', 'systemId', 'updatedAt', 'deletedAt'));
    mockQuery.mockResolvedValue({ rowCount: 1 });
    await reconcileStale('Principals', { systemId: 7, before: BEFORE, restrictSystemIds: [7, 8] });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('= ANY($2::int[])');
    expect(params).toEqual([7, [7, 8], BEFORE]);
  });

  it('passes the scope-delete filter through', async () => {
    mockDiscoverColumns.mockResolvedValue(cols('systemId', 'updatedAt', 'deletedAt', 'principalId'));
    await reconcileStale('ResourceAssignments', { systemId: 2, before: BEFORE, scopeDeleteFilter: '"principalId" IS NOT NULL' });
    expect(mockQuery.mock.calls[0][0]).toContain('("principalId" IS NOT NULL)');
  });

  it('returns 0 when the statement affected nothing', async () => {
    mockDiscoverColumns.mockResolvedValue(cols('systemId', 'updatedAt'));
    mockQuery.mockResolvedValue({});
    expect(await reconcileStale('ResourceRelationships', { systemId: 2, before: BEFORE })).toBe(0);
  });
});

describe('buildScopeCountSql', () => {
  it('counts live rows touched at or after the run start, on a soft-delete table', () => {
    const { sql, params } = buildScopeCountSql('Principals', ['t."systemId" = $1', 't."principalType" = $2'], [7, 'User'], BEFORE);
    expect(sql).toBe('SELECT COUNT(*)::bigint AS n FROM "Principals" t WHERE 1=1 AND t."systemId" = $1 AND t."principalType" = $2 AND t."updatedAt" >= $3 AND t."deletedAt" IS NULL');
    expect(params).toEqual([7, 'User', BEFORE]);
  });

  it('uses >= where the reconcile uses <, so the two partition the scope exactly', () => {
    const count = buildScopeCountSql('ResourceRelationships', ['t."systemId" = $1'], [3], BEFORE).sql;
    const stale = buildReconcileStaleSql('ResourceRelationships', ['t."systemId" = $1'], [3], BEFORE).sql;
    expect(count).toContain('t."updatedAt" >= $2');
    expect(stale).toContain('t."updatedAt" < $2');
    expect(count).not.toContain('deletedAt');
  });

  it('appends the scope-delete filter', () => {
    expect(buildScopeCountSql('ResourceAssignments', [], [], BEFORE, '"principalId" IS NOT NULL').sql).toContain('AND ("principalId" IS NOT NULL)');
  });
});

describe('countTouched', () => {
  it('returns the database count as a number, bounded like the reconcile', async () => {
    mockDiscoverColumns.mockResolvedValue(cols('id', 'systemId', 'resourceType', 'updatedAt', 'deletedAt'));
    mockQueryOne.mockResolvedValue({ n: '80000' });
    expect(await countTouched('Resources', { systemId: 7, scope: { resourceType: 'Entitlement', bogus: 1 }, since: BEFORE })).toBe(80000);
    const [sql, params] = mockQueryOne.mock.calls[0];
    expect(sql).toContain('t."resourceType" = $2');
    expect(sql).not.toContain('bogus');
    expect(params).toEqual([7, 'Entitlement', BEFORE]);
  });

  it('refuses a table it cannot bound by timestamp, and reads 0 from an empty result', async () => {
    mockDiscoverColumns.mockResolvedValueOnce(cols('id', 'systemId'));
    await expect(countTouched('Resources', { systemId: 7, since: BEFORE })).rejects.toThrow(ReconcileRequestError);
    mockDiscoverColumns.mockResolvedValue(cols('systemId', 'updatedAt'));
    mockQueryOne.mockResolvedValue(undefined);
    expect(await countTouched('ResourceRelationships', { systemId: 2, since: BEFORE })).toBe(0);
  });
});
