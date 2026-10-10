import { describe, it, expect } from 'vitest';
import { validateProfileInput, validateDefinition, LIMITS, DEFAULT_UNKNOWN_LABEL, dimensionOf } from './profileSchema.js';

const def = (over = {}) => ({
  dimensions: [{ field: 'Principal.accountEnabled' }, { field: 'Identity.department', label: 'Dept', unknownLabel: 'n/a' }],
  datasets: [{ id: 'accounts', metric: 'principals.count', dimensions: ['Principal.accountEnabled', 'Identity.department'] }],
  ...over,
});
const codes = r => r.errors.map(e => `${e.path}:${e.code}`);

describe('validateDefinition - accepted shape and defaults', () => {
  it('normalizes a minimal definition with every default spelled out', () => {
    const r = validateDefinition(def());
    expect(r.errors).toEqual([]);
    expect(r.definition).toEqual({
      scope: { systemIds: null },
      dimensions: [
        { field: 'Principal.accountEnabled', label: 'Account enabled', unknownLabel: DEFAULT_UNKNOWN_LABEL },
        { field: 'Identity.department', label: 'Dept', unknownLabel: 'n/a' },
      ],
      datasets: [{ id: 'accounts', metric: 'principals.count', dimensions: ['Principal.accountEnabled', 'Identity.department'] }],
      privacy: { minGroupSize: 5 },
      limits: { maxRows: 10000 },
    });
  });

  it('sorts and de-duplicates scope system ids', () => {
    expect(validateDefinition(def({ scope: { systemIds: [4, 1, 4] } })).definition.scope).toEqual({ systemIds: [1, 4] });
  });

  it('gives a historical dataset its default periods and accepts the maximum', () => {
    const d = def({ datasets: [{ id: 't', metric: 'principals.countAsOf', dimensions: ['Principal.accountEnabled'] }] });
    expect(validateDefinition(d).definition.datasets[0].periods).toBe(6);
    d.datasets[0].periods = 12;
    expect(validateDefinition(d).definition.datasets[0].periods).toBe(12);
    d.datasets[0].periods = 13;
    expect(codes(validateDefinition(d))).toEqual(['datasets[0].periods:out_of_range']);
  });

  it('accepts a discovered extendedAttributes field id by syntax', () => {
    const d = def({ dimensions: [{ field: 'Principal.ext.employeeCategory' }], datasets: [{ id: 'a', metric: 'principals.count', dimensions: ['Principal.ext.employeeCategory'] }] });
    expect(validateDefinition(d).errors).toEqual([]);
  });
});

