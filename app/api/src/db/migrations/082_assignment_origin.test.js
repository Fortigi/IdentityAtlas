import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ASSIGNMENT_ORIGINS } from '../../ingest/validation.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, '082_assignment_origin.sql'), 'utf8');
// Statements only: the header comment explains what the migration avoids, in
// the very words these assertions look for.
const statements = sql.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n');

describe('migration 082 — assignment origin', () => {
  it('admits exactly the origins the ingest accepts', () => {
    const list = statements.match(/CHECK \("origin" IN \(([^)]*)\)\)/)[1];
    const admitted = [...list.matchAll(/'([^']+)'/g)].map(m => m[1]);
    expect(admitted.sort()).toEqual([...ASSIGNMENT_ORIGINS].sort());
  });

  it('adds both columns nullable, with no default and no backfill', () => {
    const adds = statements.match(/ADD COLUMN[^;]*;/g);
    expect(adds).toHaveLength(2);
    for (const add of adds) {
      expect(add).toMatch(/ADD COLUMN IF NOT EXISTS "(origin|originDetail)"\s+TEXT;/);
    }
    expect(statements).not.toMatch(/\bUPDATE\b/i);
  });

  it('adds the check without scanning the table, and can be re-run', () => {
    expect(statements).toMatch(/DROP CONSTRAINT IF EXISTS "ck_ResourceAssignments_origin"/);
    expect(statements).toMatch(/CHECK \("origin" IN \([^)]*\)\) NOT VALID;/);
  });

  it('touches neither a key nor an index', () => {
    expect(statements).not.toMatch(/PRIMARY KEY|UNIQUE|CREATE INDEX/i);
  });
});
