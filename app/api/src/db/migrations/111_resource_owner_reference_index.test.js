// Static checks on migration 111. That the reverse owner lookup returns the right
// resources is verified against PostgreSQL in
// contract-tests/resourceOwnership.contract.test.js.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, '111_resource_owner_reference_index.sql'), 'utf8');
const statements = sql.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n');

describe('migration 111 — index on the owner reference of a resource', () => {
  it('indexes the same expression the reverse owner lookup filters on', () => {
    expect(statements).toMatch(/ON "Resources" \(\("extendedAttributes"->>'ownerId'\)\)/);
  });

  it('is partial: resources without the attribute are not indexed', () => {
    expect(statements).toMatch(/WHERE \("extendedAttributes"->>'ownerId'\) IS NOT NULL;/);
  });

  it('can run again and changes nothing else', () => {
    expect(statements).toMatch(/CREATE INDEX IF NOT EXISTS "ix_Resources_ownerIdReference"/);
    expect(statements.match(/;/g)).toHaveLength(1);
    expect(statements).not.toMatch(/CREATE TABLE|ALTER TABLE|DROP |UPDATE |DELETE FROM|INSERT INTO/);
  });
});
