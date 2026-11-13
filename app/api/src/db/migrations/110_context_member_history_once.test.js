// Static checks on migration 110. What the trigger records after it is verified
// against PostgreSQL in contract-tests/unitTimeline.contract.test.js.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, '110_context_member_history_once.sql'), 'utf8');
const statements = sql.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n');

describe('migration 110 — a leave is stored once', () => {
  it('a delete keeps the member in rowData and leaves prevData empty', () => {
    expect(statements).toMatch(/VALUES \(TG_TABLE_NAME, OLD\."contextId"::text, 'D', to_jsonb\(OLD\), NULL\)/);
    expect(statements).not.toMatch(/to_jsonb\(OLD\), to_jsonb\(OLD\)/);
  });

  it('an insert is recorded as before', () => {
    expect(statements).toMatch(/VALUES \(TG_TABLE_NAME, NEW\."contextId"::text, 'I', to_jsonb\(NEW\), NULL\)/);
  });

  it('replaces the function only: no table, trigger or index changes', () => {
    expect(statements).toMatch(/CREATE OR REPLACE FUNCTION fg_record_context_member_history\(\)/);
    expect(statements).not.toMatch(/CREATE TABLE|ALTER TABLE|DROP |CREATE TRIGGER|CREATE INDEX|DELETE FROM/);
  });

  it('clears only the duplicate copy on the ContextMembers leaves 109 wrote', () => {
    const updates = statements.match(/UPDATE "_history"[\s\S]*?;/g);
    expect(updates).toHaveLength(1);
    const [u] = updates;
    expect(u).toMatch(/SET "prevData" = NULL/);
    expect(u).toMatch(/"tableName" = 'ContextMembers'/);
    expect(u).toMatch(/operation = 'D'/);
    expect(u).toMatch(/"prevData" = "rowData"/);
    expect(u).not.toMatch(/"rowData" =\s*NULL|SET "rowData"/);
  });
});
