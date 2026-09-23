// Unit tests for ingest/engine.js scopedDelete — the full-sync reconcile.
// No real DB: we pass a fake client that records the SQL it's asked to run.
//
// Soft-delete tables (Principals, Resources, ResourceAssignments) reconcile by
// stamping deletedAt via UPDATE; every other table still hard-deletes. The
// reconcile statement — DELETE or UPDATE — carries the same WHERE clauses either
// way, so these tests assert against `reconcileSql`.

import { describe, it, expect } from 'vitest';
import { scopedDelete, reconcileBounds, reconcileAllowed, buildUpdateSet } from './engine.js';

// A fake pg client. Records every query() call and returns an empty result.
// The CREATE INDEX / ANALYZE preamble and the reconcile statement flow through here.
function fakeClient() {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return { rowCount: 0, rows: [] };
    },
    // The reconcile is the only DELETE or UPDATE statement (soft-delete tables
    // UPDATE … SET deletedAt; others DELETE).
    get reconcileSql() {
      return calls.map(c => c.sql).find(s => /^\s*(DELETE|UPDATE)\b/.test(s)) || '';
    },
  };
}

// ── scopedDelete — scopeDeleteFilter cross-contamination prevention (T7.5, T7.6)

describe('scopedDelete — scopeDeleteFilter cross-contamination prevention', () => {
  const raCols = new Set(['resourceId', 'principalId', 'identityId', 'assignmentType', 'systemId', 'deletedAt']);

  it('appends the filter so identity full-sync only deletes identity rows (T7.5)', async () => {
    const client = fakeClient();
    await scopedDelete(
      client, 'ResourceAssignments', ['resourceId', 'identityId', 'assignmentType'],
      '_tmp_ingest_abc', 7, {}, 'systemId', raCols,
      '"identityId" IS NOT NULL'
    );
    expect(client.reconcileSql).toContain('"identityId" IS NOT NULL');
    // Must NOT accidentally scope-delete principal rows
    expect(client.reconcileSql).not.toContain('"principalId" IS NOT NULL');
    // ResourceAssignments is a soft-delete table → stamp deletedAt, don't remove.
    expect(client.reconcileSql).toMatch(/UPDATE "ResourceAssignments"/);
    expect(client.reconcileSql).toContain('"deletedAt"');
  });

  it('appends the filter so principal full-sync only deletes principal rows (T7.6)', async () => {
    const client = fakeClient();
    await scopedDelete(
      client, 'ResourceAssignments', ['resourceId', 'principalId', 'assignmentType'],
      '_tmp_ingest_abc', 7, {}, 'systemId', raCols,
      '"principalId" IS NOT NULL'
    );
    expect(client.reconcileSql).toContain('"principalId" IS NOT NULL');
    expect(client.reconcileSql).not.toContain('"identityId" IS NOT NULL');
  });

  it('soft-deletes (not hard-deletes) a soft-delete table on full-sync reconcile', async () => {
    const client = fakeClient();
    const resCols = new Set(['id', 'systemId', 'displayName', 'deletedAt']);
    await scopedDelete(
      client, 'Resources', ['id'], '_tmp_ingest_def', 7, {}, 'systemId', resCols, null
    );
    const sql = client.reconcileSql;
    expect(sql).toContain('UPDATE "Resources"');
    expect(sql).toContain('SET "deletedAt"');
    expect(sql).toContain('NOT EXISTS');
    expect(sql).not.toContain('identityId');
  });
});

// ── scopedDelete — soft vs hard delete + account-linking / analyst preservation ──

