import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createParams } from '../db/sqlParams.js';

vi.mock('../db/connection.js');   // picks up src/db/__mocks__/connection.js
import { query } from '../db/connection.js';

import {
  SYSTEM_FILTER_KEY, fetchSystemNames, addSystemColumn, extractSystemFilter, systemFilterWhere,
} from './systemFilter.js';

beforeEach(() => { query.mockReset(); });

describe('fetchSystemNames', () => {
  it('reads display names from the Systems table, not from row values', async () => {
    query.mockResolvedValueOnce({ rows: [{ displayName: 'Contoso HR' }, { displayName: 'Entra' }] });
    expect(await fetchSystemNames()).toEqual(['Contoso HR', 'Entra']);
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toMatch(/FROM "Systems"/);
    // A system with zero principals/resources must still be offered, so the
    // values may NOT come from a DISTINCT over Principals/Resources.
    expect(sql).not.toMatch(/"Principals"|"Resources"/);
    expect(sql).toMatch(/DISTINCT/);
  });
});

describe('addSystemColumn', () => {
  it('adds __system with the system names alongside the existing columns', async () => {
    query.mockResolvedValueOnce({ rows: [{ displayName: 'Entra' }] });
    const grouped = await addSystemColumn({ department: ['IT'] });
    expect(grouped).toEqual({ department: ['IT'], [SYSTEM_FILTER_KEY]: ['Entra'] });
  });

  it('emits the column with no values on the schema-only fast path, without querying', async () => {
    const grouped = await addSystemColumn({}, { schemaOnly: true });
    expect(grouped[SYSTEM_FILTER_KEY]).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('extractSystemFilter', () => {
  it('pulls __system out of the filters object so it is not validated as a column', () => {
    const filters = { __system: 'Entra', department: 'IT' };
    expect(extractSystemFilter(filters)).toBe('Entra');
    expect(filters).toEqual({ department: 'IT' });
  });

  it('trims the value', () => {
    expect(extractSystemFilter({ __system: '  Entra  ' })).toBe('Entra');
  });

  it('returns null (and removes the key) for a blank value', () => {
    const filters = { __system: '   ' };
    expect(extractSystemFilter(filters)).toBeNull();
    expect(filters).toEqual({});
  });

  it('returns null when the key is absent or the object is missing', () => {
    expect(extractSystemFilter({ department: 'IT' })).toBeNull();
    expect(extractSystemFilter(null)).toBeNull();
  });
});

describe('systemFilterWhere', () => {
  it('renders a bound EXISTS predicate against Systems.displayName', () => {
    const { params, bind } = createParams();
    const sql = systemFilterWhere('Entra', 'u', bind);
    expect(sql).toContain('EXISTS (SELECT 1 FROM "Systems" _sys');
    expect(sql).toContain('_sys.id = u."systemId"');
    // The name is bound, never interpolated.
    expect(sql).not.toContain('Entra');
    expect(params).toEqual(['Entra']);
  });

  it('uses the caller-supplied alias', () => {
    const { bind } = createParams();
    expect(systemFilterWhere('Entra', 'r', bind)).toContain('_sys.id = r."systemId"');
  });

  it('renders nothing when no system is selected', () => {
    const { params, bind } = createParams();
    expect(systemFilterWhere(null, 'u', bind)).toBe('');
    expect(systemFilterWhere('', 'u', bind)).toBe('');
    expect(params).toEqual([]);
  });
});
