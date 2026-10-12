import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { MENTION_ENTITY_TYPES, FINDING_KINDS, FINDING_STATUSES, SUPPORT } from '../../orgtruth/knowledge/contracts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, '089_org_knowledge_extraction.sql'), 'utf8');
const statements = sql.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n');
const tableBody = (name) => {
  const start = statements.indexOf(`CREATE TABLE IF NOT EXISTS "${name}" (`);
  return start < 0 ? '' : statements.slice(start, statements.indexOf('\n);', start));
};
const listIn = (text, column) => {
  const marker = `CHECK ("${column}" IN (`;
  const at = text.indexOf(marker);
  return text.slice(at + marker.length, text.indexOf(')', at + marker.length)).split(',').map(s => s.trim().replace(/'/g, ''));
};

describe('migration 089 — knowledge extraction', () => {
  it('a run can be an extraction and can end cancelled, without breaking a re-run of the migration', () => {
    expect(listIn(statements, 'mode')).toEqual(['full', 'delta', 'extract']);
    expect(listIn(statements, 'status')).toEqual(['queued', 'running', 'completed', 'failed', 'cancelled']);
    expect(statements).toMatch(/DROP CONSTRAINT IF EXISTS "OrgImportRuns_mode_check"/);
    expect(statements).toMatch(/DROP CONSTRAINT IF EXISTS "ck_OrgImportRuns_mode"/);
    expect(statements).toMatch(/ADD COLUMN IF NOT EXISTS "details" JSONB/);
    expect(statements).toMatch(/ADD COLUMN IF NOT EXISTS "cancelRequested" BOOLEAN NOT NULL DEFAULT false/);
  });

  it('evidence: a quote by offsets, a verdict from the contracts, gone with its statement or source', () => {
    const ev = tableBody('OrgClaimEvidence');
    expect(ev).toMatch(/"relationId"\s+UUID NOT NULL REFERENCES "OrgRelations"\("id"\) ON DELETE CASCADE/);
    expect(ev).toMatch(/"sourceId"\s+UUID NOT NULL REFERENCES "OrgSources"\("id"\) ON DELETE CASCADE/);
    expect(ev).toMatch(/UNIQUE \("relationId", "startChar", "endChar"\)/);
    expect(listIn(ev, 'support')).toEqual([...SUPPORT, 'unchecked']);
  });

  it('passages are unique per source and sequence number', () => {
    expect(tableBody('OrgSourcePassages')).toMatch(/UNIQUE \("sourceId", "seq"\)/);
  });

  it('findings use the contract lists and are keyed for idempotency', () => {
    const f = tableBody('OrgKnowledgeFindings');
    expect(listIn(f, 'kind')).toEqual([...FINDING_KINDS]);
    expect(listIn(f, 'status')).toEqual([...FINDING_STATUSES]);
    expect(f).toMatch(/UNIQUE \("sourceId", "findingKey"\)/);
  });

  it('re-running extraction updates mentions and statements instead of duplicating them', () => {
    expect(statements).toMatch(/"ux_OrgEntities_source_mention"\s+ON "OrgEntities"\("sourceId", "entityType", "canonicalKey"\)\s+WHERE "profileId" IS NULL AND "origin" = 'model' AND "canonicalKey" IS NOT NULL/);
    expect(statements).toMatch(/"ux_OrgRelations_source_claim"\s+ON "OrgRelations"\("sourceId", \("attributes"->>'claimKey'\)\)/);
  });

  it('every review decision is in _history', () => {
    expect(statements).toMatch(/ARRAY\['OrgClaimEvidence','OrgKnowledgeFindings'\]/);
    expect(statements).toContain('fg_record_history()');
  });

  it('mention types are prefixed so they never collide with a list type', () => {
    for (const t of Object.values(MENTION_ENTITY_TYPES)) expect(t.startsWith('Mentioned ')).toBe(true);
  });
});
