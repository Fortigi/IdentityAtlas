// Static checks on migration 102. What the feature writes into it is verified
// against PostgreSQL in contract-tests/treeAdjustments.contract.test.js.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ADJUSTMENT_OPS, ADJUSTMENT_STATUSES } from '../../contexts/adjustments/ops.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, '102_context_tree_adjustments.sql'), 'utf8');
const statements = sql.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n');
const inList = (column) => statements.match(new RegExp(`"${column}"\\s+IN \\(([^)]+)\\)`))[1].split(',').map(s => s.trim().replace(/'/g, ''));

describe('migration 102 — context tree adjustments', () => {
  it('creates one table and changes no existing row', () => {
    expect(statements.match(/CREATE TABLE "(\w+)"/g)).toEqual(['CREATE TABLE "ContextTreeAdjustments"']);
    expect(statements).not.toMatch(/ALTER TABLE|DELETE FROM|UPDATE "|INSERT INTO|DROP TABLE|DROP COLUMN/);
  });

  it('admits exactly the operations and statuses the code uses', () => {
    expect(inList('op')).toEqual(ADJUSTMENT_OPS);
    expect(inList('status')).toEqual(ADJUSTMENT_STATUSES);
  });

  it('keeps an adjustment when its unit vanishes: no foreign key on the subject or member', () => {
    expect(statements).toMatch(/"subjectId"\s+UUID,/);
    expect(statements).toMatch(/"memberId"\s+UUID,/);
    expect(statements.match(/REFERENCES "(\w+)"/g)).toEqual(['REFERENCES "Systems"']);
  });

  it('records every change in _history', () => {
    expect(statements).toMatch(/AFTER INSERT OR DELETE ON "ContextTreeAdjustments"/);
    expect(statements).toMatch(/AFTER UPDATE ON "ContextTreeAdjustments"/);
  });
});
