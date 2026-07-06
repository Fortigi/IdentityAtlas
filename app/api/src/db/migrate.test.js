import { describe, it, expect } from 'vitest';
import { stripNativeExtensions, alreadyExistsWarning } from './migrate.js';

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
