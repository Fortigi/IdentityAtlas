// Static checks on migration 106. The SQL the workbench runs against it is held
// against PostgreSQL in contract-tests/workbench.contract.test.js.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { CLAIM_KINDS } from '../../contexts/interviews/claims.js';
import { KNOWLEDGE_KINDS } from '../../lib/orgKnowledge.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, '106_org_knowledge_claims.sql'), 'utf8');
const statements = sql.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n');

describe('migration 106 — activity, expertise and duty claims', () => {
  it('replaces the claim-kind check with exactly the kinds the code uses, the three new ones last', () => {
    const check = statements.match(/"claimKind" IN \(([^)]+)\)\);/)[1].split(',').map(s => s.trim().replace(/'/g, ''));
    expect(check).toEqual(CLAIM_KINDS);
    expect(check.slice(-3)).toEqual(KNOWLEDGE_KINDS);
  });

  it('adds a nullable object reference that a deleted object clears', () => {
    expect(statements).toMatch(/ADD COLUMN IF NOT EXISTS "objectContextId" UUID REFERENCES "Contexts"\("id"\) ON DELETE SET NULL;/);
    expect(statements).not.toMatch(/UUID NOT NULL|SET NOT NULL/);
  });

  it('indexes the knowledge claims by person for the workbench read', () => {
    expect(statements.match(/CREATE INDEX IF NOT EXISTS "(\w+)"/g).map(s => s.split('"')[1]))
      .toEqual(['ix_ContextClaims_object', 'ix_ContextClaims_knowledge_identity', 'ix_ContextClaims_knowledge_principal']);
  });

  it('changes no row and touches no other table', () => {
    expect(statements).not.toMatch(/DELETE FROM|UPDATE "|INSERT INTO|DROP TABLE|DROP COLUMN|ResourceAssignments/);
    expect([...new Set(statements.match(/(?:ALTER TABLE|ON) "(\w+)"/g).map(s => s.split('"')[1]))]).toEqual(['ContextClaims']);
  });
});
