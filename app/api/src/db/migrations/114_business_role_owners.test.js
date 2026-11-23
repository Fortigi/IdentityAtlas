import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, '114_business_role_owners.sql'), 'utf8').replace(/^\s*--.*$/gm, '');

describe('migration 114 — business role owners', () => {
  it('allows one Accountable per role and any number of Responsible', () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX "ux_BusinessRoleOwners_accountable" ON "BusinessRoleOwners" \("resourceId"\) WHERE "role" = 'Accountable'/);
  });

  it('requires exactly one holder', () => {
    expect(sql).toMatch(/CHECK \(\("principalId" IS NULL\) <> \("identityId" IS NULL\)\)/);
  });

  it('closes the role and source lists', () => {
    expect(sql).toMatch(/"role"\s+TEXT NOT NULL CHECK \("role" IN \('Accountable', 'Responsible'\)\)/);
    expect(sql).toMatch(/"addedBy"\s+TEXT NOT NULL CHECK \("addedBy" IN \('sync', 'import', 'analyst'\)\)/);
  });

  it('removes owners with their role and their holder', () => {
    expect(sql).toMatch(/"resourceId"\s+UUID NOT NULL REFERENCES "Resources"\("id"\)\s+ON DELETE CASCADE/);
    expect(sql).toMatch(/"principalId" UUID\s+REFERENCES "Principals"\("id"\) ON DELETE CASCADE/);
    expect(sql).toMatch(/"identityId"\s+UUID\s+REFERENCES "Identities"\("id"\) ON DELETE CASCADE/);
  });

  it('remembers a rejection once per role and person', () => {
    expect(sql).toMatch(/UNIQUE \("resourceId", "principalId", "role"\)/);
  });
});
