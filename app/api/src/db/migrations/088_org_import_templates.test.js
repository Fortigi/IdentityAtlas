import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { TEMPLATES } from '../../orgtruth/templates.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, '088_org_import_templates.sql'), 'utf8');
const statements = sql.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n');

const tableBody = (name) => {
  const start = statements.indexOf(`CREATE TABLE IF NOT EXISTS "${name}" (`);
  return start < 0 ? '' : statements.slice(start, statements.indexOf('\n);', start));
};

describe('migration 088 — import templates and activities', () => {
  it('adds the template column defaulting to collection, checked against exactly the four templates', () => {
    expect(statements).toMatch(/ALTER TABLE "OrgImportProfiles"\s+ADD COLUMN IF NOT EXISTS "template" TEXT NOT NULL DEFAULT 'collection';/);
    const check = statements.match(/CHECK \("template" IN \(([^)]*)\)\)/)[1];
    expect(check.split(',').map(s => s.trim().replace(/'/g, ''))).toEqual(TEMPLATES);
    // re-running the migration must not fail on the existing constraint
    expect(statements).toMatch(/EXCEPTION WHEN duplicate_object THEN NULL/);
  });

  it('keys are unique per profile name, role and raw value, and decisions default to unmatched/not overridden', () => {
    const keys = tableBody('OrgActivityKeys');
    expect(keys).toMatch(/UNIQUE \("profileName", "role", "rawValue"\)/);
    expect(keys).toMatch(/"role"\s+TEXT NOT NULL CHECK \("role" IN \('actor','subject'\)\)/);
    expect(keys).toMatch(/"status"\s+TEXT NOT NULL DEFAULT 'unmatched' CHECK \("status" IN \('proposed','accepted','rejected','unmatched'\)\)/);
    expect(keys).toMatch(/"analystOverride" BOOLEAN NOT NULL DEFAULT false/);
    expect(keys).toMatch(/"targetType"\s+TEXT CHECK \("targetType" IN \('Principal','Identity','Resource','OrgEntity'\)\)/);
  });

  it('activities cascade with their source and survive a deleted key, profile or run', () => {
    const acts = tableBody('OrgActivities');
    expect(acts).toMatch(/"sourceId"\s+UUID NOT NULL REFERENCES "OrgSources"\("id"\) ON DELETE CASCADE/);
    expect(acts).toMatch(/"actorKeyId"\s+UUID REFERENCES "OrgActivityKeys"\("id"\) ON DELETE SET NULL/);
    expect(acts).toMatch(/"subjectKeyId"\s+UUID REFERENCES "OrgActivityKeys"\("id"\) ON DELETE SET NULL/);
    expect(acts).toMatch(/"profileId"\s+UUID REFERENCES "OrgImportProfiles"\("id"\) ON DELETE SET NULL/);
    expect(acts).toMatch(/"runId"\s+UUID REFERENCES "OrgImportRuns"\("id"\) ON DELETE SET NULL/);
    expect(acts).toMatch(/"occurredOn"\s+DATE NOT NULL/);
  });

  it('indexes the subject and actor timelines and the accepted targets', () => {
    expect(statements).toContain('ON "OrgActivities" ("subjectKeyId", "occurredOn")');
    expect(statements).toContain('ON "OrgActivities" ("actorKeyId", "occurredOn")');
    expect(statements).toMatch(/ON "OrgActivityKeys" \("targetType", "targetId"\) WHERE "status" = 'accepted'/);
  });
});
