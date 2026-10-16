import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { LINK_TARGETS } from '../../orgtruth/contracts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, '086_org_links_org_entity.sql'), 'utf8');
const statements = sql.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n');

describe('migration 086 — org entity as a link target', () => {
  it('allows exactly the link target types contracts.js declares', () => {
    const m = statements.match(/CHECK \("targetType" IN \(([^)]*)\)\)/);
    expect(m[1].split(',').map(s => s.replace(/'/g, '')).sort()).toEqual(Object.keys(LINK_TARGETS).sort());
  });

  it('drops the old targetType check by looking its name up, and touches only OrgLinks', () => {
    expect(statements).toMatch(/pg_get_constraintdef\(con\.oid\) LIKE '%targetType%'/);
    expect(statements.match(/ALTER TABLE "(\w+)"/g).every(s => s === 'ALTER TABLE "OrgLinks"')).toBe(true);
    expect(statements).not.toMatch(/\b(UPDATE|DELETE FROM|DROP TABLE)\b/);
  });
});
