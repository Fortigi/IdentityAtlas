import { describe, it, expect } from 'vitest';
import { REFERENCE_LABELS, referenceDetail, moreText, formatCount } from './memberReferences.helpers';

describe('referenceDetail', () => {
  it('reads a held resource as type · system · assignment type', () => {
    expect(referenceDetail('resources', { displayName: 'x', resourceType: 'Group', systemName: 'Entra ID', assignmentType: 'Eligible' }))
      .toBe('Group · Entra ID · Eligible');
  });

  it('leaves out an empty part rather than printing a gap', () => {
    expect(referenceDetail('resources', { resourceType: null, systemName: 'Entra ID', assignmentType: 'Direct' })).toBe('Entra ID · Direct');
  });

  it('reads a business role by system and assignment type', () => {
    expect(referenceDetail('businessRoles', { systemName: 'Omada', assignmentType: 'Direct' })).toBe('Omada · Direct');
  });

  it('reads a holder\'s account type in words, and a person as Person', () => {
    expect(referenceDetail('holders', { holderType: 'ServicePrincipal', assignmentType: 'Indirect' })).toBe('Service account · Indirect');
    expect(referenceDetail('holders', { holderType: 'Person', assignmentType: 'Direct' })).toBe('Person · Direct');
    expect(referenceDetail('holders', { holderType: null, assignmentType: 'Direct' })).toBe('Direct');
  });

  it('reads another context by its type', () => {
    expect(referenceDetail('contexts', { contextType: 'Department', targetType: 'Identity' })).toBe('Department');
  });

  it('says nothing for a group it does not know', () => {
    expect(referenceDetail('somethingElse', { contextType: 'Department' })).toBe('');
  });
});

describe('moreText', () => {
  it('is null when the group lists everything — 50 of 50', () => {
    expect(moreText({ total: 50, items: new Array(50).fill({}) })).toBeNull();
  });

  it('counts the rest — 50 of 51 is "+ 1 more"', () => {
    expect(moreText({ total: 51, items: new Array(50).fill({}) })).toBe('+ 1 more');
  });

  it('groups thousands', () => {
    expect(moreText({ total: 1284, items: new Array(50).fill({}) })).toBe('+ 1,234 more');
    expect(formatCount(12345)).toBe('12,345');
  });
});

it('labels the four groups', () => {
  expect(REFERENCE_LABELS).toEqual({
    resources: 'Groups & resources', businessRoles: 'Business roles', contexts: 'Other contexts', holders: 'Held by',
  });
});
