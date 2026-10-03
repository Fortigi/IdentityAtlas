import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement as h } from 'react';
import ContextAccessCounts, { accessCountParts } from './ContextAccessCounts';

const counted = {
  resourceCount: 39072, directAssignmentCount: 1200, indirectAssignmentCount: 44200,
  eligibleAssignmentCount: 0, holderCount: 8431,
};

describe('accessCountParts', () => {
  it('adds direct and via-role into the total and keeps both visible', () => {
    expect(accessCountParts(counted)).toEqual([
      '39,072 resources',
      '45,400 assignments (1,200 direct, 44,200 via a role)',
      '8,431 holders',
    ]);
  });

  it('mentions eligible access only when there is some', () => {
    expect(accessCountParts(counted).join(' ')).not.toMatch(/eligible/);
    expect(accessCountParts({ ...counted, eligibleAssignmentCount: 12 }).at(-1)).toBe('12 eligible');
  });

  it('uses the singular for exactly one', () => {
    expect(accessCountParts({
      resourceCount: 1, directAssignmentCount: 1, indirectAssignmentCount: 0, eligibleAssignmentCount: 0, holderCount: 1,
    })).toEqual(['1 resource', '1 assignment (1 direct, 0 via a role)', '1 holder']);
  });

  it('shows a counted context with nothing as zeros, not as nothing', () => {
    expect(accessCountParts({
      resourceCount: 0, directAssignmentCount: 0, indirectAssignmentCount: 0, eligibleAssignmentCount: 0, holderCount: 0,
    })).toEqual(['0 resources', '0 assignments (0 direct, 0 via a role)', '0 holders']);
  });

  it('says nothing for a context that was never counted', () => {
    expect(accessCountParts({ resourceCount: null })).toEqual([]);
    expect(accessCountParts({})).toEqual([]);
    expect(accessCountParts(undefined)).toEqual([]);
  });
});

describe('ContextAccessCounts', () => {
  it('renders the parts on one line', () => {
    const html = renderToStaticMarkup(h(ContextAccessCounts, { attrs: counted }));
    expect(html).toContain('39,072 resources · 45,400 assignments (1,200 direct, 44,200 via a role) · 8,431 holders');
  });

  it('renders nothing at all when there is nothing calculated', () => {
    expect(renderToStaticMarkup(h(ContextAccessCounts, { attrs: { resourceCount: null } }))).toBe('');
  });
});
