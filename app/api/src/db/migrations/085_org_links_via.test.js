import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, '085_org_links_via.sql'), 'utf8');
const statements = sql.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n');

describe('migration 085 — org links remember their attribute', () => {
  it('adds exactly via and orgValue to OrgLinks, nullable, no default, no backfill', () => {
    const added = [...statements.matchAll(/ALTER TABLE "OrgLinks" ADD COLUMN IF NOT EXISTS "(\w+)"\s+TEXT;/g)].map(m => m[1]);
    expect(added.sort()).toEqual(['orgValue', 'via']);
    expect(statements).not.toMatch(/DEFAULT|NOT NULL|\bUPDATE\b|CREATE INDEX/i);
    expect(statements.match(/ALTER TABLE "(\w+)"/g).every(s => s === 'ALTER TABLE "OrgLinks"')).toBe(true);
  });
});
