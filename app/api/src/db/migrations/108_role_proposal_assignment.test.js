// Static checks on migration 108. The SQL the save runs against it is held
// against PostgreSQL in contract-tests/workbenchInvestigations.contract.test.js.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ASSIGNMENT_KINDS, JOINER_POLICIES, LEAVER_POLICIES, MEMBER_KINDS } from '../../contexts/workbench/investigationDraft.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, '108_role_proposal_assignment.sql'), 'utf8');
const statements = sql.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n');
const inList = (column) => statements.match(new RegExp(`"${column}" IN \\(([^)]+)\\)`))[1].split(',').map(s => s.trim().replace(/'/g, ''));

describe('migration 108 — how a proposed role is assigned', () => {
  it('checks exactly the values the code uses', () => {
    expect(inList('assignmentKind')).toEqual(ASSIGNMENT_KINDS);
    expect(inList('joinerPolicy')).toEqual(JOINER_POLICIES);
    expect(inList('leaverPolicy')).toEqual(LEAVER_POLICIES);
    expect(inList('kind')).toEqual(MEMBER_KINDS);
  });

  it('adds columns only, with defaults that keep every saved proposal as it was', () => {
    expect(statements.match(/ADD COLUMN IF NOT EXISTS "(\w+)"/g).map(s => s.split('"')[1]))
      .toEqual(['assignmentKind', 'membershipRule', 'joinerPolicy', 'leaverPolicy', 'approver', 'rationale', 'kind']);
    expect(statements).toMatch(/"kind" TEXT NOT NULL DEFAULT 'member'/);
    expect(statements).not.toMatch(/DELETE FROM|UPDATE "|INSERT INTO|DROP TABLE|DROP COLUMN|ResourceAssignments|AssignmentPolicies"/);
  });
});
