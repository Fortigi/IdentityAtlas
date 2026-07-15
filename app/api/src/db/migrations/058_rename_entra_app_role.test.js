import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, '058_rename_entra_app_role.sql'), 'utf8');

// Text-level guard, mirroring 054's. The behavioural proof (a real Postgres
// rejecting the literal) lives in
// app/api/contract-tests/valueGuardConstraints.contract.test.js.
describe('migration 058 — EntraAppRole -> AppRole', () => {
  it('rewrites the literal on BOTH tables (resourceType is denormalised onto assignments by 044)', () => {
    for (const table of ['Resources', 'ResourceAssignments']) {
      expect(sql).toMatch(
        new RegExp(`UPDATE "${table}"\\s+SET "resourceType" = 'AppRole' WHERE "resourceType" = 'EntraAppRole'`),
      );
    }
  });

  it('rewrites the data before tightening the constraint', () => {
    // Reversed, the new CHECK would reject the rows this migration is fixing.
    const firstUpdate = sql.indexOf('UPDATE "Resources"');
    const firstAddConstraint = sql.indexOf('ADD CONSTRAINT');
    expect(firstUpdate).toBeGreaterThan(-1);
    expect(firstAddConstraint).toBeGreaterThan(-1);
    expect(firstUpdate).toBeLessThan(firstAddConstraint);
  });

  it('extends the retired list to all three literals, keeping NULL legal', () => {
    const guards = sql.match(
      /"resourceType" IS NULL OR "resourceType" NOT IN \('EntraGroup', 'EntraRole', 'EntraAppRole'\)/g,
    );
    expect(guards).toHaveLength(2); // Resources + ResourceAssignments
  });

  it('keeps resourceType a negative guard, never an allow-list (open vocabulary)', () => {
    // A bare `"resourceType" IN (` (without NOT) would reject the CSV / Omada /
    // midPoint / Azure types that legitimately supply their own names.
    expect(sql).not.toMatch(/"resourceType"\s+IN\s*\(/);
  });

  it('is idempotent — drops each constraint before adding it', () => {
    for (const c of ['ck_Resources_resourceType_not_retired', 'ck_RA_resourceType_not_retired']) {
      expect(sql).toContain(`DROP CONSTRAINT IF EXISTS "${c}"`);
    }
  });
});
