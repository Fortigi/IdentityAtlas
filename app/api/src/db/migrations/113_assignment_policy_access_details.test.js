import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, '113_assignment_policy_access_details.sql'), 'utf8');
const code = sql.replace(/^\s*--.*$/gm, '');

describe('migration 113 — assignment policy access details', () => {
  it.each([
    ['allowsRequest', 'BOOLEAN'], ['allowsDirectAssignment', 'BOOLEAN'], ['allowsRemovalRequest', 'BOOLEAN'],
    ['requiresApproval', 'BOOLEAN'], ['hasExpiration', 'BOOLEAN'], ['expiration', 'JSONB'], ['targetRule', 'TEXT'],
  ])('adds %s as a nullable %s', (column, type) => {
    const line = code.split('\n').find(l => l.includes(`ADD COLUMN IF NOT EXISTS "${column}"`));
    expect(line).toMatch(new RegExp(`${type};`));
    // NULL means "the source does not say", so neither NOT NULL nor a default.
    expect(line).not.toMatch(/NOT NULL|DEFAULT/);
  });

  it('backfills only policies that carry the Entra requestor settings', () => {
    expect(code).toMatch(/"policyConditions" \? 'enableTargetsToSelfAddAccess'/);
  });

  it('counts a request on behalf of someone else as a request', () => {
    expect(code).toMatch(/enableOnBehalfRequestorsToAddAccess/);
    expect(code).toMatch(/enableOnBehalfRequestorsToRemoveAccess/);
  });
});
