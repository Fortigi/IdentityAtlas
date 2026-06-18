// Unit tests for ingest/engine.js scopedDelete — the full-sync reconcile DELETE.
// No real DB: we pass a fake client that records the SQL it's asked to run.

import { describe, it, expect } from 'vitest';
import { scopedDelete } from './engine.js';

// A fake pg client. Records every query() call and returns an empty result.
// The CREATE INDEX / ANALYZE preamble and the DELETE all flow through here.
function fakeClient() {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return { rowCount: 0, rows: [] };
    },
    // The DELETE is the only statement that starts with DELETE.
    get deleteSql() {
      return calls.map(c => c.sql).find(s => /^\s*DELETE\b/.test(s)) || '';
    },
  };
}

// ── scopedDelete — scopeDeleteFilter cross-contamination prevention (T7.5, T7.6)

describe('scopedDelete — scopeDeleteFilter cross-contamination prevention', () => {
  const raCols = new Set(['resourceId', 'principalId', 'identityId', 'assignmentType', 'systemId']);

  it('appends the filter so identity full-sync only deletes identity rows (T7.5)', async () => {
    const client = fakeClient();
    await scopedDelete(
      client, 'ResourceAssignments', ['resourceId', 'identityId', 'assignmentType'],
      '_tmp_ingest_abc', 7, {}, 'systemId', raCols,
      '"identityId" IS NOT NULL'
    );
    expect(client.deleteSql).toContain('"identityId" IS NOT NULL');
    // Must NOT accidentally scope-delete principal rows
    expect(client.deleteSql).not.toContain('"principalId" IS NOT NULL');
  });

  it('appends the filter so principal full-sync only deletes principal rows (T7.6)', async () => {
    const client = fakeClient();
    await scopedDelete(
      client, 'ResourceAssignments', ['resourceId', 'principalId', 'assignmentType'],
      '_tmp_ingest_abc', 7, {}, 'systemId', raCols,
      '"principalId" IS NOT NULL'
    );
    expect(client.deleteSql).toContain('"principalId" IS NOT NULL');
    expect(client.deleteSql).not.toContain('"identityId" IS NOT NULL');
  });

  it('adds no extra clause when scopeDeleteFilter is null (non-RA tables)', async () => {
    const client = fakeClient();
    const resCols = new Set(['id', 'systemId', 'displayName']);
    await scopedDelete(
      client, 'Resources', ['id'], '_tmp_ingest_def', 7, {}, 'systemId', resCols, null
    );
    const sql = client.deleteSql;
    expect(sql).toContain('DELETE FROM "Resources"');
    expect(sql).not.toContain('identityId');
  });
});

// ── scopedDelete — account-linking / analyst link preservation ────────────────

describe('scopedDelete — account-linking / analyst link preservation', () => {
  it('excludes scored and analyst-owned rows when those columns exist (IdentityMembers)', async () => {
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

    const sql = client.deleteSql;
    // The crawler reconcile must skip links that carry a confidence score
    // (account linking) or an analyst decision — otherwise a full crawl wipes them.
    expect(sql).toContain('"linkConfidence" IS NULL');
    expect(sql).toContain('"analystOverride" IS NULL');
  });

  it('does not add the preservation clauses for tables without those columns', async () => {
    const client = fakeClient();
    const cols = new Set(['id', 'systemId', 'displayName']); // e.g. Resources

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

    const sql = client.deleteSql;
    expect(sql).not.toContain('linkConfidence');
    expect(sql).not.toContain('analystOverride');
    // It still performs the scoped, NOT-EXISTS reconcile delete.
    expect(sql).toContain('DELETE FROM "Resources"');
    expect(sql).toContain('NOT EXISTS');
  });
});