describe('scopedDelete — soft vs hard delete + link preservation', () => {
  it('hard-deletes a non-soft-delete table, excluding scored/analyst-owned rows (IdentityMembers)', async () => {
    const client = fakeClient();
    const cols = new Set(['identityId', 'principalId', 'systemId', 'linkConfidence', 'analystOverride']);

    await scopedDelete(
      client,
      'IdentityMembers',
      ['identityId', 'principalId'],
      '_tmp_ingest_abc',
      7,            // systemId
      {},           // scope
      'systemId',
      cols
    );

    const sql = client.reconcileSql;
    // IdentityMembers is NOT a soft-delete table → real DELETE.
    expect(sql).toContain('DELETE FROM "IdentityMembers"');
    // The crawler reconcile must skip links that carry a confidence score
    // (account linking) or an analyst decision — otherwise a full crawl wipes them.
    expect(sql).toContain('"linkConfidence" IS NULL');
    expect(sql).toContain('"analystOverride" IS NULL');
  });

  it('does not add the preservation clauses for tables without those columns', async () => {
    const client = fakeClient();
    const cols = new Set(['id', 'systemId', 'displayName', 'deletedAt']); // e.g. Resources

    await scopedDelete(
      client,
      'Resources',
      ['id'],
      '_tmp_ingest_def',
      7,
      {},
      'systemId',
      cols
    );

    const sql = client.reconcileSql;
    expect(sql).not.toContain('linkConfidence');
    expect(sql).not.toContain('analystOverride');
    // Resources is a soft-delete table → it stamps deletedAt via the scoped,
    // NOT-EXISTS reconcile rather than deleting.
    expect(sql).toContain('UPDATE "Resources"');
    expect(sql).toContain('NOT EXISTS');
  });
});

// ── scopedDelete — never an unbounded reconcile (SEC-2026-09 C-01 / H-04) ────
//
// A full sync reconciles the target against the batch. Without a system, scope
// or ownership predicate that means the WHOLE table — for Systems, every other
// system and (through ON DELETE CASCADE) all of its data.