describe('validateDefinition - refusals', () => {
  it('refuses unknown fields, identifiers and free text with the reason', () => {
    const r = validateDefinition(def({
      dimensions: [{ field: 'Principal.salary' }, { field: 'Principal.email' }, { field: 'Resource.description' }, { field: 'Principal.ext.bad key' }],
      datasets: [{ id: 'a', metric: 'principals.count', dimensions: [] }],
    }));
    expect(codes(r)).toEqual([
      'dimensions[0].field:unknown_field', 'dimensions[1].field:not_reportable',
      'dimensions[2].field:not_reportable', 'dimensions[3].field:unknown_field',
    ]);
    expect(r.errors[1].message).toMatch(/identifier/i);
    expect(r.errors[2].message).toMatch(/free text/i);
  });

  it('refuses a breakdown the metric cannot count without double counting', () => {
    const r = validateDefinition(def({
      datasets: [
        { id: 'persons', metric: 'identities.count', dimensions: ['Principal.accountEnabled'] },
        { id: 'trend', metric: 'principals.countAsOf', dimensions: ['Identity.department'] },
      ],
    }));
    expect(codes(r)).toEqual(['datasets[0].dimensions[0]:unsupported_breakdown', 'datasets[1].dimensions[0]:unsupported_breakdown']);
    expect(r.errors[1].message).toMatch(/not audited/);
  });

  it('refuses a dataset dimension the profile did not select, and duplicates', () => {
    const r = validateDefinition(def({
      dimensions: [{ field: 'Principal.accountEnabled' }, { field: 'Principal.accountEnabled' }],
      datasets: [
        { id: 'a', metric: 'principals.count', dimensions: ['Principal.department'] },
        { id: 'a', metric: 'principals.count', dimensions: ['Principal.accountEnabled', 'Principal.accountEnabled'] },
      ],
    }));
    expect(codes(r)).toEqual([
      'dimensions[1].field:duplicate', 'datasets[0].dimensions[0]:not_in_profile',
      'datasets[1].id:duplicate', 'datasets[1].dimensions:duplicate',
    ]);
  });

  it('refuses an unknown metric, a malformed id, and periods on a current metric', () => {
    const r = validateDefinition(def({
      datasets: [
        { id: 'Bad Id', metric: 'principals.count', dimensions: [] },
        { id: 'b', metric: 'principals.sum', dimensions: [] },
        { id: 'c', metric: 'principals.count', dimensions: [], periods: 3 },
      ],
    }));
    expect(codes(r)).toEqual(['datasets[0].id:invalid', 'datasets[1].metric:unknown_metric', 'datasets[2].periods:invalid']);
  });

  it('enforces the dimension and dataset counts at their exact boundaries', () => {
    const fields = ['Principal.accountEnabled', 'Principal.principalType', 'Principal.department', 'Principal.companyName', 'Principal.jobTitle'];
    const four = { id: 'four', metric: 'principals.count', dimensions: fields.slice(0, 4) };
    const five = { id: 'five', metric: 'principals.count', dimensions: fields };
    const dims = fields.map(field => ({ field }));
    expect(validateDefinition({ dimensions: dims, datasets: [four] }).errors).toEqual([]);
    expect(codes(validateDefinition({ dimensions: dims, datasets: [five] }))).toEqual(['datasets[0].dimensions:invalid']);

    const many = Array.from({ length: LIMITS.maxDatasets + 1 }, (_, i) => ({ id: `d${i}`, metric: 'principals.count', dimensions: [] }));
    expect(codes(validateDefinition({ dimensions: dims, datasets: many }))).toEqual(['datasets:invalid']);
    expect(validateDefinition({ dimensions: dims, datasets: many.slice(0, LIMITS.maxDatasets) }).errors).toEqual([]);
    expect(codes(validateDefinition({ dimensions: [], datasets: [four] }))).toContain('dimensions:invalid');
  });

  it('bounds privacy and limits, including the minimum group size of exactly 1 and the row ceiling', () => {
    expect(validateDefinition(def({ privacy: { minGroupSize: 1 } })).definition.privacy.minGroupSize).toBe(1);
    expect(codes(validateDefinition(def({ privacy: { minGroupSize: 0 } })))).toEqual(['privacy.minGroupSize:out_of_range']);
    expect(codes(validateDefinition(def({ privacy: { minGroupSize: 2.5 } })))).toEqual(['privacy.minGroupSize:out_of_range']);
    expect(validateDefinition(def({ limits: { maxRows: LIMITS.maxRowsCeiling } })).errors).toEqual([]);
    expect(codes(validateDefinition(def({ limits: { maxRows: LIMITS.maxRowsCeiling + 1 } })))).toEqual(['limits.maxRows:out_of_range']);
  });

  it('refuses malformed scopes', () => {
    for (const scope of [[], 'all', { systemIds: [] }, { systemIds: [0] }, { systemIds: ['1'] }]) {
      expect(validateDefinition(def({ scope })).errors.length).toBe(1);
    }
    expect(validateDefinition(def({ scope: { systemIds: null } })).definition.scope).toEqual({ systemIds: null });
  });

  it('refuses a non-object definition and non-object list entries', () => {
    expect(codes(validateDefinition(null))).toEqual(['definition:invalid']);
    expect(codes(validateDefinition({ dimensions: ['Principal.accountEnabled'], datasets: ['x'] })))
      .toEqual(['dimensions[0]:invalid', 'datasets[0]:invalid']);
  });
});

describe('validateProfileInput', () => {
  it('requires a name and trims it', () => {
    expect(codes(validateProfileInput({ definition: def() }))).toEqual(['name:required']);
    expect(codes(validateProfileInput({ name: '   ', definition: def() }))).toEqual(['name:required']);
    expect(validateProfileInput({ name: '  Workforce ', definition: def() }).profile.name).toBe('Workforce');
  });

  it('defaults status to active, accepts retired, refuses anything else', () => {
    expect(validateProfileInput({ name: 'x', definition: def() }).profile.status).toBe('active');
    expect(validateProfileInput({ name: 'x', status: 'retired', definition: def() }).profile.status).toBe('retired');
    expect(codes(validateProfileInput({ name: 'x', status: 'draft', definition: def() }))).toEqual(['status:invalid']);
  });

  it('refuses over-long text and a non-object body', () => {
    expect(codes(validateProfileInput({ name: 'x'.repeat(201), definition: def() }))).toEqual(['name:invalid']);
    expect(codes(validateProfileInput({ name: 'x', description: 5, definition: def() }))).toEqual(['description:invalid']);
    expect(codes(validateProfileInput([]))).toEqual([':invalid']);
  });

  it('carries the definition errors through', () => {
    expect(codes(validateProfileInput({ name: 'x', definition: { dimensions: [], datasets: [] } })))
      .toEqual(['dimensions:invalid', 'datasets:invalid']);
  });
});

describe('dimensionOf', () => {
  it('finds the profile entry of a field', () => {
    const d = validateDefinition(def()).definition;
    expect(dimensionOf(d, 'Identity.department').label).toBe('Dept');
    expect(dimensionOf(d, 'Principal.department')).toBeUndefined();
  });
});
