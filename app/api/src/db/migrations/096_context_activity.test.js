// Static checks on migration 096. What the activity upload writes into it, and
// what the Activity section reads back, is verified against PostgreSQL in
// contract-tests/contextActivity.contract.test.js.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, '096_context_activity.sql'), 'utf8');
const statements = sql.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n');

describe('migration 096 — context activity', () => {
  it('creates exactly the two activity tables and touches nothing else', () => {
    expect(statements.match(/CREATE TABLE "(\w+)"/g)).toEqual(['CREATE TABLE "ContextActivityUploads"', 'CREATE TABLE "ContextActivity"']);
    expect(statements).not.toMatch(/ALTER TABLE|DROP |DELETE FROM|UPDATE "|INSERT INTO/);
    // Activity is evidence, never a holding: no table of the access graph is referenced.
    expect(statements).not.toMatch(/"ResourceAssignments"|"ContextMembers"/);
  });

  it('an upload goes with its context, its rows with their upload and their context', () => {
    expect(statements).toMatch(/CREATE TABLE "ContextActivityUploads"[\s\S]*?"contextId"\s+UUID NOT NULL REFERENCES "Contexts"\("id"\) ON DELETE CASCADE/);
    expect(statements).toMatch(/"uploadId"\s+UUID NOT NULL REFERENCES "ContextActivityUploads"\("id"\) ON DELETE CASCADE/);
    expect(statements).toMatch(/CREATE TABLE "ContextActivity"[\s\S]*?"contextId"\s+UUID NOT NULL REFERENCES "Contexts"\("id"\) ON DELETE CASCADE/);
  });

  it('keeps the observation when the person or account goes: their reference is set to NULL', () => {
    expect(statements).toMatch(/"principalId"\s+UUID REFERENCES "Principals"\("id"\) ON DELETE SET NULL,/);
    expect(statements).toMatch(/"identityId"\s+UUID REFERENCES "Identities"\("id"\) ON DELETE SET NULL,/);
  });

  it('indexes what the section and the replace step read', () => {
    expect(statements).toMatch(/ON "ContextActivity" \("contextId", "activityDate"\)/);
    expect(statements).toMatch(/ON "ContextActivity" \("principalId"\)/);
    expect(statements).toMatch(/ON "ContextActivity" \("uploadId", "activityDate"\)/);
    expect(statements).toMatch(/ON "ContextActivityUploads" \("contextId", "uploadedAt"\)/);
  });
});
