// Report parameters: the values the form shows (schema defaults under what the
// user set) and the query string both the rows fetch and the download send.

import { describe, it, expect } from 'vitest';
import { withSchemaDefaults, paramsQueryString } from '@ui/components/reports/reportParams';

describe('withSchemaDefaults', () => {
  const schema = {
    properties: {
      inactiveDays: { type: 'integer', default: 90 },
      includeDisabled: { type: 'boolean', default: false },
      systemName: { type: 'string' },
    },
  };

  it('fills in declared defaults, including falsy ones, and skips properties without one', () => {
    // `false` is a real default: a `if (prop.default)` truthiness check would drop it.
    expect(withSchemaDefaults(schema, {})).toEqual({ inactiveDays: 90, includeDisabled: false });
  });

  it('lets a value the user set win over the default', () => {
    expect(withSchemaDefaults(schema, { inactiveDays: 30, systemName: 'Entra ID' }))
      .toEqual({ inactiveDays: 30, includeDisabled: false, systemName: 'Entra ID' });
  });

  it('keeps user params that the schema does not declare', () => {
    expect(withSchemaDefaults(schema, { extra: 'x' })).toEqual({ inactiveDays: 90, includeDisabled: false, extra: 'x' });
  });

  it('returns the params unchanged when there is no schema or no properties', () => {
    expect(withSchemaDefaults(undefined, { a: 1 })).toEqual({ a: 1 });
    expect(withSchemaDefaults({ type: 'object' }, { a: 1 })).toEqual({ a: 1 });
  });

  it('tolerates a null property entry', () => {
    expect(withSchemaDefaults({ properties: { broken: null, days: { default: 7 } } }, {})).toEqual({ days: 7 });
  });
});

describe('paramsQueryString', () => {
  it('encodes values, joins arrays with commas and escapes reserved characters', () => {
    expect(paramsQueryString({ inactiveDays: 30, systems: ['Entra ID', 'Omada'], q: 'a&b' }))
      .toBe('?inactiveDays=30&systems=Entra+ID%2COmada&q=a%26b');
  });

  it('drops undefined, null and empty-string values but keeps 0 and false', () => {
    expect(paramsQueryString({ a: undefined, b: null, c: '', zero: 0, off: false }))
      .toBe('?zero=0&off=false');
  });

  it('returns an empty string — not a bare "?" — when nothing is left to send', () => {
    expect(paramsQueryString({ a: '', b: undefined })).toBe('');
    expect(paramsQueryString({})).toBe('');
    expect(paramsQueryString(undefined)).toBe('');
  });
});
