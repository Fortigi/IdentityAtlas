import { describe, it, expect } from 'vitest';
import { NAME_STEP, SETTINGS_STEP, missingRequired, stepSchema, viewRequest, viewSteps } from './reportViewSteps';

const SCHEMA = {
  type: 'object',
  required: ['contexts'],
  properties: {
    contexts: { type: 'array', 'x-step': 'Scope' },
    fields: { type: 'array', 'x-step': 'Columns' },
    pivotRows: { type: 'array', 'x-step': 'Excel pivots' },
    pivotFilters: { type: 'array', 'x-step': 'Excel pivots' },
  },
};

describe('viewSteps', () => {
  it('groups the parameters into the steps the report declares, in order, then asks for a name', () => {
    expect(viewSteps(SCHEMA)).toEqual([
      { n: 1, label: 'Scope', keys: ['contexts'] },
      { n: 2, label: 'Columns', keys: ['fields'] },
      { n: 3, label: 'Excel pivots', keys: ['pivotRows', 'pivotFilters'] },
      { n: 4, label: NAME_STEP, keys: [] },
    ]);
  });

  it('puts parameters without a step into one Settings step, and copes with no schema', () => {
    expect(viewSteps({ properties: { days: {}, mode: { 'x-step': 'Mode' }, other: null } })).toEqual([
      { n: 1, label: SETTINGS_STEP, keys: ['days', 'other'] },
      { n: 2, label: 'Mode', keys: ['mode'] },
      { n: 3, label: NAME_STEP, keys: [] },
    ]);
    expect(viewSteps(undefined)).toEqual([{ n: 1, label: NAME_STEP, keys: [] }]);
  });
});

describe('missingRequired', () => {
  it('names only required parameters of this step that have no value', () => {
    expect(missingRequired(SCHEMA, ['contexts'], {})).toEqual(['contexts']);
    for (const empty of [[], '', null, undefined]) {
      expect(missingRequired(SCHEMA, ['contexts'], { contexts: empty })).toEqual(['contexts']);
    }
    expect(missingRequired(SCHEMA, ['contexts'], { contexts: ['c1'] })).toEqual([]);
    expect(missingRequired(SCHEMA, ['contexts'], { contexts: 'c1' })).toEqual([]);
    // Not required, so empty is fine.
    expect(missingRequired(SCHEMA, ['fields'], {})).toEqual([]);
    expect(missingRequired({}, ['x'], undefined)).toEqual([]);
  });
});

describe('stepSchema', () => {
  it('keeps the schema but only this step\'s properties', () => {
    expect(stepSchema(SCHEMA, ['pivotRows', 'pivotFilters'])).toEqual({
      type: 'object',
      required: ['contexts'],
      properties: { pivotRows: SCHEMA.properties.pivotRows, pivotFilters: SCHEMA.properties.pivotFilters },
    });
  });
});

describe('viewRequest', () => {
  const draft = { name: 'Ledger', description: 'd', params: { contexts: ['c1'] } };

  it('creates a view of a standard report', () => {
    expect(viewRequest({ name: 'access-review' }, draft)).toEqual({
      method: 'POST', url: '/api/report-views', body: { ...draft, reportName: 'access-review' },
    });
  });

  it('updates a view in place, or creates a new view of the SAME standard report', () => {
    const view = { name: 'view-1', view: { id: 'a/b', reportName: 'access-review' } };
    expect(viewRequest(view, draft)).toEqual({ method: 'PUT', url: '/api/report-views/a%2Fb', body: draft });
    expect(viewRequest(view, draft, { asNew: true })).toEqual({
      method: 'POST', url: '/api/report-views', body: { ...draft, reportName: 'access-review' },
    });
  });
});
