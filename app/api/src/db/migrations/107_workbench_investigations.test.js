// Static checks on migration 107. The statements the store runs against it are held
// against PostgreSQL in contract-tests/workbenchInvestigations.contract.test.js.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { MARKS } from '../../contexts/workbench/investigationDraft.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, '107_workbench_investigations.sql'), 'utf8');
const statements = sql.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n');
const tableSql = (name) => statements.match(new RegExp(`CREATE TABLE "${name}" \\(([\\s\\S]*?)\\n\\);`))[1];

describe('migration 107 — saved workbench investigations', () => {
  it('creates exactly the seven tables, and alters none', () => {
    expect(statements.match(/CREATE TABLE "(\w+)"/g).map(s => s.split('"')[1])).toEqual([
      'WorkbenchInvestigations', 'WorkbenchAccessSnapshots', 'WorkbenchMarks',
      'RoleProposals', 'RoleProposalMembers', 'RoleProposalEntitlements', 'RoleProposalEvidence']);
    expect(statements).not.toMatch(/ALTER TABLE|DROP TABLE|DELETE FROM|UPDATE "|INSERT INTO|ResourceAssignments/);
  });

  it('allows exactly the marks the code writes', () => {
    const check = tableSql('WorkbenchMarks').match(/"mark" IN \(([^)]+)\)/)[1].split(',').map(s => s.trim().replace(/'/g, ''));
    expect(check).toEqual(MARKS);
  });

  it('never stores a proposed role as a Resource, and keeps people and resources without a foreign key', () => {
    expect(statements).not.toMatch(/"Resources"\s*\(\s*"id"\s*\)\s*ON DELETE CASCADE/);
    for (const t of ['WorkbenchMarks', 'RoleProposalMembers', 'RoleProposalEntitlements']) {
      expect(tableSql(t)).not.toMatch(/"(personId|resourceId)"[^,\n]*REFERENCES/);
    }
    // The base business role is only pointed at, and forgotten when it goes.
    expect(tableSql('RoleProposals')).toMatch(/"baseBusinessRoleId"\s+UUID REFERENCES "Resources"\("id"\) ON DELETE SET NULL/);
  });

  it('removes everything of an investigation with it, and every part of a proposal with the proposal', () => {
    for (const t of ['WorkbenchAccessSnapshots', 'WorkbenchMarks', 'RoleProposals']) {
      expect(tableSql(t)).toMatch(/"investigationId"\s+UUID (NOT NULL|PRIMARY KEY) REFERENCES "WorkbenchInvestigations"\("id"\) ON DELETE CASCADE/);
    }
    for (const t of ['RoleProposalMembers', 'RoleProposalEntitlements', 'RoleProposalEvidence']) {
      expect(tableSql(t)).toMatch(/"proposalId"\s+UUID NOT NULL REFERENCES "RoleProposals"\("id"\) ON DELETE CASCADE/);
    }
  });

  it('is ready for review and versions without using them: draft first, version 1', () => {
    expect(tableSql('RoleProposals')).toMatch(/"status"\s+TEXT NOT NULL DEFAULT 'draft' CHECK \("status" IN \('draft', 'inReview', 'approved', 'rejected'\)\)/);
    expect(tableSql('RoleProposals')).toMatch(/"version"\s+INTEGER NOT NULL DEFAULT 1/);
  });

  it('keeps one name per unit, ignoring case and spaces', () => {
    expect(statements).toMatch(/CREATE UNIQUE INDEX "ux_WorkbenchInvestigations_name" ON "WorkbenchInvestigations" \("contextId", lower\(btrim\("name"\)\)\);/);
  });

  it('records history on the investigation and the proposal, not on the bulky snapshot', () => {
    expect(statements).toMatch(/ARRAY\['WorkbenchInvestigations', 'RoleProposals'\]/);
    expect(statements).toMatch(/fg_record_history/);
  });
});
