import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const code = readFileSync(join(__dirname, '119_identities_system_id.sql'), 'utf8').replace(/^\s*--.*$/gm, '');

describe('migration 119 — which source an identity belongs to (#1510)', () => {
  it('adds a nullable systemId, so an unclaimed identity needs no owner', () => {
    expect(code).toMatch(/ALTER TABLE "Identities" ADD COLUMN IF NOT EXISTS "systemId" INTEGER;/);
    expect(code).not.toMatch(/"systemId" INTEGER (NOT NULL|DEFAULT)/);
  });

  it('does not backfill: existing identities stay unclaimed, outside every reconcile', () => {
    expect(code).not.toMatch(/UPDATE\s+"Identities"/i);
  });

  it('keeps the people when their system is removed', () => {
    expect(code).toMatch(/REFERENCES "Systems"\("id"\) ON DELETE SET NULL/);
    expect(code).not.toMatch(/ON DELETE CASCADE/);
  });

  it('indexes the column the reconcile filters on', () => {
    expect(code).toMatch(/CREATE INDEX IF NOT EXISTS "ix_Identities_systemId" ON "Identities"\("systemId"\)/);
  });

  it('can run twice', () => {
    expect(code).toMatch(/DROP CONSTRAINT IF EXISTS "fk_Identities_systemId"/);
  });
});
