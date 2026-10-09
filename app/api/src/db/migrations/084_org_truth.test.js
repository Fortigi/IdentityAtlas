import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { SOURCE_KINDS, ORIGINS, CLAIM_STATUSES, RUN_MODES, LINK_TARGETS } from '../../orgtruth/contracts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, '084_org_truth.sql'), 'utf8');
const statements = sql.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n');

const quoted = (list) => list.map(v => `'${v}'`).join(',');
const checkFor = (table, column) => {
  const block = statements.slice(statements.indexOf(`CREATE TABLE IF NOT EXISTS "${table}"`));
  const line = block.split('\n').find(l => l.includes(`"${column}"`) && l.includes(`CHECK ("${column}" IN (`));
  const m = line?.match(/ IN \(([^)]*)\)/);
  return m ? m[1] : null;
};

describe('migration 084 — organisation truth', () => {
  it('creates the six tables', () => {
    for (const t of ['OrgSources', 'OrgImportProfiles', 'OrgImportRuns', 'OrgEntities', 'OrgRelations', 'OrgLinks']) {
      expect(statements).toContain(`CREATE TABLE IF NOT EXISTS "${t}"`);
    }
  });

  it('uses the same closed lists as contracts.js', () => {
    expect(checkFor('OrgSources', 'kind')).toBe(quoted(SOURCE_KINDS));
    expect(checkFor('OrgImportProfiles', 'sourceKind')).toBe(quoted(SOURCE_KINDS));
    expect(checkFor('OrgImportRuns', 'mode')).toBe(quoted(RUN_MODES));
    for (const t of ['OrgEntities', 'OrgRelations', 'OrgLinks']) {
      expect(checkFor(t, 'origin')).toBe(quoted(ORIGINS));
      expect(checkFor(t, 'status')).toBe(quoted(CLAIM_STATUSES));
    }
    expect(checkFor('OrgLinks', 'targetType').split(',').sort()).toEqual(quoted(Object.keys(LINK_TARGETS)).split(',').sort());
  });

  it('claims default to accepted, links default to proposed', () => {
    const entities = statements.slice(statements.indexOf('"OrgEntities"'), statements.indexOf('"OrgRelations"'));
    const links = statements.slice(statements.indexOf('CREATE TABLE IF NOT EXISTS "OrgLinks"'));
    expect(entities).toMatch(/"status"\s+TEXT NOT NULL DEFAULT 'accepted'/);
    expect(links).toMatch(/"status"\s+TEXT NOT NULL DEFAULT 'proposed'/);
  });

  it('keeps one open entity per profile, type and key', () => {
    expect(statements).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "ix_OrgEntities_current_key"\s+ON "OrgEntities"\("profileId", "entityType", "canonicalKey"\)\s+WHERE "validTo" IS NULL/);
  });

  it('attaches the history triggers to the four audited tables and nothing else', () => {
    const audited = statements.match(/FOREACH t IN ARRAY ARRAY\[([^\]]*)\]/)[1].split(',').map(s => s.replace(/'/g, ''));
    expect(audited).toEqual(['OrgEntities', 'OrgRelations', 'OrgLinks', 'OrgImportProfiles']);
    // The original upload is immutable and can be large: no history row per source.
    expect(audited).not.toContain('OrgSources');
    expect(audited).not.toContain('OrgImportRuns');
  });

  it('never deletes or rewrites existing data', () => {
    expect(statements).not.toMatch(/\b(DROP TABLE|DELETE FROM|UPDATE "|ALTER TABLE)\b/);
  });
});
