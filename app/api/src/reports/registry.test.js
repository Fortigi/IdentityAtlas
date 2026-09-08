// Unit tests for the report-template registry.

import { describe, it, expect } from 'vitest';
import { getReport, listReports, registerReport, reportMetadata } from './registry.js';
import { BUILT_IN_REPORTS } from './templates/index.js';

const dummy = (over = {}) => ({
  name: 'zz-dummy', displayName: 'ZZ Dummy', description: 'A dummy.',
  form: 'list', parametersSchema: { type: 'object', required: [], properties: {} },
  columns: [{ key: 'a', label: 'A' }], run: async () => ({ rows: [] }),
  ...over,
});

describe('report registry', () => {
  it('seeds every built-in template at module load', () => {
    for (const t of BUILT_IN_REPORTS) expect(getReport(t.name)).toBe(t);
    expect(listReports()).toHaveLength(BUILT_IN_REPORTS.length);
  });

  it('every built-in template satisfies the template contract', () => {
    // The built-ins bypass registerReport's validation on the way in (importing
    // the registry must not be able to throw), so it is asserted here instead —
    // a malformed template fails the PR rather than the container.
    for (const t of BUILT_IN_REPORTS) {
      expect(() => registerReport(t), t.name).not.toThrow();
      expect(Array.isArray(t.columns) && t.columns.length > 0, t.name).toBe(true);
      expect(typeof t.run, t.name).toBe('function');
    }
  });

  it('returns null for a name that is not registered', () => {
    expect(getReport('no-such-report')).toBeNull();
    // A Map lookup can't surface inherited Object.prototype members.
    expect(getReport('constructor')).toBeNull();
  });

  it('registers a new template and unregisters it again', () => {
    const before = listReports().length;
    const unregister = registerReport(dummy());

    expect(getReport('zz-dummy')).toBeTruthy();
    expect(listReports()).toHaveLength(before + 1);

    unregister();
    expect(getReport('zz-dummy')).toBeNull();
    expect(listReports()).toHaveLength(before);
  });

  it('orders templates by display name', () => {
    const unregister = registerReport(dummy({ name: 'aaa-first', displayName: 'AAA First' }));
    try {
      const names = listReports().map(r => r.displayName);
      expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
      expect(names[0]).toBe('AAA First');
    } finally {
      unregister();
    }
  });

  it('rejects a template that is missing a required field, naming only that field', () => {
    // Exact message, not a substring: it has to name the field that is actually
    // absent, so "everything is missing" and "nothing is missing" both fail here.
    for (const field of ['name', 'displayName', 'form', 'columns', 'run']) {
      const broken = dummy();
      delete broken[field];
      expect(() => registerReport(broken), field)
        .toThrow(new Error(`Invalid report template: missing ${field}`));
    }
    expect(() => registerReport(undefined))
      .toThrow(new Error('Invalid report template: missing name, displayName, form, columns, run'));
  });

  it('accepts a complete template without complaint', () => {
    // The other half of the validation rule: a template that has every required
    // field must register, so a validator that rejects everything fails here.
    let unregister;
    expect(() => { unregister = registerReport(dummy()); }).not.toThrow();
    expect(getReport('zz-dummy')).toBeTruthy();
    unregister();
  });

  it('exposes only descriptive metadata — never the run function', () => {
    const meta = reportMetadata(dummy());
    expect(meta).toEqual({
      name: 'zz-dummy', displayName: 'ZZ Dummy', description: 'A dummy.', form: 'list',
      parametersSchema: { type: 'object', required: [], properties: {} },
      columns: [{ key: 'a', label: 'A' }],
    });
    expect(meta.run).toBeUndefined();
  });

  it('defaults description and parametersSchema when a template omits them', () => {
    const meta = reportMetadata(dummy({ description: undefined, parametersSchema: undefined }));
    expect(meta.description).toBe('');
    expect(meta.parametersSchema).toEqual({ type: 'object', required: [], properties: {} });
  });
});
