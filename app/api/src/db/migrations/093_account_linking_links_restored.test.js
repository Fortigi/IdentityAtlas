import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, '093_account_linking_links_restored.sql'), 'utf8');
const statements = sql.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n');

describe('migration 093 — account-linking restored-links counter', () => {
  it('adds exactly the one column the run writes, with its type', () => {
    const added = [...statements.matchAll(/ADD COLUMN IF NOT EXISTS "(\w+)"\s+(\w+);/g)]
      .map(m => [m[1], m[2]]);
    expect(Object.fromEntries(added)).toEqual({ linksRestored: 'INT' });
  });

  it('leaves it nullable: no default, no NOT NULL, no backfill', () => {
    // A run from before the level-scoped guard restored nothing *and measured
    // nothing*; defaulting to 0 would make every historical row claim the
    // former, which is the one statement the completion notice turns on.
    expect(statements).not.toMatch(/DEFAULT|NOT NULL|\bUPDATE\b/i);
  });

  it('only touches AccountLinkingRuns, and adds no index', () => {
    expect(statements.match(/ALTER TABLE "(\w+)"/g)).toEqual(['ALTER TABLE "AccountLinkingRuns"']);
    expect(statements).not.toMatch(/CREATE INDEX/i);
  });
});
