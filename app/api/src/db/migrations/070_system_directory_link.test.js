import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, '070_system_directory_link.sql'), 'utf8');

// Text-level guard. The behavioural proof — a real Postgres keeping a Principal on
// its directory across a dependent system's upsert — lives in
// app/api/contract-tests/directoryOwnership.contract.test.js. What this file stops
// is a phase being dropped or a guard being loosened, because each guard here is
// load-bearing in a way that is invisible when the migration runs on clean data.
describe('migration 070 — Systems.directorySystemId', () => {
  it('adds the column idempotently, as a self-referencing FK', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS "directorySystemId" INTEGER REFERENCES "Systems"\("id"\)/);
    // ON DELETE SET NULL, not CASCADE: removing the Entra system must not delete
    // the Azure RM system that merely reads from it.
    expect(sql).toMatch(/ON DELETE SET NULL/);
    expect(sql).not.toMatch(/"directorySystemId"[^;]*ON DELETE CASCADE/);
  });

  it('forbids a system being its own directory', () => {
    expect(sql).toContain('ck_Systems_directory_not_self');
    expect(sql).toMatch(/CHECK \("directorySystemId" IS NULL OR "directorySystemId" <> "id"\)/);
  });

  it('backfills only unambiguous tenants, and never links a directory to itself', () => {
    const backfill = sql.slice(sql.indexOf('UPDATE "Systems" d'), sql.indexOf('UPDATE "Principals" p'));
    expect(backfill).toContain(`s."systemType" = 'EntraID'`);
    // Without this the EntraID system matches itself as a dependent.
    expect(backfill).toContain(`d."systemType" <> 'EntraID'`);
    // Without this an already-set (or hand-set) link is silently overwritten.
    expect(backfill).toContain('d."directorySystemId" IS NULL');
    // Without this a tenant with two EntraID systems gets an arbitrary one.
    expect(backfill).toMatch(/count\(\*\)[\s\S]*=\s*1/);
  });

  it('repairs only rows the flip actually moved', () => {
    const repair = sql.slice(sql.indexOf('UPDATE "Principals" p'));
    // The history check is what makes this safe: a principal that never sat on the
    // directory (an Azure-RM-first stub for an account Entra has never seen) must
    // not be re-homed to a directory that does not know it.
    expect(repair).toContain('FROM "_history" h');
    expect(repair).toContain(`h."tableName" = 'Principals'`);
    expect(repair).toMatch(/h\."rowData"->>'systemId'\s*\)?\s*=\s*d\."directorySystemId"::text/);
    // A known orphan belongs to the dependent system by construction.
    expect(repair).toContain(`'directoryStatus', '') <> 'orphaned'`);
    // Only rows currently owned by a DEPENDENT system are candidates.
    expect(repair).toContain('d."directorySystemId" IS NOT NULL');
  });

  it('does not touch Resources', () => {
    // The ingest guard covers Resources too, but no shipped crawler has ever
    // stamped another system's Resource, so there is nothing to repair — and a
    // speculative UPDATE over Resources would be a much bigger blast radius.
    expect(sql).not.toMatch(/UPDATE "Resources"/);
  });
});
