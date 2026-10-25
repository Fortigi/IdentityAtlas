// Static checks on migration 097. What the upload writes into it is verified
// against PostgreSQL in contract-tests/contextUpload.contract.test.js.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { TEMPLATES } from '../../contexts/upload/guess.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, '097_context_uploads.sql'), 'utf8');
const statements = sql.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n');

describe('migration 097 — context uploads', () => {
  it('creates exactly one table and writes no rows', () => {
    expect(statements.match(/CREATE TABLE "(\w+)"/g)).toEqual(['CREATE TABLE "ContextUploads"']);
    expect(statements).not.toMatch(/ALTER TABLE|DROP |DELETE FROM|UPDATE "|INSERT INTO/);
  });

  it('goes with its list and outlives a deleted root', () => {
    expect(statements).toMatch(/"systemId"\s+INTEGER NOT NULL REFERENCES "Systems"\("id"\) ON DELETE CASCADE/);
    expect(statements).toMatch(/"rootContextId"\s+UUID REFERENCES "Contexts"\("id"\) ON DELETE SET NULL/);
  });

  it('accepts exactly the templates an upload offers', () => {
    const values = statements.match(/"template" IN \(([^)]+)\)/)[1].split(',').map(s => s.trim().replace(/'/g, ''));
    expect(values).toEqual(TEMPLATES);
  });

  it('indexes lower(email) on the two tables member matching reads', () => {
    expect(statements).toMatch(/ON "Principals" \(lower\("email"\)\)/);
    expect(statements).toMatch(/ON "Identities" \(lower\("email"\)\)/);
  });
});
