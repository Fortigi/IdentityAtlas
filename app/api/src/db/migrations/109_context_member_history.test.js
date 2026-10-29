// Static checks on migration 109. What the trigger records is verified against
// PostgreSQL in contract-tests/unitTimeline.contract.test.js.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, '109_context_member_history.sql'), 'utf8');
const statements = sql.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n');

describe('migration 109 — context membership history', () => {
  it('changes no table and no row: one function and one trigger', () => {
    expect(statements).not.toMatch(/CREATE TABLE|ALTER TABLE|DELETE FROM|UPDATE "|DROP TABLE|DROP COLUMN|CREATE INDEX/);
    expect(statements.match(/CREATE TRIGGER \w+/g)).toEqual(['CREATE TRIGGER trg_history_ins_del']);
  });

  it('records joins and leaves only, never an update', () => {
    expect(statements).toMatch(/AFTER INSERT OR DELETE ON "ContextMembers"/);
    expect(statements).not.toMatch(/AFTER UPDATE ON "ContextMembers"/);
  });

  it('keys each row by the context, so the context timeline finds it by index', () => {
    expect(statements.match(/"contextId"::text/g)).toHaveLength(2);
    expect(statements).toMatch(/VALUES \(TG_TABLE_NAME, OLD\."contextId"::text, 'D'/);
    expect(statements).toMatch(/VALUES \(TG_TABLE_NAME, NEW\."contextId"::text, 'I'/);
  });
});
