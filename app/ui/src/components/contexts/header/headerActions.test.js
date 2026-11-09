import { describe, it, expect } from 'vitest';
import { reportFor, offersMatrix } from './headerActions';

const APP = { id: 'app', contextCategory: 'LogicalApplication', targetType: 'Resource' };
const unit = (targetType) => ({ id: targetType, contextCategory: 'OrganizationalUnit', targetType });

describe('reportFor — the header\'s Download report', () => {
  it('an application downloads its entitlement report, whatever it holds', () => {
    expect(reportFor(APP)).toEqual({ report: 'application-access-review', title: expect.stringMatching(/^Every entitlement held here and who holds it/) });
    expect(reportFor({ ...APP, targetType: undefined }).report).toBe('application-access-review');
  });

  it('a unit of accounts or people downloads the unit report', () => {
    for (const t of ['Principal', 'Identity']) {
      expect(reportFor(unit(t)), t).toEqual({ report: 'unit-members', title: expect.stringMatching(/^Everyone in this unit with their details/) });
    }
  });

  it('a unit of resources or systems, and every other template, have none', () => {
    for (const t of ['Resource', 'System', undefined]) expect(reportFor(unit(t)), String(t)).toBeNull();
    for (const contextCategory of ['Tag', 'Segment', 'Other', null]) expect(reportFor({ ...unit('Principal'), contextCategory })).toBeNull();
    expect(reportFor(null)).toBeNull();
  });
});

describe('offersMatrix — "View in matrix" in the ⋯ menu', () => {
  it('a unit or an application, outside a read-only shell', () => {
    expect(offersMatrix(APP)).toBe(true);
    expect(offersMatrix(unit('Resource'))).toBe(true);
    expect(offersMatrix(APP, { sharedView: true })).toBe(false);
    expect(offersMatrix(unit('Principal'), { sharedView: false })).toBe(true);
  });

  it('not for a context without a template', () => {
    for (const contextCategory of ['Tag', 'Segment', null]) expect(offersMatrix({ ...APP, contextCategory })).toBe(false);
    expect(offersMatrix(undefined)).toBe(false);
  });
});
