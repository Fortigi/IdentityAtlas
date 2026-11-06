import { describe, it, expect } from 'vitest';
import { workbenchRouteId, parseWorkbenchRouteId } from './workbench.link';

describe('the workbench address', () => {
  it('is the unit alone, or the unit, an investigation and one of its roles', () => {
    expect(workbenchRouteId('u')).toBe('u');
    expect(workbenchRouteId('u', 'inv')).toBe('u:inv');
    expect(workbenchRouteId('u', 'inv', 'p')).toBe('u:inv:p');
    // A role means nothing without its investigation.
    expect(workbenchRouteId('u', null, 'p')).toBe('u');
  });

  it('reads back what it was made of; what is missing is null', () => {
    expect(parseWorkbenchRouteId('u:inv:p')).toEqual({ contextId: 'u', investigationId: 'inv', proposalId: 'p' });
    expect(parseWorkbenchRouteId('u:inv')).toEqual({ contextId: 'u', investigationId: 'inv', proposalId: null });
    expect(parseWorkbenchRouteId('u')).toEqual({ contextId: 'u', investigationId: null, proposalId: null });
    expect(parseWorkbenchRouteId('u::p')).toEqual({ contextId: 'u', investigationId: null, proposalId: null });
    expect(parseWorkbenchRouteId(undefined)).toEqual({ contextId: '', investigationId: null, proposalId: null });
  });
});
