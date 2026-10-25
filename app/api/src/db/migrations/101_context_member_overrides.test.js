// Static checks on migration 099. The SQL the feature runs against it is held
// against PostgreSQL in contract-tests/contextMemberOverrides.contract.test.js.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, '101_context_member_overrides.sql'), 'utf8');
const statements = sql.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n');

describe('migration 101 — a member marked former by a decision', () => {
  it('one mark per context and member, gone with its context or its claim', () => {
    expect(statements).toMatch(/CREATE TABLE "ContextMemberOverrides"/);
    expect(statements).toMatch(/UNIQUE \("contextId", "memberId"\)/);
    expect(statements).toMatch(/"contextId"\s+UUID NOT NULL REFERENCES "Contexts"\("id"\)\s+ON DELETE CASCADE/);
    expect(statements).toMatch(/"claimId"\s+UUID NOT NULL REFERENCES "ContextClaims"\("id"\) ON DELETE CASCADE/);
    expect(statements).toMatch(/"overrides"\s+TEXT NOT NULL/);
  });

  it('records every mark and its removal in _history', () => {
    expect(statements.match(/ON "ContextMemberOverrides"/g)).toHaveLength(5);
    expect(statements).toMatch(/AFTER INSERT OR DELETE ON "ContextMemberOverrides"/);
  });

  it('changes no row and never touches the members or the access', () => {
    expect(statements).not.toMatch(/DELETE FROM|UPDATE "|INSERT INTO|DROP TABLE|DROP COLUMN|ALTER TABLE/);
    expect(statements).not.toMatch(/"ContextMembers"|"ResourceAssignments"/);
  });
});
