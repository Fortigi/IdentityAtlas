import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, '087_org_links_unique_per_attribute.sql'), 'utf8');
const statements = sql.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n');

describe('migration 087 — one link per entity, target and attribute', () => {
  it('drops the unique constraints of OrgLinks by lookup and makes via part of the uniqueness', () => {
    expect(statements).toMatch(/rel\.relname = 'OrgLinks' AND con\.contype = 'u'/);
    expect(statements).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "ux_OrgLinks_entity_target_via"\s+ON "OrgLinks" \("orgEntityId", "targetType", "targetId", \(COALESCE\("via", ''\)\)\)/);
  });

  it('the upserts use the same conflict target', async () => {
    const run = readFileSync(join(__dirname, '../../orgtruth/linking/run.js'), 'utf8');
    const review = readFileSync(join(__dirname, '../../orgtruth/linking/review.js'), 'utf8');
    const target = 'ON CONFLICT ("orgEntityId", "targetType", "targetId", (COALESCE("via", \'\')))';
    expect(run).toContain(target);
    expect(review).toContain(target);
  });
});
