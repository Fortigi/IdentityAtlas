import { describe, it, expect } from 'vitest';
import { isMissingSchema } from './schemaErrors.js';

describe('isMissingSchema', () => {
  it('is true for undefined table/column/object SQLSTATEs', () => {
    expect(isMissingSchema({ code: '42P01' })).toBe(true); // undefined_table
    expect(isMissingSchema({ code: '42703' })).toBe(true); // undefined_column
    expect(isMissingSchema({ code: '42704' })).toBe(true); // undefined_object
  });

  it('is false for genuine errors that must NOT be swallowed', () => {
    expect(isMissingSchema({ code: '42601' })).toBe(false); // syntax_error
    expect(isMissingSchema({ code: '23505' })).toBe(false); // unique_violation
    expect(isMissingSchema({ code: '08006' })).toBe(false); // connection_failure
    expect(isMissingSchema(new TypeError('cannot read x'))).toBe(false); // JS bug
    expect(isMissingSchema(null)).toBe(false);
    expect(isMissingSchema(undefined)).toBe(false);
  });
});
