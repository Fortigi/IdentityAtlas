// SQL structure tests for migration 037_matrix_view_identity_support.sql
//
// These tests verify the matview SQL contains the structural elements required
// for identity-level assignment expansion without needing a running database.
// They catch regressions if the UNION arm or key WHERE guards are accidentally
// removed.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, '037_matrix_view_identity_support.sql'), 'utf8');

describe('migration 037 — matview identity arm structure (T7.7, T7.8)', () => {
  it('drops the dependent regular view before the matview (T7.7)', () => {
    const dropView    = sql.indexOf('DROP VIEW IF EXISTS "vw_UserPermissionAssignments"');
    const dropMatview = sql.indexOf('DROP MATERIALIZED VIEW IF EXISTS "vw_ResourceUserPermissionAssignments"');
    expect(dropView,    'DROP VIEW must be present').toBeGreaterThan(-1);
    expect(dropMatview, 'DROP MATERIALIZED VIEW must be present').toBeGreaterThan(-1);
    // Dependent view must be dropped first — otherwise Postgres errors on CASCADE
    expect(dropView).toBeLessThan(dropMatview);
  });

  it('contains a UNION ALL arm for identity-level assignments', () => {
    expect(sql).toContain('UNION ALL');
  });

  it('identity arm joins IdentityMembers (T7.7)', () => {
    expect(sql).toContain('"IdentityMembers" im');
    expect(sql).toContain('im."identityId" = ra."identityId"');
  });

  it('identity arm is guarded by WHERE identityId IS NOT NULL', () => {
    expect(sql).toContain('ra."identityId" IS NOT NULL');
  });

  it('principal arm is guarded by WHERE principalId IS NOT NULL (T7.8)', () => {
    // An identity with no IdentityMembers rows must not appear in the matview.
    // Conversely, principal rows must still flow through the existing arm.
    // The WHERE guard on the principal arm ensures the INNER JOIN in the
    // identity arm does not accidentally expand principal rows.
    expect(sql).toContain('ra."principalId" IS NOT NULL');
  });

  it('governed_pairs CTE filters to principalId IS NOT NULL', () => {
    // governed_pairs was previously unconstrained; with nullable principalId
    // a NULL = UUID comparison would silently drop governed_pairs matches.
    expect(sql).toMatch(/"assignmentType" = 'Governed'[\s\S]*?"principalId" IS NOT NULL/);
  });

  it('GROUP BY dedup is preserved so cross-arm duplicates collapse (T7.7)', () => {
    expect(sql).toContain('GROUP BY "resourceId", "principalId", "membershipType"');
  });

  it('recreates the regular compat view over the matview', () => {
    expect(sql).toContain('CREATE VIEW "vw_UserPermissionAssignments"');
  });
});
