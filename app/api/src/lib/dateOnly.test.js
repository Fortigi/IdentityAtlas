import { describe, it, expect } from 'vitest';
import { toDateOnly } from './dateOnly.js';

describe('toDateOnly', () => {
  it('reduces a Date to its calendar day', () => {
    expect(toDateOnly(new Date('2026-09-14T03:17:44.912Z'))).toBe('2026-09-14');
  });

  it('parses the string shapes the driver and JSON hand back', () => {
    expect(toDateOnly('2026-01-02T23:59:59.000Z')).toBe('2026-01-02');
    expect(toDateOnly('2026-01-02')).toBe('2026-01-02');
  });

  it('returns null for absent values rather than a placeholder string', () => {
    // The table renders null as its own em-dash; "Invalid Date" or "1970-01-01"
    // would both read as data.
    for (const absent of [null, undefined, '']) expect(toDateOnly(absent)).toBeNull();
  });

  it('returns null for something that is not a date at all', () => {
    expect(toDateOnly('not a date')).toBeNull();
    expect(toDateOnly(new Date('nope'))).toBeNull();
  });

  it('keeps the UTC day, so a late-evening UTC timestamp does not slip a day', () => {
    expect(toDateOnly('2026-03-01T00:30:00.000Z')).toBe('2026-03-01');
    expect(toDateOnly('2026-02-28T23:30:00.000Z')).toBe('2026-02-28');
  });
});
