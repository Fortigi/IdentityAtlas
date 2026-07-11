import { describe, it, expect } from 'vitest';
import { stripNativeExtensions, alreadyExistsWarning, computeMigrationStatus } from './migrate.js';

describe('stripNativeExtensions', () => {
  it('replaces CREATE EXTENSION pg_trgm with a comment', () => {
    const sql = 'CREATE EXTENSION IF NOT EXISTS pg_trgm;';
    const result = stripNativeExtensions(sql);
    // The original statement is quoted in the comment — check it's commented out,
    // not that the text has vanished entirely.
    expect(result).toMatch(/^-- \[DESKTOP_MODE\] skipped:/);
    expect(result).not.toMatch(/^CREATE EXTENSION/m);
  });

  it('is case-insensitive', () => {
    const sql = 'create extension if not exists pg_trgm;';
    expect(stripNativeExtensions(sql)).toMatch(/-- \[DESKTOP_MODE\] skipped/);
  });

  it('leaves other extensions untouched', () => {
    const sql = 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements;';
    expect(stripNativeExtensions(sql)).toBe(sql);
  });

  it('strips pg_trgm but leaves other extensions in the same SQL block', () => {
    const sql = [
      'CREATE EXTENSION IF NOT EXISTS pg_trgm;',
      'CREATE EXTENSION IF NOT EXISTS pg_stat_statements;',
    ].join('\n');
    const result = stripNativeExtensions(sql);
    expect(result).toMatch(/-- \[DESKTOP_MODE\] skipped/);
    expect(result).toContain('CREATE EXTENSION IF NOT EXISTS pg_stat_statements;');
  });

  it('is a no-op when no CREATE EXTENSION statements are present', () => {
    const sql = 'SELECT 1;';
    expect(stripNativeExtensions(sql)).toBe(sql);
  });
});

describe('alreadyExistsWarning', () => {
  it('names the migration file so a skipped backfill is greppable', () => {
    const msg = alreadyExistsWarning('038_effective_access_columns.sql');
    expect(msg).toContain('038_effective_access_columns.sql');
  });

  it('flags that data changes may have been SKIPPED', () => {
    const msg = alreadyExistsWarning('050_update_log.sql');
    expect(msg).toContain('SKIPPED');
    expect(msg).toMatch(/backfill|UPDATE|REFRESH/);
  });
});

describe('computeMigrationStatus', () => {
  it('reports up to date when applied and shipped match', () => {
    expect(computeMigrationStatus(['001_a.sql', '002_b.sql'], ['001_a.sql', '002_b.sql']))
      .toEqual({ applied: 2, latest: '002_b.sql', ahead: false, pending: false });
  });

  it('flags ahead when the DB has a migration this image does not ship (rollback)', () => {
    const s = computeMigrationStatus(['001_a.sql', '002_b.sql', '003_c.sql'], ['001_a.sql', '002_b.sql']);
    expect(s.ahead).toBe(true);
    expect(s.applied).toBe(3);
  });

  it('flags pending when a shipped migration has not been applied', () => {
    const s = computeMigrationStatus(['001_a.sql'], ['001_a.sql', '002_b.sql']);
    expect(s.pending).toBe(true);
    expect(s.ahead).toBe(false);
  });

  it('latest is the lexically-highest applied migration regardless of insert order', () => {
    expect(computeMigrationStatus(['002_b.sql', '001_a.sql', '010_z.sql'], ['001_a.sql', '002_b.sql', '010_z.sql']).latest)
      .toBe('010_z.sql');
  });

  it('handles an empty database', () => {
    expect(computeMigrationStatus([], ['001_a.sql']))
      .toEqual({ applied: 0, latest: null, ahead: false, pending: true });
  });
});
