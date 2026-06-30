// Structural tests for migration 044a_dedup_before_source_collapse.sql
//
// These run in the fast unit suite (no DB). The behavioural proof — that
// dedup-then-collapse no longer trips uq_RA_principal / uq_RA_identity on
// colliding data — lives in contract-tests/collapseSourceTypes.contract.test.js
// (real Postgres). These guard the structure so the dedup can't be silently
// removed, regressing back to the blind UPDATE in 045 that crash-looped the
// container on boot.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(__dirname, f), 'utf8');
const dedupSql = read('044a_dedup_before_source_collapse.sql');

describe('migration 044a — pre-collapse dedup structure', () => {
  it('deletes duplicate rows (it is a dedup, not another collapse)', () => {
    expect(dedupSql).toContain('DELETE FROM "ResourceAssignments"');
    // It must NOT itself rewrite assignmentType — 045 does the collapse.
    expect(dedupSql).not.toMatch(/UPDATE\s+"ResourceAssignments"/);
  });

  it('ranks duplicates with row_number() partitioned by the COLLAPSED type', () => {
    expect(dedupSql).toMatch(/row_number\(\)\s+OVER/i);
    expect(dedupSql).toContain('PARTITION BY');
    // Partition on the collapsed value, so only true post-collapse collisions
    // are deduped — distinct kinds on the same resource/subject are preserved.
    expect(dedupSql).toContain('new_type');
  });

  it('separates the principal and identity arms in the partition', () => {
    // A row is principal XOR identity; partitioning must not merge the two arms.
    expect(dedupSql).toContain('"principalId" IS NOT NULL');
    expect(dedupSql).toMatch(/COALESCE\("principalId",\s*"identityId"\)/);
  });

  it('prefers keeping a live, already-collapsed row as the survivor', () => {
    expect(dedupSql).toMatch(/"deletedAt" IS NULL\) DESC/);
    expect(dedupSql).toMatch(/"assignmentType" = new_type\) DESC/);
  });

  it('matches loser rows by their natural key, NULL-safe', () => {
    expect(dedupSql).toContain('IS NOT DISTINCT FROM');
  });

  it('only dedupes groups that contain a source-typed row (governed-pair safety)', () => {
    // 045 only rewrites source rows, so only a group containing one can collide.
    // A governed membership (047+) is two universal 'Direct' rows with NO source
    // row; the guard keeps this file from deleting one of that pair when it runs
    // as a pending file on an already-upgraded install.
    expect(dedupSql).toMatch(/bool_or\("?is_source"?\)\s+OVER/i);
    expect(dedupSql).toMatch(/AND\s+r\."?group_has_source"?/);
    // The guard must not reference the `governed` COLUMN (quoted identifier) —
    // it doesn't exist on the pre-045 path where this normally runs. (The
    // explanatory comment mentions governed in prose; the SQL must not.)
    expect(dedupSql).not.toContain('"governed"');
  });

  it('uses the SAME collapse mapping that migration 045 applies', () => {
    // If 045 changes its mapping, the partition here must change too — this
    // pins them together so a future edit to one flags the other.
    const collapseSql = read('045_collapse_source_assignment_types.sql');
    for (const sql of [dedupSql, collapseSql]) {
      expect(sql).toMatch(/'OAuth2Grant',\s*'AppRole',\s*'DirectoryRole'\)\s*THEN 'Direct'/);
      expect(sql).toMatch(/'AppRoleViaGroup'\s*THEN 'Indirect'/);
      expect(sql).toMatch(/'DirectoryRoleEligible'\s*THEN 'Eligible'/);
    }
  });
});
