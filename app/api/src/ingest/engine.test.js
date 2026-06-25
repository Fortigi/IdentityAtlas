// Unit tests for ingest/engine.js scopedDelete — the full-sync reconcile.
// No real DB: we pass a fake client that records the SQL it's asked to run.
//
// Soft-delete tables (Principals, Resources, ResourceAssignments) reconcile by
// stamping deletedAt via UPDATE; every other table still hard-deletes. The
// reconcile statement — DELETE or UPDATE — carries the same WHERE clauses either
// way, so these tests assert against `reconcileSql`.

import { describe, it, expect } from 'vitest';
import { scopedDelete } from './engine.js';

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
