import { describe, it, expect } from 'vitest';
import {
  ORG_ROOT_KEY,
  orgLinkedUrl,
  asOrgLinked,
  orgRootNode,
  isOrgCategory,
  groupNote,
  orgCategoryItems,
} from '@ui/components/orgtruth/orgGraphBranch';

const OWNER = {
  key: 'direct|Klant|eigenaar', entityType: 'Klant', via: 'eigenaar', kind: 'direct',
  label: 'Klant · eigenaar', count: 2, truncated: false,
  items: [
    { entityId: 'k1', entityType: 'Klant', label: 'Acme BV', detail: null },
    { entityId: 'k2', entityType: 'Klant', label: '', detail: null },
  ],
};
const WORKED = {
  key: 'through|Klant|Uren|klant', entityType: 'Klant', via: 'klant', kind: 'through', sourceType: 'Uren',
  label: 'Klant · worked on (Uren)', count: 1, truncated: false, unlinkedRows: 12,
  items: [{ entityId: 'k3', entityType: 'Klant', label: 'Beta NV', detail: '12.5 h · 3 rows · until 2026-01', hours: 12.5 }],
};
const LINKED = { total: 3, groups: [OWNER, WORKED] };

describe('orgLinkedUrl', () => {
  it('maps the four graph kinds to the endpoint target types and encodes the id', () => {
    expect(orgLinkedUrl('user', 'a b')).toBe('/api/org-truth/linked/Principal/a%20b');
    expect(orgLinkedUrl('identity', 'i1')).toBe('/api/org-truth/linked/Identity/i1');
    expect(orgLinkedUrl('resource', 'r1')).toBe('/api/org-truth/linked/Resource/r1');
    expect(orgLinkedUrl('context', 'c1')).toBe('/api/org-truth/linked/Context/c1');
  });

  it('has no url for other kinds or a missing id', () => {
    expect(orgLinkedUrl('access-package', 'x')).toBeNull();
    expect(orgLinkedUrl('org-entity', 'x')).toBeNull();
    expect(orgLinkedUrl('user', '')).toBeNull();
  });
});

describe('asOrgLinked', () => {
  it('keeps a payload with a groups array and drops anything else', () => {
    expect(asOrgLinked(LINKED)).toBe(LINKED);
    expect(asOrgLinked({ total: 0, groups: [] })).toEqual({ total: 0, groups: [] });
    expect(asOrgLinked({ error: 'off' })).toBeNull();
    expect(asOrgLinked(null)).toBeNull();
  });
});

describe('orgRootNode', () => {
  it('is null without a payload', () => {
    expect(orgRootNode(null)).toBeNull();
    expect(orgRootNode(undefined)).toBeNull();
  });

  it('carries the total as its count', () => {
    expect(orgRootNode(LINKED)).toEqual({ key: 'org', label: 'Organisation', count: 3, kind: 'category' });
  });

  it('shows a zero total as a greyed node with count 0', () => {
    expect(orgRootNode({ total: 0, groups: [] }).count).toBe(0);
    expect(orgRootNode({ groups: [] }).count).toBe(0);
  });
});

describe('isOrgCategory', () => {
  it('recognises the root and its group keys only', () => {
    expect(isOrgCategory(ORG_ROOT_KEY)).toBe(true);
    expect(isOrgCategory('org:direct|Klant|eigenaar')).toBe(true);
    expect(isOrgCategory('organisation')).toBe(false);
    expect(isOrgCategory('contexts')).toBe(false);
    expect(isOrgCategory(undefined)).toBe(false);
  });
});

describe('groupNote', () => {
  it('names the unlinked fact rows of a through group', () => {
    expect(groupNote(WORKED)).toBe('12 Uren rows point at no Klant');
  });

  it('is null when nothing is unlinked or capped', () => {
    expect(groupNote(OWNER)).toBeNull();
    expect(groupNote({ ...WORKED, unlinkedRows: 0 })).toBeNull();
  });

  it('mentions a server-side cap, alone or after the unlinked rows', () => {
    expect(groupNote({ ...OWNER, count: 250, truncated: true })).toBe('showing the first 2 of 250');
    expect(groupNote({ ...WORKED, count: 300, truncated: true }))
      .toBe('12 Uren rows point at no Klant · showing the first 1 of 300');
  });

  it('falls back when the source type is missing', () => {
    expect(groupNote({ ...WORKED, sourceType: undefined })).toBe('12 other rows point at no Klant');
  });
});

describe('orgCategoryItems', () => {
  it('returns null for a key that is not ours', () => {
    expect(orgCategoryItems('contexts', LINKED)).toBeNull();
  });

  it('fans the root out into one category node per group', () => {
    expect(orgCategoryItems('org', LINKED)).toEqual([
      { key: 'org:direct|Klant|eigenaar', label: 'Klant · eigenaar', count: 2, kind: 'category' },
      { key: 'org:through|Klant|Uren|klant', label: 'Klant · worked on (Uren)', count: 1, kind: 'category' },
    ]);
  });

  it('answers [] for the root or a group without a payload', () => {
    expect(orgCategoryItems('org', null)).toEqual([]);
    expect(orgCategoryItems('org:direct|Klant|eigenaar', undefined)).toEqual([]);
    expect(orgCategoryItems('org:nope', LINKED)).toEqual([]);
  });

  it('fans a group out into org-entity items, label falling back to the id', () => {
    const items = orgCategoryItems('org:direct|Klant|eigenaar', LINKED);
    expect(items).toEqual([
      { key: 'org-entity:k1', label: 'Acme BV', kind: 'item', entityKind: 'org-entity', entityId: 'k1', resourceType: 'Klant' },
      { key: 'org-entity:k2', label: 'k2', kind: 'item', entityKind: 'org-entity', entityId: 'k2', resourceType: 'Klant' },
    ]);
    expect(items.note).toBeUndefined();
  });

  it('carries the detail per item and the unlinked-rows note on the list', () => {
    const items = orgCategoryItems('org:through|Klant|Uren|klant', LINKED);
    expect(items[0].detail).toBe('12.5 h · 3 rows · until 2026-01');
    expect(items.note).toBe('12 Uren rows point at no Klant');
  });

  it('copes with a group that has no items array or entity type', () => {
    const odd = { total: 1, groups: [{ key: 'g', label: 'G', count: 1 }, { key: 'h', label: 'H', count: 1, items: [{ entityId: 'z' }] }] };
    expect(orgCategoryItems('org:g', odd)).toEqual([]);
    expect(orgCategoryItems('org:h', odd)).toEqual([
      { key: 'org-entity:z', label: 'z', kind: 'item', entityKind: 'org-entity', entityId: 'z' },
    ]);
    expect(orgCategoryItems('org', { groups: [{ key: 'g', label: 'G' }] })[0].count).toBe(0);
  });
});
