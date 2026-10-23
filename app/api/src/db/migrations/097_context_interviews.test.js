// Static checks on migration 097. What the feature writes into it is verified
// against PostgreSQL in contract-tests/contextInterviews.contract.test.js.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { CLAIM_KINDS, CLAIM_STATUSES, ROLE_SUGGESTIONS } from '../../contexts/interviews/claims.js';
import { CONTEXT_ROLE_TYPES } from '../../ingest/validation.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, '097_context_interviews.sql'), 'utf8');
const statements = sql.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n');
const inList = (column) => statements.match(new RegExp(`"${column}" IN \\(([^)]+)\\)`))[1].split(',').map(s => s.trim().replace(/'/g, ''));

describe('migration 097 — context interviews', () => {
  it('creates the two tables, adds one column to ContextRoles, and writes no rows', () => {
    expect(statements.match(/CREATE TABLE "(\w+)"/g)).toEqual(['CREATE TABLE "ContextInterviews"', 'CREATE TABLE "ContextClaims"']);
    expect(statements.match(/ALTER TABLE "(\w+)"/g)).toEqual(['ALTER TABLE "ContextRoles"']);
    expect(statements).toMatch(/ADD COLUMN "sourceClaimId" UUID REFERENCES "ContextClaims"\("id"\) ON DELETE SET NULL/);
    expect(statements).not.toMatch(/DELETE FROM|UPDATE "|INSERT INTO|DROP TABLE|DROP COLUMN/);
  });

  it('an interview goes with its context; its claims go with it; a removed person only clears the link', () => {
    expect(statements).toMatch(/"contextId"\s+UUID NOT NULL REFERENCES "Contexts"\("id"\)\s+ON DELETE CASCADE,\n\s+"principalId"\s+UUID\s+REFERENCES "Principals"\("id"\) ON DELETE SET NULL/);
    expect(statements).toMatch(/"interviewId"\s+UUID NOT NULL REFERENCES "ContextInterviews"\("id"\) ON DELETE CASCADE/);
    expect(statements.match(/REFERENCES "(Principals|Identities)"\("id"\) ON DELETE (\w+ ?\w*)/g))
      .toEqual(Array(4).fill(null).map((_, i) => `REFERENCES "${i % 2 ? 'Identities' : 'Principals'}"("id") ON DELETE SET NULL`));
  });

  it('admits exactly the claim kinds, statuses and suggestions the code uses', () => {
    // 098 widens the kinds (membership, alias); 097 shipped the first four.
    expect(inList('claimKind')).toEqual(CLAIM_KINDS.slice(0, 4));
    expect(CLAIM_KINDS.slice(0, 4)).toEqual(['description', 'property', 'role', 'roleHistory']);
    expect(inList('claimStatus')).toEqual(CLAIM_STATUSES);
    expect(inList('roleSuggestion')).toEqual(ROLE_SUGGESTIONS);
    expect(ROLE_SUGGESTIONS).toEqual(CONTEXT_ROLE_TYPES);
    expect(inList('proposedBy')).toEqual(['model', 'analyst']);
    expect(inList('extractionStatus')).toEqual(['pending', 'running', 'done', 'failed', 'notConfigured']);
  });

  it('keeps a claim\'s subject and an interviewee to one holder at most', () => {
    expect(statements).toMatch(/"ck_ContextInterviews_one_interviewee" CHECK \("principalId" IS NULL OR "identityId" IS NULL\)/);
    expect(statements).toMatch(/"ck_ContextClaims_one_subject" CHECK \("principalId" IS NULL OR "identityId" IS NULL\)/);
  });

  it('records every decision on a claim in _history', () => {
    expect(statements).toMatch(/AFTER INSERT OR DELETE ON "ContextClaims"/);
    expect(statements).toMatch(/AFTER UPDATE ON "ContextClaims"/);
  });
});
