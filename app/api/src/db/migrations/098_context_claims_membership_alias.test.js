// Static checks on migration 098. The SQL the feature runs against it is held
// against PostgreSQL in contract-tests/contextInterviews.contract.test.js.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { CLAIM_KINDS, RELEVANCE } from '../../contexts/interviews/claims.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, '098_context_claims_membership_alias.sql'), 'utf8');
const statements = sql.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n');
const inList = (column) => statements.match(new RegExp(`"${column}" IN \\(([^)]+)\\)`))[1].split(',').map(s => s.trim().replace(/'/g, ''));

describe('migration 098 — membership and alias claims, relevance, quote offsets', () => {
  it('replaces the claim-kind check with exactly the kinds the code uses', () => {
    expect(statements).toMatch(/DROP CONSTRAINT IF EXISTS "ContextClaims_claimKind_check";\nALTER TABLE "ContextClaims" ADD CONSTRAINT "ContextClaims_claimKind_check"/);
    expect(inList('claimKind')).toEqual(CLAIM_KINDS);
    expect(CLAIM_KINDS.slice(-2)).toEqual(['membership', 'alias']);
  });

  it('adds the relevance tier and the quote offsets, all nullable', () => {
    expect(inList('relevance')).toEqual(RELEVANCE);
    expect(statements.match(/ADD COLUMN IF NOT EXISTS "(\w+)"\s+(\w+)/g).map(s => s.replace(/\s+/g, ' ')))
      .toEqual(['ADD COLUMN IF NOT EXISTS "relevance" TEXT', 'ADD COLUMN IF NOT EXISTS "quoteStart" INTEGER', 'ADD COLUMN IF NOT EXISTS "quoteEnd" INTEGER']);
    expect(statements).not.toMatch(/NOT NULL/);
  });

  it('changes no row and touches no other table', () => {
    expect(statements).not.toMatch(/DELETE FROM|UPDATE "|INSERT INTO|DROP TABLE|DROP COLUMN/);
    expect([...new Set(statements.match(/(?:ALTER TABLE|ON) "(\w+)"/g).map(s => s.split('"')[1]))]).toEqual(['ContextClaims']);
  });
});
