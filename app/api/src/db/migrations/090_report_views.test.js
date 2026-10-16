import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, '090_report_views.sql'), 'utf8');
const statements = sql.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n');

describe('migration 090 — report views', () => {
  it('creates one table with the columns reports/views.js reads and writes', () => {
    expect(statements.match(/CREATE TABLE "(\w+)"/g)).toEqual(['CREATE TABLE "ReportViews"']);
    const columns = [...statements.matchAll(/^\s+"(\w+)"\s+[A-Z]/gm)].map(m => m[1]);
    expect(columns).toEqual([
      'id', 'reportName', 'name', 'description', 'params', 'createdBy', 'createdAt', 'updatedBy', 'updatedAt',
    ]);
  });

  it('keeps names unique regardless of case, and params never null', () => {
    expect(statements).toMatch(/CREATE UNIQUE INDEX "ix_ReportViews_name" ON "ReportViews" \(LOWER\("name"\)\)/);
    expect(statements).toMatch(/"params"\s+JSONB NOT NULL DEFAULT '\{\}'::jsonb/);
  });

  it('touches nothing that already exists', () => {
    expect(statements).not.toMatch(/ALTER TABLE|DROP |UPDATE |DELETE /i);
  });
});
