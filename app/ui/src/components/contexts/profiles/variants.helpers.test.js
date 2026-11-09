import { describe, it, expect } from 'vitest';
import { memberCount, sameUnitLinks, linksNeedingCount, buildVariants, variantLabel } from './variants.helpers';
import { profileFor } from './profiles';

const link = (id, targetType, displayName = 'Contoso', extra = {}) => ({
  id: `rel-${id}`, relationshipType: 'SameUnitAs', relatedContextId: id, relatedDisplayName: displayName, relatedTargetType: targetType, ...extra,
});

describe('memberCount', () => {
  it('prefers the total, falls back to direct members, else unknown', () => {
    expect(memberCount({ totalMemberCount: 9, directMemberCount: 2 })).toBe(9);
    expect(memberCount({ directMemberCount: 2 })).toBe(2);
    expect(memberCount({ totalMemberCount: 0, directMemberCount: 4 })).toBe(0);
    expect(memberCount({})).toBeNull();
    expect(memberCount(null)).toBeNull();
  });
});

describe('sameUnitLinks', () => {
  it('keeps SameUnitAs links only, and nothing from a non-array body', () => {
    const rows = [link('a', 'Principal'), { relationshipType: 'Other', relatedContextId: 'b' }, { relationshipType: 'SameUnitAs' }];
    expect(sameUnitLinks(rows).map(l => l.relatedContextId)).toEqual(['a']);
    expect(sameUnitLinks({ attributes: {} })).toEqual([]);
  });
});

describe('linksNeedingCount', () => {
  it('skips links that carry a count or were already looked up', () => {
    const links = [link('a', 'Principal'), link('b', 'Resource', 'C', { relatedTotalMemberCount: 3 }), link('c', 'Resource')];
    expect(linksNeedingCount(links, new Map([['c', 4]])).map(l => l.relatedContextId)).toEqual(['a']);
  });

  it('counts a failed lookup (null) as looked up, so it is not retried forever', () => {
    expect(linksNeedingCount([link('a', 'Principal')], new Map([['a', null]]))).toEqual([]);
  });
});

describe('buildVariants', () => {
  const self = { id: 'me', displayName: 'Contoso', targetType: 'Principal', totalMemberCount: 15 };

  it('puts this context among its variants in People · Accounts · Resources order with counts', () => {
    const links = [link('res', 'Resource', 'Contoso', { relatedTotalMemberCount: 31 }), link('ppl', 'Identity')];
    expect(buildVariants(self, links, new Map([['ppl', 12]]))).toEqual([
      { id: 'ppl', displayName: 'Contoso', targetType: 'Identity', count: 12, self: false },
      { id: 'me', displayName: 'Contoso', targetType: 'Principal', count: 15, self: true },
      { id: 'res', displayName: 'Contoso', targetType: 'Resource', count: 31, self: false },
    ]);
  });

  it('leaves an unknown count null and sorts unknown kinds last, then by name', () => {
    const v = buildVariants(self, [link('sys', 'System', 'B'), link('acc2', 'Principal', 'Aardvark')], new Map());
    expect(v.map(x => x.id)).toEqual(['acc2', 'me', 'sys']);
    expect(v[0].count).toBeNull();
  });
});

describe('variantLabel', () => {
  it('says the kind and the count, or a dash while unknown', () => {
    expect(variantLabel({ targetType: 'Identity', count: 12 })).toBe('People 12');
    expect(variantLabel({ targetType: 'Resource', count: 0 })).toBe('Resources 0');
    expect(variantLabel({ targetType: 'Principal', count: null })).toBe('Accounts —');
  });
});

describe('profileFor', () => {
  it('gives units and applications a profile and leaves the rest generic', () => {
    expect(profileFor('OrganizationalUnit').accountableLabel).toBe('Accountable');
    expect(profileFor('LogicalApplication').accountableLabel).toBe('Owner');
    for (const c of ['Tag', 'Segment', null, 'Gadget']) expect(profileFor(c)).toBeNull();
  });
});
