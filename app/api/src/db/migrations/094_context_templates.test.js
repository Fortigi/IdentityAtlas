import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { CONTEXT_CATEGORIES, CONTEXT_ROLE_TYPES, CONTEXT_RELATIONSHIP_TYPES, CONTEXT_MEMBER_ADDED_BY } from '../../ingest/validation.js';
import { REGISTERED_PLUGINS } from '../../contexts/plugins/registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, '094_context_templates.sql'), 'utf8');
const statements = sql.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n');
const inList = (re) => statements.match(re)[1].split(',').map(s => s.trim().replace(/^'|'$/g, ''));
// The backfill CASE only, so the GraphTags view's own CASE does not count.
const backfill = statements.slice(statements.indexOf('SET "contextCategory" = CASE'), statements.indexOf('ix_Contexts_contextCategory'));

describe('migration 094 — context templates', () => {
  it('adds the nullable template column with exactly the four templates the ingest knows', () => {
    expect(statements).toMatch(/ADD COLUMN "contextCategory" TEXT\s+CHECK/);
    expect(statements).not.toMatch(/"contextCategory" TEXT NOT NULL/);
    expect(inList(/"contextCategory" IN \(([^)]+)\)/)).toEqual(CONTEXT_CATEGORIES);
  });

  it('creates the two edge tables with the lists the ingest enforces', () => {
    expect(statements.match(/CREATE TABLE "(\w+)"/g)).toEqual(['CREATE TABLE "ContextRoles"', 'CREATE TABLE "ContextRelationships"']);
    expect(inList(/"role" IN \(([^)]+)\)/)).toEqual(CONTEXT_ROLE_TYPES);
    expect(inList(/"relationshipType" IN \(([^)]+)\)/)).toEqual(CONTEXT_RELATIONSHIP_TYPES);
    // 105 widened all three addedBy CHECKs with 'sourceOwner' (its own test pins that).
    for (const list of [...statements.matchAll(/"addedBy" IN \(([^)]+)\)/g)]) {
      expect(list[1].split(',').map(s => s.trim().replace(/'/g, ''))).toEqual(CONTEXT_MEMBER_ADDED_BY.filter(v => v !== 'sourceOwner'));
    }
  });

  it('allows one Accountable per context and one holder per row, and never two holders', () => {
    expect(statements).toMatch(/CREATE UNIQUE INDEX "ux_ContextRoles_accountable" ON "ContextRoles" \("contextId"\) WHERE "role" = 'Accountable'/);
    expect(statements).toMatch(/CHECK \(\("principalId" IS NULL\) <> \("identityId" IS NULL\)\)/);
    expect(statements).toMatch(/CHECK \("contextId" <> "relatedContextId"\)/);
  });

  it('retires every root type a plugin used to write, and only those', () => {
    const retired = [...statements.matchAll(/WHERE "contextType" = '(\w+)';/g)].map(m => m[1]).sort();
    expect(retired).toEqual(['EntraGroupRoot', 'PrincipalTypeRoot', 'ResourceTypeRoot', 'ScopeHierarchy', 'SystemMembershipRoot', 'TagGroup']);
    // No registered plugin still declares one of them.
    const declared = new Set(REGISTERED_PLUGINS.flatMap(p => p.contextTypes));
    expect(retired.filter(t => declared.has(t))).toEqual([]);
    expect(statements).toMatch(/'\{"tagRoot": true\}'::jsonb\s+WHERE "contextType" = 'TagGroup'/);
  });

  it('backfills a template for every type a registered plugin writes', () => {
    const mapped = new Set([...backfill.matchAll(/WHEN '(\w+)'\s+THEN '(\w+)'/g)].map(m => m[1]));
    const written = REGISTERED_PLUGINS.flatMap(p => p.contextTypes);
    expect(written.filter(t => !mapped.has(t))).toEqual([]);
    // …and only onto the four templates.
    const targets = new Set([...backfill.matchAll(/THEN '(\w+)'/g)].map(m => m[1]));
    expect([...targets].filter(t => !CONTEXT_CATEGORIES.includes(t))).toEqual([]);
  });

  it('states the manager of every manager-hierarchy node as its Accountable, matched by principal id', () => {
    expect(statements).toMatch(/INSERT INTO "ContextRoles" \("contextId", "principalId", "role", "addedBy"\)\s+SELECT c\.id, p\.id, 'Accountable', 'algorithm'/);
    expect(statements).toMatch(/JOIN "Principals" p ON p\.id::text = c\."externalId"/);
    expect(statements).toMatch(/WHERE name = 'manager-hierarchy'/);
  });

  it('keeps the tag root out of the GraphTags view', () => {
    expect(statements).toMatch(/CREATE OR REPLACE VIEW "GraphTags"/);
    expect(statements).toMatch(/AND COALESCE\(c\."extendedAttributes"->>'tagRoot', 'false'\) <> 'true'/);
    expect(statements).not.toMatch(/GraphTagAssignments/);
  });

  it('drops no table, column or view, deletes no rows and never touches assignments', () => {
    // DROP TRIGGER IF EXISTS is how the history triggers are (re)attached; nothing else is dropped.
    expect(statements).not.toMatch(/DROP (TABLE|COLUMN|VIEW|INDEX)|DELETE FROM|ResourceAssignments|assignmentType/);
    expect([...statements.matchAll(/DROP (\w+)/g)].map(m => m[1])).toEqual(['TRIGGER', 'TRIGGER', 'TRIGGER']);
  });
});

