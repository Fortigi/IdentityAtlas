import { describe, it, expect } from 'vitest';
import { buildOrderBy } from './listSort.js';

const ALLOWED = {
  displayName: '"displayName"',
  accountCount: '"accountCount"',
  department: '"department"',
};

describe('buildOrderBy', () => {
  it('maps an allowed column + asc/desc to a safe ORDER BY expression', () => {
    expect(buildOrderBy('accountCount', 'asc', ALLOWED)).toBe('"accountCount" ASC');
    expect(buildOrderBy('accountCount', 'desc', ALLOWED)).toBe('"accountCount" DESC');
  });

  it('treats the direction case-insensitively and defaults unknown directions to ASC', () => {
    expect(buildOrderBy('department', 'DESC', ALLOWED)).toBe('"department" DESC');
    expect(buildOrderBy('department', 'Desc', ALLOWED)).toBe('"department" DESC');
    expect(buildOrderBy('department', 'sideways', ALLOWED)).toBe('"department" ASC');
    expect(buildOrderBy('department', undefined, ALLOWED)).toBe('"department" ASC');
  });

  it('falls back to the default when the sort column is unknown, missing, or an injection attempt', () => {
    expect(buildOrderBy(undefined, 'asc', ALLOWED)).toBe('"displayName" ASC');
    expect(buildOrderBy('nope', 'desc', ALLOWED)).toBe('"displayName" ASC');
    // An injection attempt is not a key in the allowlist, so it never reaches SQL.
    expect(buildOrderBy('id; DROP TABLE "Principals"; --', 'desc', ALLOWED))
      .toBe('"displayName" ASC');
  });

  it('honours a caller-supplied fallback expression', () => {
    expect(buildOrderBy('unknown', 'asc', ALLOWED, '"accountCount" DESC'))
      .toBe('"accountCount" DESC');
  });

  it('never lets a column outside the allowlist through even with a valid-looking name', () => {
    // "password" is a real-ish column name but not allow-listed → fallback.
    expect(buildOrderBy('password', 'asc', ALLOWED)).toBe('"displayName" ASC');
  });
});

describe('buildOrderBy — inherited property names are not columns (SEC-2026-09 L-15)', () => {
  for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    it(`falls back for sort=${key}`, () => {
      expect(buildOrderBy(key, 'desc', ALLOWED)).toBe('"displayName" ASC');
    });
  }
});

describe('buildOrderBy — the {dir} placeholder', () => {
  // A nullable column needs the direction in the middle: `"x" DESC NULLS LAST`
  // is valid SQL, `"x" NULLS LAST DESC` is a syntax error. Appending would
  // therefore have made "sort by last sign-in, newest first" a 500.
  const NULLABLE = { lastSignIn: '"lastSignIn" {dir} NULLS LAST' };

  it('substitutes the direction in place instead of appending it', () => {
    expect(buildOrderBy('lastSignIn', 'desc', NULLABLE)).toBe('"lastSignIn" DESC NULLS LAST');
    expect(buildOrderBy('lastSignIn', 'asc', NULLABLE)).toBe('"lastSignIn" ASC NULLS LAST');
  });

  it('keeps nulls last in BOTH directions — "never" is an absence, not the oldest', () => {
    for (const dir of ['asc', 'desc']) {
      expect(buildOrderBy('lastSignIn', dir, NULLABLE)).toMatch(/NULLS LAST$/);
    }
  });

  it('still appends for a plain expression, so existing allowlists are unchanged', () => {
    expect(buildOrderBy('displayName', 'desc', { displayName: '"displayName"' }))
      .toBe('"displayName" DESC');
  });

  it('expands every occurrence, so a two-key expression stays consistent', () => {
    expect(buildOrderBy('k', 'desc', { k: '"a" {dir}, "b" {dir}' })).toBe('"a" DESC, "b" DESC');
  });

  it('never expands a placeholder coming from the query string', () => {
    // The placeholder only has meaning inside an allowlisted value; a sort key
    // that looks like one is still just an unknown key.
    expect(buildOrderBy('{dir}', 'desc', NULLABLE)).toBe('"displayName" ASC');
  });
});
