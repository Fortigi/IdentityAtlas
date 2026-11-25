import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const code = readFileSync(join(__dirname, '118_identity_manager_source.sql'), 'utf8').replace(/^\s*--.*$/gm, '');

describe('migration 118 — how a person\'s manager was set', () => {
  it('adds a nullable marker column, so "no manager" needs no value', () => {
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS "managerIdentitySource" TEXT;/);
    expect(code).not.toMatch(/"managerIdentitySource" TEXT (NOT NULL|DEFAULT)/);
  });

  it('closes the list to exactly Source and Derived', () => {
    expect(code).toMatch(/CHECK \("managerIdentitySource" IN \('Source', 'Derived'\)\)/);
  });

  it('marks every manager that exists today as sent by the source, and only those', () => {
    expect(code).toMatch(/SET "managerIdentitySource" = 'Source'\s+WHERE "managerIdentityId" IS NOT NULL AND "managerIdentitySource" IS NULL/);
  });

  it('can run twice', () => {
    expect(code).toMatch(/DROP CONSTRAINT IF EXISTS "ck_Identities_managerIdentitySource"/);
  });
});
