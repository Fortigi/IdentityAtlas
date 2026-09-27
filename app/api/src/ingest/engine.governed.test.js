// A membership of a governance resource is governed by definition. ingest()
// flags such rows in the staged batch before its upsert, so a re-import matches
// the row classify already flipped instead of inserting an ungoverned copy beside
// it (governed is part of the unique key). These drive the real ingest() and
// markGovernanceMemberships with only db/connection mocked; the real-PostgreSQL
// proof is contract-tests/crawlerRerun.contract.test.js.

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db/connection.js');
import { query } from '../db/connection.js';
import { ingest, markGovernanceMemberships } from './engine.js';

const RA_KEY = ['resourceId', 'principalId', 'assignmentType', 'governed'];
const RA_COLUMNS = ['resourceId', 'principalId', 'assignmentType', 'governed', 'systemId'];

beforeEach(() => {
  query.mockReset();
  query.mockImplementation(async (sql) => {
    const s = String(sql);
    if (/information_schema\.columns/.test(s)) {
      return { rows: RA_COLUMNS.map((column_name) => ({ column_name, data_type: 'text' })), rowCount: RA_COLUMNS.length };
    }
    if (/^\s*INSERT INTO "ResourceAssignments"/.test(s)) return { rows: [{ wasInsert: false }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
});

const sqls = () => query.mock.calls.map((c) => String(c[0]));

describe('markGovernanceMemberships', () => {
  const client = { query: vi.fn() };
  beforeEach(() => client.query.mockReset());

  it('flags the batch rows that point at a governance resource', async () => {
    await markGovernanceMemberships(client, 'ResourceAssignments', 'tmp', RA_KEY, RA_COLUMNS.map((name) => ({ name })));
    expect(client.query).toHaveBeenCalledTimes(1);
    const sql = client.query.mock.calls[0][0];
    expect(sql).toMatch(/UPDATE "tmp" t SET "governed" = true/);
    expect(sql).toContain('r."governanceResource"');
    expect(sql).toContain('t."governed" IS NOT TRUE');
  });

  it('leaves a row alone when the batch already holds the governed row for the same grant', async () => {
    await markGovernanceMemberships(client, 'ResourceAssignments', 'tmp', RA_KEY, RA_COLUMNS.map((name) => ({ name })));
    const sql = client.query.mock.calls[0][0];
    // Same grant = every key column except governed itself.
    expect(sql).toContain('g."resourceId" IS NOT DISTINCT FROM t."resourceId"');
    expect(sql).toContain('g."principalId" IS NOT DISTINCT FROM t."principalId"');
    expect(sql).toContain('g."assignmentType" IS NOT DISTINCT FROM t."assignmentType"');
    expect(sql).not.toContain('g."governed" IS NOT DISTINCT FROM');
  });

  it('matches an identity-keyed batch on identityId', async () => {
    const key = ['resourceId', 'identityId', 'assignmentType', 'governed'];
    await markGovernanceMemberships(client, 'ResourceAssignments', 'tmp', key, key.map((name) => ({ name })));
    expect(client.query.mock.calls[0][0]).toContain('g."identityId" IS NOT DISTINCT FROM t."identityId"');
  });

  it('does nothing for another table or a batch without the governed column', async () => {
    await markGovernanceMemberships(client, 'Principals', 'tmp', ['id'], [{ name: 'id' }, { name: 'governed' }]);
    await markGovernanceMemberships(client, 'ResourceAssignments', 'tmp', RA_KEY, [{ name: 'resourceId' }]);
    expect(client.query).not.toHaveBeenCalled();
  });
});

describe('ingest() — governance memberships', () => {
  it('flags them after staging the batch and before the upsert', async () => {
    await ingest(null, 'ResourceAssignments', RA_KEY,
      [{ resourceId: 'r1', principalId: 'p1', assignmentType: 'Direct', governed: false }],
      { syncMode: 'delta', conflictFilter: '"principalId" IS NOT NULL' });
    const all = sqls();
    const staged = all.findIndex((s) => /^\s*INSERT INTO "_tmp_ingest_/.test(s));
    const marked = all.findIndex((s) => /SET "governed" = true/.test(s));
    const upsert = all.findIndex((s) => /^\s*INSERT INTO "ResourceAssignments"/.test(s));
    expect(staged).toBeGreaterThanOrEqual(0);
    expect(marked).toBeGreaterThan(staged);
    expect(upsert).toBeGreaterThan(marked);
  });

  it('does not touch another table, even one with a governed column', async () => {
    // The mocked schema gives every table the assignment columns, so only the
    // table name keeps this batch out.
    await ingest(null, 'Principals', RA_KEY,
      [{ resourceId: 'r1', principalId: 'p1', assignmentType: 'Direct', governed: false }], { syncMode: 'delta' });
    expect(sqls().some((s) => /^\s*INSERT INTO "Principals"/.test(s))).toBe(true);
    expect(sqls().some((s) => /SET "governed" = true/.test(s))).toBe(false);
  });
});