describe('reconcileBounds / reconcileAllowed', () => {
  it('bounds by systemId, then scope, binding each value as a parameter', () => {
    const cols = new Set(['systemId', 'principalType']);
    const { params, clauses } = reconcileBounds('Principals', 7, { principalType: 'User', missing: 'x' }, 'systemId', cols);
    expect(clauses).toEqual(['t."systemId" = $1', 't."principalType" = $2']);
    expect(params).toEqual([7, 'User']);
  });

  it('adds the ownership predicate for a restricted key, bound as an integer array', () => {
    const cols = new Set(['id', 'variant', 'scopeSystemId']);
    const { params, clauses } = reconcileBounds('Contexts', 7, { variant: 'synced' }, 'systemId', cols, [7, 8]);
    // Contexts has no systemId column, so the envelope systemId adds nothing.
    expect(params).toEqual(['synced', [7, 8]]);
    expect(clauses[1]).toContain('t."scopeSystemId" = ANY($2::int[])');
    expect(clauses[1]).toMatch(/^COALESCE\(\(/);
  });

  it('refuses an unbounded reconcile of Systems for every caller', () => {
    expect(reconcileAllowed('Systems', [], null)).toBe(false);
    expect(reconcileAllowed('Systems', [], [7])).toBe(false);
  });

  it('keeps the whole-table reconcile of a table with no systemId column for an UNRESTRICTED key only', () => {
    // The built-in worker's crawlers full-sync Identities / IdentityMembers /
    // ContextMembers without a scope and rely on that reconcile; a restricted key
    // may not.
    expect(reconcileAllowed('Identities', [], null)).toBe(true);
    expect(reconcileAllowed('Identities', [], [7])).toBe(false);
  });

  it('refuses a table that HAS a systemId column when no systemId reached it', () => {
    expect(reconcileAllowed('Principals', [], null)).toBe(false);
  });

  it('allows any reconcile that has at least one bound', () => {
    expect(reconcileAllowed('Systems', ['t."x" = $1'], null)).toBe(true);
  });
});

describe('scopedDelete — the unbounded-reconcile guard', () => {
  const systemsCols = new Set(['id', 'systemType', 'tenantId', 'displayName']);

  it('runs nothing and deletes nothing for a full sync of Systems', async () => {
    const client = fakeClient();
    const deleted = await scopedDelete(client, 'Systems', ['systemType', 'tenantId'], '_tmp_ingest_sys', null, {}, 'systemId', systemsCols);
    expect(deleted).toBe(0);
    expect(client.calls).toEqual([]);
  });

  it('appends the ownership predicate to the reconcile for a restricted key', async () => {
    const client = fakeClient();
    await scopedDelete(client, 'Principals', ['id'], '_tmp_ingest_p', 7, {}, 'systemId',
      new Set(['id', 'systemId', 'deletedAt']), null, [7]);
    const call = client.calls.find(c => /^\s*UPDATE "Principals"/.test(c.sql));
    expect(call.sql).toContain('t."systemId" = $1 AND COALESCE((t."systemId" = ANY($2::int[])), false)');
    expect(call.params).toEqual([7, [7]]);
  });

  it('still reconciles an unscoped IdentityMembers full sync for an unrestricted key', async () => {
    const client = fakeClient();
    await scopedDelete(client, 'IdentityMembers', ['identityId', 'principalId'], '_tmp_ingest_im', 7, {}, 'systemId',
      new Set(['identityId', 'principalId', 'linkConfidence', 'analystOverride']));
    expect(client.reconcileSql).toContain('DELETE FROM "IdentityMembers"');
  });
});

// ── buildUpdateSet — the DO UPDATE list, and who may overwrite what ─────────
//
// Three rules share one builder (#1247), so each is asserted against a case the
// other two would get wrong: a preserved column must keep the STORED value even
// in a full sync (where the payload is otherwise authoritative), and a delta must
// still protect unchanged fields from a NULL payload.
describe('buildUpdateSet', () => {
  const cols = [{ name: 'systemId' }, { name: 'displayName' }];

  it('takes the incoming value on a full sync', () => {
    const sql = buildUpdateSet(cols, 'Principals', { syncMode: 'full' });
    expect(sql).toBe('"systemId" = EXCLUDED."systemId", "displayName" = EXCLUDED."displayName"');
  });

  it('keeps the stored value when a delta omits a field', () => {
    const sql = buildUpdateSet(cols, 'Principals', { syncMode: 'delta' });
    expect(sql).toContain('"displayName" = COALESCE(EXCLUDED."displayName", "Principals"."displayName")');
  });

  it('lets a preserved column only FILL a NULL, never replace a value', () => {
    // The COALESCE arguments are the decision: stored first means the dependent
    // system's id can never displace the directory's. Reversed, this is the bug.
    const sql = buildUpdateSet(cols, 'Principals', { syncMode: 'delta', preserveColumns: ['systemId'] });
    expect(sql).toContain('"systemId" = COALESCE("Principals"."systemId", EXCLUDED."systemId")');
    expect(sql).not.toContain('COALESCE(EXCLUDED."systemId"');
  });

  it('preserves a column even in a full sync, where the payload is otherwise authoritative', () => {
    const sql = buildUpdateSet(cols, 'Principals', { syncMode: 'full', preserveColumns: ['systemId'] });
    expect(sql).toContain('"systemId" = COALESCE("Principals"."systemId", EXCLUDED."systemId")');
    // Only the preserved column changes behaviour — the rest stays authoritative.
    expect(sql).toContain('"displayName" = EXCLUDED."displayName"');
  });

  it('leaves columns that are not in the preserve list alone', () => {
    const sql = buildUpdateSet(cols, 'Principals', { syncMode: 'full', preserveColumns: ['accountEnabled'] });
    expect(sql).toBe('"systemId" = EXCLUDED."systemId", "displayName" = EXCLUDED."displayName"');
  });

  it('defaults to full-sync semantics and no preserved columns', () => {
    expect(buildUpdateSet(cols, 'Principals')).toBe(
      '"systemId" = EXCLUDED."systemId", "displayName" = EXCLUDED."displayName"');
  });
});
