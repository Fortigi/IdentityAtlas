import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, '084_analytics_profiles.sql'), 'utf8');
const statements = sql.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n');

describe('migration 084 — analytics profiles', () => {
  it('creates only its own two tables and touches no existing one', () => {
    expect([...statements.matchAll(/CREATE TABLE IF NOT EXISTS "(\w+)"/g)].map(m => m[1]))
      .toEqual(['AnalyticsProfiles', 'AnalyticsProfileVersions']);
    expect(statements).not.toMatch(/ALTER TABLE|DROP |^\s*UPDATE |^\s*DELETE FROM/im);
  });

  it('allows exactly the statuses the API writes', () => {
    expect(statements).toMatch(/CHECK \("status" IN \('active', 'retired'\)\)/);
  });

  it('keys versions by (profile, version) so a version can never be written twice', () => {
    expect(statements).toMatch(/PRIMARY KEY \("profileId", "version"\)/);
  });

  it('makes profile names unique regardless of case', () => {
    expect(statements).toMatch(/UNIQUE INDEX IF NOT EXISTS "ux_AnalyticsProfiles_name"\s+ON "AnalyticsProfiles" \(lower\("name"\)\)/);
  });
});
