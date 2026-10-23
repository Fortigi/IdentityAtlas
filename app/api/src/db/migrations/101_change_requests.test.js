// Static checks on migration 101. What the feature writes into it is verified
// against PostgreSQL in contract-tests/changeRequests.contract.test.js.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { CHANGE_KINDS, CHANGE_STATUSES } from '../../contexts/changeRequests.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, '101_change_requests.sql'), 'utf8');
const statements = sql.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n');
const inList = (column) => statements.match(new RegExp(`"${column}" IN \\(([^)]+)\\)`))[1].split(',').map(s => s.trim().replace(/'/g, ''));

describe('migration 101 — change requests', () => {
  it('creates one table and writes no rows', () => {
    expect(statements.match(/CREATE TABLE "(\w+)"/g)).toEqual(['CREATE TABLE "ChangeRequests"']);
    expect(statements).not.toMatch(/ALTER TABLE|DELETE FROM|UPDATE "|INSERT INTO|DROP TABLE|DROP COLUMN/);
  });

  it('admits exactly the kinds and statuses the code uses', () => {
    expect(inList('changeKind')).toEqual(CHANGE_KINDS);
    expect(inList('requestStatus')).toEqual(CHANGE_STATUSES);
  });

  it('outlives what it is about: every reference only clears its link', () => {
    expect(statements.match(/REFERENCES "(\w+)"\("id"\)\s+ON DELETE (\w+ \w+)/g).map(s => s.replace(/\s+/g, ' '))).toEqual([
      'REFERENCES "Systems"("id") ON DELETE SET NULL',
      'REFERENCES "Contexts"("id") ON DELETE SET NULL',
      'REFERENCES "ContextClaims"("id") ON DELETE SET NULL',
      'REFERENCES "ContextMemberOverrides"("id") ON DELETE SET NULL',
    ]);
    expect(statements).not.toMatch(/ON DELETE CASCADE/);
  });

  it('keeps one open request per change, and a close time exactly when closed', () => {
    expect(statements).toMatch(/CREATE UNIQUE INDEX "uq_ChangeRequests_open"[\s\S]+\) WHERE "requestStatus" = 'open';/);
    expect(statements).toMatch(/"ck_ChangeRequests_closed" CHECK \(\("requestStatus" = 'open'\) = \("closedAt" IS NULL\)\)/);
  });

  it('records every change in _history', () => {
    expect(statements).toMatch(/AFTER INSERT OR DELETE ON "ChangeRequests"/);
    expect(statements).toMatch(/AFTER UPDATE ON "ChangeRequests"/);
  });
});
