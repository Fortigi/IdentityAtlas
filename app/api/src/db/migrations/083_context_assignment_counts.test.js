import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { COUNT_COLUMNS } from '../../contexts/assignmentCounts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, '083_context_assignment_counts.sql'), 'utf8');
const statements = sql.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n');

describe('migration 083 — context assignment counts', () => {
  it('adds exactly the columns the refresh writes', () => {
    const added = [...statements.matchAll(/ADD COLUMN IF NOT EXISTS "(\w+)"\s+INTEGER;/g)].map(m => m[1]);
    expect(added.sort()).toEqual([...COUNT_COLUMNS].sort());
  });

  it('leaves them empty: no default, no NOT NULL, no backfill', () => {
    // "Not calculated" has to stay distinguishable from "calculated, and zero".
    expect(statements).not.toMatch(/DEFAULT|NOT NULL|\bUPDATE\b/i);
  });

  it('only touches Contexts, and adds no index', () => {
    expect(statements.match(/ALTER TABLE "(\w+)"/g).every(s => s === 'ALTER TABLE "Contexts"')).toBe(true);
    expect(statements).not.toMatch(/CREATE INDEX/i);
  });
});
