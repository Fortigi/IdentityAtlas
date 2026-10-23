import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { CONTEXT_ROLE_TYPES } from '../../ingest/validation.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, '093_context_role_suggestion_rejections.sql'), 'utf8');
const statements = sql.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n');
const header = sql.split('\n').filter(line => line.trimStart().startsWith('--')).join('\n');

describe('migration 093 — rejected role suggestions', () => {
  it('creates exactly one table and touches nothing else', () => {
    expect(statements.match(/CREATE TABLE "(\w+)"/g)).toEqual(['CREATE TABLE "ContextRoleSuggestionRejections"']);
    expect(statements).not.toMatch(/ALTER TABLE|DROP |DELETE FROM|UPDATE "|INSERT INTO/);
  });

  it('cascades from the context and from either holder', () => {
    expect(statements).toMatch(/"contextId"\s+UUID NOT NULL REFERENCES "Contexts"\("id"\)\s+ON DELETE CASCADE/);
    expect(statements).toMatch(/"principalId" UUID\s+REFERENCES "Principals"\("id"\) ON DELETE CASCADE/);
    expect(statements).toMatch(/"identityId"\s+UUID\s+REFERENCES "Identities"\("id"\) ON DELETE CASCADE/);
  });

  it('holds exactly one holder, as ContextRoles does', () => {
    expect(statements).toMatch(/CHECK \(\("principalId" IS NULL\) <> \("identityId" IS NULL\)\)/);
  });

  it('accepts the same roles the ingest knows', () => {
    const roles = statements.match(/"role" IN \(([^)]+)\)/)[1].split(',').map(s => s.trim().replace(/'/g, ''));
    expect(roles).toEqual(CONTEXT_ROLE_TYPES);
  });

  it('stores one rejection per context, holder and role — the conflict target the route names', () => {
    for (const col of ['principalId', 'identityId']) {
      expect(statements).toMatch(new RegExp(
        `CREATE UNIQUE INDEX "\\w+"\\s+ON "ContextRoleSuggestionRejections" \\("contextId", "${col}",\\s+"role"\\) WHERE "${col}"\\s+IS NOT NULL`,
      ));
    }
    // No Accountable-only index: several Accountable candidates can be rejected.
    expect(statements).not.toMatch(/\("contextId"\) WHERE/);
  });

  it('records who rejected and when, and says it is interim until claims', () => {
    expect(statements).toMatch(/"rejectedBy"\s+TEXT,/);
    expect(statements).toMatch(/"rejectedAt"\s+TIMESTAMPTZ NOT NULL DEFAULT now\(\)/);
    expect(header).toMatch(/INTERIM/);
    expect(header).toMatch(/claims \(POC step 2\)/);
  });
});
