import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, '061_business_role_covers_itself.sql'), 'utf8');

// Text-level guard, mirroring 054's/058's. The behavioural proof (a real
// Postgres returning the self row) lives in
// app/api/contract-tests/governedIntentGap.contract.test.js.
describe('migration 061 — a business role covers its own membership row', () => {
  it('rebuilds the business-role coverage matview', () => {
    expect(sql).toMatch(
      /DROP MATERIALIZED VIEW IF EXISTS "vw_UserPermissionAssignmentViaBusinessRole" CASCADE/,
    );
    expect(sql).toMatch(
      /CREATE MATERIALIZED VIEW "vw_UserPermissionAssignmentViaBusinessRole"/,
    );
  });

  it('keeps the Contains arm and adds a self arm', () => {
    expect(sql).toContain(`WHERE rr."relationshipType" = 'Contains'`);
    // The self arm reports the governance resource as its own role AND resource.
    expect(sql).toMatch(/gov\.id\s+AS "resourceId",\s*\n\s*gov\.id\s+AS "businessRoleId"/);
    expect(sql.match(/^UNION$/m)).not.toBeNull();
  });

  it('counts only effective assignments — soft-deleted ones stay out of both arms', () => {
    const guards = sql.match(/bru\."deletedAt" IS NULL/g);
    expect(guards).toHaveLength(2);
  });

  it('restricts the self arm to governance resources', () => {
    expect(sql).toContain(`WHERE gov."governanceResource"`);
  });

  it('recreates the indexes the matview is queried through and populates it', () => {
    for (const ix of ['ix_vw_UPABR_pk', 'ix_vw_UPABR_userId', 'ix_vw_UPABR_groupId']) {
      expect(sql).toContain(`"${ix}"`);
    }
    expect(sql).toMatch(
      /REFRESH MATERIALIZED VIEW "vw_UserPermissionAssignmentViaBusinessRole"/,
    );
  });
});
