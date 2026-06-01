import { describe, it, expect } from 'vitest';
import { coerceValue, normalizeRecords } from './normalization.js';

describe('coerceValue', () => {
  it('passes boolean true through unchanged', () => {
    expect(coerceValue(true)).toBe(true);
  });

  it('passes boolean false through unchanged', () => {
    expect(coerceValue(false)).toBe(false);
  });

  it('does not convert boolean to integer', () => {
    expect(coerceValue(true)).not.toBe(1);
    expect(coerceValue(false)).not.toBe(0);
  });

  it('converts empty string to null', () => {
    expect(coerceValue('')).toBeNull();
  });

  it('converts null to null', () => {
    expect(coerceValue(null)).toBeNull();
  });

  it('passes strings through unchanged', () => {
    expect(coerceValue('hello')).toBe('hello');
  });

  it('passes numbers through unchanged', () => {
    expect(coerceValue(42)).toBe(42);
  });

  it('serializes objects to JSON', () => {
    expect(coerceValue({ a: 1 })).toBe('{"a":1}');
  });
});

describe('normalizeRecords — boolean fields', () => {
  it('preserves boolean true as boolean in core columns', () => {
    const result = normalizeRecords(
      [{ enabled: true, syncEnabled: false }],
      ['enabled', 'syncEnabled'],
    );
    expect(result[0].enabled).toBe(true);
    expect(result[0].syncEnabled).toBe(false);
  });

  it('does not coerce boolean to 0/1 (PGlite rejects integer for boolean columns)', () => {
    const result = normalizeRecords(
      [{ enabled: true }],
      ['enabled'],
    );
    expect(result[0].enabled).not.toBe(1);
  });
});
