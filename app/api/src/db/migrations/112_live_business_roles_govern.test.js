import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, '112_live_business_roles_govern.sql'), 'utf8');
const sql049 = readFileSync(join(__dirname, '049_governed_intent_rows.sql'), 'utf8');

// The migration's prose explains the filters it adds, so counting guards over
// the raw text would count the commentary too.
const stripComments = (text) => text.replace(/^\s*--.*$/gm, '');
const code = stripComments(sql);

// Text-level guard, mirroring 061's. The behavioural proof (a real Postgres
// leaving a tombstoned role's coverage rows out, and reporting
// managedByAccessPackage = false on the live child cell) lives in
// app/api/contract-tests/governedIntentGap.contract.test.js.
describe('migration 112 — a source-deleted business role governs nothing', () => {
  it('rebuilds both derivations of governance coverage', () => {
    // The role-behind-the-cell matview (061) …
    expect(sql).toMatch(
      /DROP MATERIALIZED VIEW IF EXISTS "vw_UserPermissionAssignmentViaBusinessRole" CASCADE/,
    );
    expect(sql).toMatch(/CREATE MATERIALIZED VIEW "vw_UserPermissionAssignmentViaBusinessRole"/);
    // … and the matrix matview whose soll CTE stamps managedByAccessPackage (049).
    expect(sql).toMatch(/DROP MATERIALIZED VIEW IF EXISTS "vw_ResourceUserPermissionAssignments"/);
    expect(sql).toMatch(/CREATE MATERIALIZED VIEW "vw_ResourceUserPermissionAssignments"/);
  });

  it('requires the governance resource to be live on every arm of both views', () => {
    // Two arms of the coverage matview + both arms of the soll CTE. A missing
    // one is exactly the #1629 defect, so the count is the assertion.
    expect(code.match(/gov\."deletedAt" IS NULL/g)).toHaveLength(4);
    // Every `gov` join is guarded — none left behind.
    const govJoins = code.match(/gov\."governanceResource"/g) || [];
    expect(govJoins).toHaveLength(4);
  });

  it('requires the contained resource to be live on the Contains arm', () => {
    expect(sql).toMatch(
      /JOIN "Resources" child\s*\n\s*ON child\.id = rr\."childResourceId"\s*\n\s*AND child\."deletedAt" IS NULL/,
    );
  });

  it('keeps the 049/061 filters it inherits — assignment, holder and target liveness', () => {
    // Soft-deleted membership rows stay out of both arms of both views (061).
    expect(code.match(/bru\."deletedAt" IS NULL/g)).toHaveLength(4);
    // The effective arms keep 041's tombstoned-holder/target exclusions.
    expect(code.match(/r\."deletedAt" IS NOT NULL/g)).toHaveLength(2);
    expect(code.match(/p\."deletedAt" IS NOT NULL/g)).toHaveLength(2);
    // The self arm is still governance-only (061).
    expect(sql).toMatch(/WHERE gov\."governanceResource"\s*\n\s*AND gov\."deletedAt" IS NULL/);
    expect(sql).toContain(`WHERE rr."relationshipType" = 'Contains'`);
    expect(sql.match(/^UNION$/m)).not.toBeNull();
  });

  it('changes nothing about the matrix matview except the coverage liveness filter', () => {
    // Recreating a matview re-states its whole definition, so the risk is an
    // unintended edit riding along. The two bodies must differ ONLY by the
    // added gov."deletedAt" guards.
    const HEAD = 'CREATE MATERIALIZED VIEW "vw_ResourceUserPermissionAssignments"';
    const body = (raw) => {
      const text = stripComments(raw);
      const from = text.indexOf(HEAD);
      const definition = text.slice(from, text.indexOf('WITH NO DATA;', from));
      return definition.replace(/ AND gov\."deletedAt" IS NULL/g, '').replace(/\s+/g, ' ').trim();
    };
    expect(body(sql)).toBe(body(sql049));
  });

  it('recreates every index and the wrapper view the two matviews are read through', () => {
    for (const ix of ['ix_vw_UPABR_pk', 'ix_vw_UPABR_userId', 'ix_vw_UPABR_groupId']) {
      expect(sql).toContain(`"${ix}"`);
    }
    for (const ix of [
      'ix_vw_ResUserPerm_pk', 'ix_vw_ResUserPerm_principalId',
      'ix_vw_ResUserPerm_resourceId', 'ix_vw_ResUserPerm_direct',
    ]) {
      expect(sql).toContain(`"${ix}"`);
    }
    // CASCADE on the coverage matview takes the wrapper view with it.
    expect(sql).toMatch(/CREATE VIEW "vw_UserPermissionAssignments" AS/);
    expect(sql).toMatch(/"principalId"\s+AS "memberId"/);
  });

  it('populates both matviews, which are created WITH NO DATA', () => {
    expect(code.match(/WITH NO DATA;/g)).toHaveLength(2);
    expect(sql).toMatch(/REFRESH MATERIALIZED VIEW "vw_UserPermissionAssignmentViaBusinessRole"/);
    expect(sql).toMatch(/REFRESH MATERIALIZED VIEW "vw_ResourceUserPermissionAssignments"/);
  });
});
