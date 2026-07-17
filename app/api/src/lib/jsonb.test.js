import { describe, it, expect } from 'vitest';
import { parseJsonbColumn } from './jsonb.js';

describe('parseJsonbColumn', () => {
  it('passes an already-parsed object/array through untouched (the pg default)', () => {
    const obj = { mailEnabled: true, k: 'v' };
    expect(parseJsonbColumn(obj)).toBe(obj); // same reference — no reparse
    const arr = [1, 2, 3];
    expect(parseJsonbColumn(arr)).toBe(arr);
  });

  it('parses a raw JSON string (legacy/shim path)', () => {
    expect(parseJsonbColumn('{"a":1}')).toEqual({ a: 1 });
  });

  it('returns null for null/undefined', () => {
    expect(parseJsonbColumn(null)).toBeNull();
    expect(parseJsonbColumn(undefined)).toBeNull();
  });

  it('returns null for an unparseable string instead of throwing', () => {
    expect(parseJsonbColumn('not json')).toBeNull();
  });

  it('does NOT throw on an object (the bug it replaces: JSON.parse(object))', () => {
    expect(() => parseJsonbColumn({ x: 1 })).not.toThrow();
  });
});
