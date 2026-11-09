import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, '092_account_linking_name_only.sql'), 'utf8');
const statements = sql.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n');

describe('migration 092 — account-linking name-only reporting', () => {
  it('adds exactly the three columns the run writes, with their types', () => {
    const added = [...statements.matchAll(/ADD COLUMN IF NOT EXISTS "(\w+)"\s+(\w+);/g)]
      .map(m => [m[1], m[2]]);
    expect(Object.fromEntries(added)).toEqual({
      nameOnlyMatches: 'INT',
      linksRemoved: 'INT',
      nameOnlySuggestions: 'JSONB',
    });
  });

  it('leaves them nullable: no default, no NOT NULL, no backfill', () => {
    // A pre-feature run must stay distinguishable from a run that looked and found none,
    // so NULL is the carrier of "not measured" -- defaulting to 0 would fake the answer
    // for every historical row.
    expect(statements).not.toMatch(/DEFAULT|NOT NULL|\bUPDATE\b/i);
  });

  it('only touches AccountLinkingRuns, and adds no index', () => {
    expect(statements.match(/ALTER TABLE "(\w+)"/g))
      .toEqual(['ALTER TABLE "AccountLinkingRuns"', 'ALTER TABLE "AccountLinkingRuns"',
        'ALTER TABLE "AccountLinkingRuns"']);
    expect(statements).not.toMatch(/CREATE INDEX/i);
  });
});
