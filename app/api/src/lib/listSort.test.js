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
