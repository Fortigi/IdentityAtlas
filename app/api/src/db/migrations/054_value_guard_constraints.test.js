import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, '054_value_guard_constraints.sql'), 'utf8');

// Text-level guard: the behavioural proof (a real Postgres rejecting an insert)
// lives in app/api/contract-tests/valueGuardConstraints.contract.test.js. This
// test just stops a phase from being silently deleted or the resourceType guard
// from being turned into a (wrong) allow-list.
describe('migration 054 — DB value-guard constraints', () => {
  it('allow-lists assignmentType to the three universal values', () => {
    expect(sql).toMatch(/ADD CONSTRAINT "ck_RA_assignmentType"/);
    expect(sql).toMatch(/CHECK \("assignmentType" IN \('Direct', 'Indirect', 'Eligible'\)\)/);
  });

  it('forbids the retired resourceType literals on both tables while allowing NULL', () => {
    for (const c of ['ck_Resources_resourceType_not_retired', 'ck_RA_resourceType_not_retired']) {
      expect(sql).toContain(c);
    }
    // Two occurrences (Resources + ResourceAssignments), each NULL-tolerant.
    const negativeGuards = sql.match(
      /"resourceType" IS NULL OR "resourceType" NOT IN \('EntraGroup', 'EntraRole'\)/g,
    );
    expect(negativeGuards).toHaveLength(2);
  });

  it('keeps resourceType a negative guard, never an allow-list (open vocabulary)', () => {
    // A bare `"resourceType" IN (` (without NOT) would wrongly reject CSV/Omada/
    // midPoint/Azure types — it must not appear.
    expect(sql).not.toMatch(/"resourceType"\s+IN\s*\(/);
  });

  it('is idempotent — drops each constraint before adding it', () => {
    for (const c of ['ck_RA_assignmentType', 'ck_Resources_resourceType_not_retired', 'ck_RA_resourceType_not_retired']) {
      expect(sql).toContain(`DROP CONSTRAINT IF EXISTS "${c}"`);
    }
  });
});
