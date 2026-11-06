// Static checks on migration 105. What it does to rows — the relabel, the
// DedicatedTo conversion, a pair stored both ways — is verified against
// PostgreSQL in contract-tests/contextRepairs.contract.test.js; these pin the
// shape that keeps it safe to run on any database, more than once.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { OWNER_ADDED_BY } from '../../ingest/contextOwners.js';
import { CONTEXT_MEMBER_ADDED_BY } from '../../ingest/validation.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, '105_context_repairs.sql'), 'utf8');
const statements = sql.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n');
const squash = (s) => s.replace(/\s+/g, ' ').trim();

describe('migration 105 — the owner marker and the old-092 repair', () => {
  it('admits the reconcile\'s own addedBy on all three tables of the shared value scheme', () => {
    for (const table of ['ContextMembers', 'ContextRoles', 'ContextRelationships']) {
      expect(squash(statements)).toContain(
        `ALTER TABLE "${table}" ADD CONSTRAINT "${table}_addedBy_check" CHECK ("addedBy" IN ('sync', 'algorithm', 'analyst', '${OWNER_ADDED_BY}')) NOT VALID;`);
      const list = statements.match(new RegExp(`\"${table}_addedBy_check\"\\s+CHECK \\(\"addedBy\" IN \\(([^)]+)\\)`))[1];
      expect(list.split(',').map(s => s.trim().replace(/'/g, ''))).toEqual(CONTEXT_MEMBER_ADDED_BY);
      expect(squash(statements)).toContain(`ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "${table}_addedBy_check";`);
    }
  });

  it('relabels only sync Accountables on synced contexts that name an owner', () => {
    const update = squash(statements.slice(statements.indexOf('UPDATE "ContextRoles"'), statements.indexOf('ALTER TABLE "ContextRelationships" DROP CONSTRAINT IF EXISTS "ContextRelationships_relationshipType_check"')));
    expect(update).toContain(`SET "addedBy" = '${OWNER_ADDED_BY}'`);
    for (const cond of [`r.role = 'Accountable'`, `r."addedBy" = 'sync'`, `c.variant = 'synced'`, `NULLIF(c."ownerUserId", '') IS NOT NULL`]) {
      expect(update).toContain(cond);
    }
  });

  it('converts DedicatedTo before it narrows the CHECK to SameUnitAs', () => {
    const convert = statements.indexOf(`SET "relationshipType" = 'SameUnitAs' WHERE "relationshipType" = 'DedicatedTo'`);
    const narrow = statements.indexOf(`CHECK ("relationshipType" IN ('SameUnitAs'))`);
    expect(convert).toBeGreaterThan(statements.indexOf('DROP CONSTRAINT IF EXISTS "ContextRelationships_relationshipType_check"'));
    expect(narrow).toBeGreaterThan(convert);
  });

  it('drops a pair stored both ways round before the unordered-pair index is built', () => {
    const del = statements.indexOf('DELETE FROM "ContextRelationships"');
    const idx = statements.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS "ux_ContextRelationships_pair"');
    expect(del).toBeGreaterThan(-1);
    expect(idx).toBeGreaterThan(del);
    expect(statements).toMatch(/\(r\."createdAt", r\.id\) > \(o\."createdAt", o\.id\)/);
    expect(statements).toContain('DROP CONSTRAINT IF EXISTS "ux_ContextRelationships_triple"');
  });

  it('is re-runnable: every DDL step is IF EXISTS / IF NOT EXISTS or a drop-and-recreate', () => {
    expect(statements).not.toMatch(/CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/);
    expect(statements).not.toMatch(/DROP (CONSTRAINT|TRIGGER) (?!IF EXISTS)/);
    expect(statements.match(/CREATE TRIGGER/g)).toHaveLength(3);
    expect(statements.match(/DROP TRIGGER IF EXISTS/g)).toHaveLength(3);
  });

  it('never writes Contexts, and settles deferred checks before the index DDL', () => {
    expect(statements).not.toMatch(/(INSERT INTO|UPDATE|DELETE FROM)\s+"Contexts"/);
    expect(statements.indexOf('SET CONSTRAINTS ALL IMMEDIATE')).toBeLessThan(statements.indexOf('CREATE UNIQUE INDEX'));
  });
});