describe('migration 094 — the backfill is the one mapping the ingest derives from', () => {
  it('maps every known contextType to the same template as lib/contextCategories.js', async () => {
    const { CONTEXT_TYPE_CATEGORY } = await import('../../lib/contextCategories.js');
    const sqlMap = Object.fromEntries([...backfill.matchAll(/WHEN '(\w+)'\s+THEN '(\w+)'/g)].map(m => [m[1], m[2]]));
    expect(sqlMap).toEqual(CONTEXT_TYPE_CATEGORY);
  });
});

describe('migration 094 — history on the new tables', () => {
  it('records every change to context roles and relationships in _history', () => {
    for (const table of ['ContextRoles', 'ContextRelationships']) {
      expect(statements).toMatch(new RegExp(`AFTER INSERT OR DELETE ON "${table}"\\s+FOR EACH ROW EXECUTE FUNCTION fg_record_history\\(\\)`));
    }
    expect(statements).toMatch(/AFTER UPDATE ON "ContextRoles"\s+FOR EACH ROW\s+WHEN \(OLD IS DISTINCT FROM NEW\)/);
  });
});

describe('migration 094 — SameUnitAs is symmetric', () => {
  it('stores a pair once whichever way round it was posted', () => {
    expect(statements).toMatch(/CREATE UNIQUE INDEX "ux_ContextRelationships_pair" ON "ContextRelationships"\s+\(LEAST\("contextId", "relatedContextId"\), GREATEST\("contextId", "relatedContextId"\), "relationshipType"\)/);
    // The ordered-triple constraint is gone: (a,b) and (b,a) must collide.
    expect(statements).not.toMatch(/ux_ContextRelationships_triple/);
  });

  // An upgrade has rows in Contexts: the UPDATEs queue the deferred cycle check
  // (migration 059), and DDL on Contexts with pending trigger events fails.
  // The flush must sit after the last UPDATE of Contexts and before the first
  // DDL that touches it (the index, then the tables that reference it).
  it('runs the queued deferred checks before any DDL on Contexts that follows its UPDATEs', () => {
    const flush = statements.indexOf('SET CONSTRAINTS ALL IMMEDIATE;');
    const lastUpdate = statements.lastIndexOf('UPDATE "Contexts"');
    const index = statements.indexOf('CREATE INDEX "ix_Contexts_contextCategory"');
    const firstReference = statements.indexOf('REFERENCES "Contexts"');
    expect(flush).toBeGreaterThan(lastUpdate);
    expect(flush).toBeLessThan(index);
    expect(flush).toBeLessThan(firstReference);
  });
});
