import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { CONTEXT_CATEGORIES } from '../../ingest/validation.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const code = readFileSync(join(__dirname, '117_catalogs_as_contexts.sql'), 'utf8').replace(/^\s*--.*$/gm, '');

describe('migration 117 — catalogs become contexts', () => {
  it('widens the template CHECK to exactly the list the ingest enforces', () => {
    const list = code.match(/"contextCategory" IN \(([^)]+)\)/)[1].split(',').map(s => s.trim().replace(/^'|'$/g, ''));
    expect(list).toEqual(CONTEXT_CATEGORIES);
    expect(list).toContain('Catalog');
  });

  it('replaces the CHECK by the name PostgreSQL gave the inline one of migration 095', () => {
    expect(code).toMatch(/DROP CONSTRAINT IF EXISTS "Contexts_contextCategory_check";/);
    expect(code).toMatch(/ADD CONSTRAINT "Contexts_contextCategory_check"/);
  });

  it('drops the old catalog table and the pointer on Resources, without converting rows', () => {
    expect(code).toMatch(/ALTER TABLE "Resources" DROP COLUMN IF EXISTS "catalogId";/);
    expect(code).toMatch(/DROP TABLE IF EXISTS "GovernanceCatalogs";/);
    expect(code).not.toMatch(/INSERT INTO "Contexts"/);
  });
});
