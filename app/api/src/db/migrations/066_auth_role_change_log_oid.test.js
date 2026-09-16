import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, '066_auth_role_change_log_oid.sql'), 'utf8');

// Text-level guard (the insert that uses the column is covered by
// routes/authRoles.lockout.test.js).
describe('migration 066 — AuthRoleChangeLog records the acting oid', () => {
  it('adds a nullable changedByOid column idempotently, without touching existing rows', () => {
    expect(sql).toMatch(/ALTER TABLE "AuthRoleChangeLog" ADD COLUMN IF NOT EXISTS "changedByOid" TEXT;/);
    expect(sql).not.toMatch(/NOT NULL/);
    expect(sql).not.toMatch(/\b(UPDATE|DELETE|DROP)\b/);
  });
});
