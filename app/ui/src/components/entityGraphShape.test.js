import { describe, it, expect } from 'vitest';
import {
  MAX_ITEMS_PER_FANOUT,
  capItems,
  getRootNodes,
  fetchCategoryItems,
  fetchEntityCore,
  isExpandableItem,
  extrasFromCore,
} from '@ui/components/entityGraphShape';

// A minimal authFetch stub: keys are URL substrings → body. Returns a
// fetch-Response-shaped object. Unmatched URLs resolve as { ok: false }.
function stub(map = {}) {
  return async (url) => {
    const key = Object.keys(map).find((k) => String(url).includes(k));
    if (key == null) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => map[key] };
  };
}

describe('capItems', () => {
  it('returns [] for null/undefined', () => {
    expect(capItems(null)).toEqual([]);
    expect(capItems(undefined)).toEqual([]);
  });

  it('returns the list unchanged when at or below the cap', () => {
    const items = Array.from({ length: MAX_ITEMS_PER_FANOUT }, (_, i) => ({ key: `k${i}` }));
    expect(capItems(items)).toBe(items);
  });

  it('caps and appends a non-clickable overflow marker when over the cap', () => {
    const items = Array.from({ length: MAX_ITEMS_PER_FANOUT + 5 }, (_, i) => ({ key: `k${i}` }));
    const out = capItems(items);
    expect(out).toHaveLength(MAX_ITEMS_PER_FANOUT);
    const overflow = out[out.length - 1];
    expect(overflow.overflow).toBe(true);
    expect(overflow.key).toBe('__overflow__');
    // 15 total, keep first 9, marker counts the remaining 6.
    expect(overflow.label).toContain('+6 more');
    // The first N-1 originals are preserved.
    expect(out.slice(0, MAX_ITEMS_PER_FANOUT - 1)).toEqual(items.slice(0, MAX_ITEMS_PER_FANOUT - 1));
  });
});

describe('getRootNodes', () => {
  it('returns [] for an unknown entity kind', () => {
    expect(getRootNodes('nope', {})).toEqual([]);
  });

  it('builds user root nodes from core counts/extras', () => {
    const core = {
      membershipByType: { Direct: 3, Indirect: 2, Eligible: 4 },
      directReportCount: 5,
      contextCount: 7,
      accessPackageCount: 2,
    };
    const nodes = getRootNodes('user', core, {
      manager: { id: 'm1', displayName: 'Boss' },
      identityInfo: { identity: { id: 'i1' } },
    });
    const by = Object.fromEntries(nodes.map((n) => [n.key, n]));
    expect(by.manager.count).toBe(1);
    expect(by.reports.count).toBe(5);
    expect(by.contexts.count).toBe(7);
    // Buckets are the universal assignmentTypes now, not "Groups (…)".
    expect(by['assignments-direct'].count).toBe(3);
    expect(by['assignments-indirect'].count).toBe(2);
    expect(by['assignments-eligible'].count).toBe(4);
    expect(by['access-packages'].count).toBe(2);
    expect(by.identity.count).toBe(1);
    // Retired buckets are gone.
    expect(by['groups-owner']).toBeUndefined();
    expect(by['oauth2-grants']).toBeUndefined();
    // Every root node is a category.
    expect(nodes.every((n) => n.kind === 'category')).toBe(true);
  });

  it('defaults user counts to 0 when core fields are missing', () => {
    const nodes = getRootNodes('user', {});
    expect(nodes.every((n) => n.count === 0)).toBe(true);
    const manager = nodes.find((n) => n.key === 'manager');
    expect(manager.count).toBe(0); // no manager extra
  });

  it('builds resource root nodes from assignmentByType', () => {
    const core = {
      assignmentByType: { Direct: 4, Indirect: 3, Eligible: 1 },
      accessPackageCount: 6,
      parentResourceCount: 9,
      contextCount: 8,
    };
    const by = Object.fromEntries(getRootNodes('resource', core).map((n) => [n.key, n]));
    expect(by['members-direct'].count).toBe(4);
    expect(by['members-indirect'].count).toBe(3);
    expect(by['members-eligible'].count).toBe(1);
    expect(by['members-governed']).toBeUndefined();
    expect(by['members-owner']).toBeUndefined();
    expect(by['business-roles'].count).toBe(6);
    expect(by.parents.count).toBe(9);
    expect(by.contexts.count).toBe(8);
  });

  it('builds access-package root nodes and coerces string counts', () => {
    const core = {
      assignmentCount: '12',
      groupCount: '3',
      attributes: { catalogId: 'cat1' },
    };
    const by = Object.fromEntries(getRootNodes('access-package', core).map((n) => [n.key, n]));
    expect(by.assignments.count).toBe(12);
    expect(by.resources.count).toBe(3);
    expect(by.catalog.count).toBe(1);
  });

  it('access-package catalog count is 0 without a catalogId', () => {
    const by = Object.fromEntries(getRootNodes('access-package', { attributes: {} }).map((n) => [n.key, n]));
    expect(by.catalog.count).toBe(0);
  });

  it('builds identity root nodes from members length + contextCount', () => {
    const core = { members: [{ principalId: 'p1' }, { principalId: 'p2' }], contextCount: 4 };
    const by = Object.fromEntries(getRootNodes('identity', core).map((n) => [n.key, n]));
    expect(by.accounts).toMatchObject({ label: 'Linked Accounts', count: 2, kind: 'category' });
    expect(by.contexts.count).toBe(4);
  });

  it('identity counts default to 0 when fields missing', () => {
    const by = Object.fromEntries(getRootNodes('identity', {}).map((n) => [n.key, n]));
    expect(by.accounts.count).toBe(0);
    expect(by.contexts.count).toBe(0);
  });

  it('builds context root nodes from members + subContexts lengths', () => {
    const core = { members: [{}, {}, {}], subContexts: [{}] };
    const by = Object.fromEntries(getRootNodes('context', core).map((n) => [n.key, n]));
    expect(by.members.count).toBe(3);
    expect(by.subcontexts.count).toBe(1);
  });

  it('prepends recent pseudo-categories ahead of the base nodes', () => {
    const nodes = getRootNodes('user', {}, {
      recent: { addedCount: 2, removedCount: 1 },
    });
    expect(nodes[0].key).toBe('recently-added');
    expect(nodes[0].recent).toBe('added');
    expect(nodes[1].key).toBe('recently-removed');
    expect(nodes[1].recent).toBe('removed');
  });

  it('omits a recent bucket whose count is zero', () => {
    const nodes = getRootNodes('user', {}, { recent: { addedCount: 0, removedCount: 3 } });
    const keys = nodes.map((n) => n.key);
    expect(keys).toContain('recently-removed');
    expect(keys).not.toContain('recently-added');
  });
});

describe('fetchCategoryItems — recent buckets (no API call)', () => {
  it('maps the cached added/removed events into item nodes', async () => {
    const recent = {
      added: [
        { counterpartyKind: 'user', counterpartyId: 'u1', counterpartyLabel: 'Alice' },
        { summary: 'something', at: '2026-01-01' },
      ],
      removed: [{ counterpartyKind: 'resource', counterpartyId: 'r1', counterpartyLabel: 'Grp' }],
    };
    const added = await fetchCategoryItems('user', 'u', 'recently-added', stub(), { recent });
    expect(added).toHaveLength(2);
    expect(added[0]).toMatchObject({ key: 'user:u1', label: 'Alice', recent: 'added', entityKind: 'user' });
    // Event without a counterpartyId falls back to leaf + at-keyed.
    expect(added[1].entityKind).toBe('leaf');
    expect(added[1].key).toBe('leaf:2026-01-01');

    const removed = await fetchCategoryItems('user', 'u', 'recently-removed', stub(), { recent });
    expect(removed[0].recent).toBe('removed');
  });

  it('returns [] when the recent bucket is empty/absent', async () => {
    const out = await fetchCategoryItems('user', 'u', 'recently-added', stub(), {});
    expect(out).toEqual([]);
  });
});

describe('fetchCategoryItems — user categories', () => {
  it('manager from extras, no fetch', async () => {
    const out = await fetchCategoryItems('user', 'u1', 'manager', stub(), {
      manager: { id: 'm1', displayName: 'Boss' },
    });
    expect(out).toEqual([
      { key: 'user:m1', label: 'Boss', kind: 'item', entityKind: 'user', entityId: 'm1' },
    ]);
  });

  it('manager returns [] when no manager extra', async () => {
    expect(await fetchCategoryItems('user', 'u1', 'manager', stub(), {})).toEqual([]);
  });

  it('reports via org-chart endpoint', async () => {
    const af = stub({ '/api/org-chart/user/': { reports: [{ id: 'r1', displayName: 'Rep' }] } });
    const out = await fetchCategoryItems('user', 'u1', 'reports', af, {});
    expect(out).toEqual([
      { key: 'user:r1', label: 'Rep', kind: 'item', entityKind: 'user', entityId: 'r1' },
    ]);
  });

  it('contexts mapped to context items', async () => {
    const af = stub({ '/contexts': [{ id: 'c1', displayName: 'Ctx' }] });
    const out = await fetchCategoryItems('user', 'u1', 'contexts', af, {});
    expect(out[0]).toMatchObject({ key: 'context:c1', entityKind: 'context' });
  });

  it('assignments-direct filters memberships by type and carries resourceType', async () => {
    const af = stub({
      '/memberships': [
        { resourceId: 'g1', resourceDisplayName: 'G1', resourceType: 'Group', membershipType: 'Direct' },
        { resourceId: 'o1', resourceDisplayName: 'O1', resourceType: 'GroupOwnership', membershipType: 'Direct' },
        { resourceId: 'br1', resourceDisplayName: 'BR', resourceType: 'BusinessRole', membershipType: 'Direct' },
        { resourceId: 'g2', groupDisplayName: 'G2', resourceType: 'Group', membershipType: 'Indirect' },
      ],
    });
    const out = await fetchCategoryItems('user', 'u1', 'assignments-direct', af, {});
    expect(out).toHaveLength(3);
    // resourceType rides along so the list can show what KIND each row is.
    expect(out[0]).toMatchObject({ key: 'resource:g1', label: 'G1', entityKind: 'resource', resourceType: 'Group' });
    expect(out[1]).toMatchObject({ resourceType: 'GroupOwnership' });
    // A BusinessRole assignment opens the access-package detail page.
    expect(out[2]).toMatchObject({ entityKind: 'access-package', resourceType: 'BusinessRole' });
  });

  it('assignments-indirect falls back to groupDisplayName', async () => {
    const af = stub({
      '/memberships': [{ resourceId: 'g2', groupDisplayName: 'G2', membershipType: 'Indirect' }],
    });
    const out = await fetchCategoryItems('user', 'u1', 'assignments-indirect', af, {});
    expect(out[0].label).toBe('G2');
  });

  it('access-packages mapped with accessPackageName', async () => {
    const af = stub({ '/access-packages': [{ resourceId: 'ap1', accessPackageName: 'AP' }] });
    const out = await fetchCategoryItems('user', 'u1', 'access-packages', af, {});
    expect(out[0]).toMatchObject({ key: 'access-package:ap1', label: 'AP', entityKind: 'access-package' });
  });

  it('identity from extras', async () => {
    const out = await fetchCategoryItems('user', 'u1', 'identity', stub(), {
      identityInfo: { identity: { id: 'i1', displayName: 'Person' } },
    });
    expect(out[0]).toMatchObject({ key: 'identity:i1', entityKind: 'identity' });
    expect(await fetchCategoryItems('user', 'u1', 'identity', stub(), {})).toEqual([]);
  });

  it('unknown user category returns []', async () => {
    expect(await fetchCategoryItems('user', 'u1', 'nope', stub(), {})).toEqual([]);
  });
});

describe('fetchCategoryItems — resource categories', () => {
  it('members-direct filters assignments by assignmentType', async () => {
    const af = stub({
      '/assignments': [
        { principalId: 'p1', principalDisplayName: 'A', assignmentType: 'Direct' },
        { principalId: 'p2', principalDisplayName: 'B', assignmentType: 'Owner' },
      ],
    });
    const out = await fetchCategoryItems('resource', 'r1', 'members-direct', af, {});
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ key: 'user:p1', label: 'A', entityKind: 'user' });
  });

  it('business-roles map to access-package items with fallback name', async () => {
    const af = stub({
      '/business-roles': [
        { businessRoleId: 'b1', businessRoleName: 'BR' },
        { businessRoleId: 'b2' },
      ],
    });
    const out = await fetchCategoryItems('resource', 'r1', 'business-roles', af, {});
    expect(out[0]).toMatchObject({ key: 'access-package:b1', label: 'BR', entityKind: 'access-package' });
    expect(out[1].label).toBe('Unnamed');
  });

  it('parents pick access-package vs resource kind by parentResourceType', async () => {
    const af = stub({
      '/parent-resources': [
        { parentResourceId: 'x1', parentDisplayName: 'Role', parentResourceType: 'BusinessRole' },
        { parentResourceId: 'x2', parentDisplayName: 'Grp', parentResourceType: 'Group' },
      ],
    });
    const out = await fetchCategoryItems('resource', 'r1', 'parents', af, {});
    expect(out[0].entityKind).toBe('access-package');
    expect(out[1].entityKind).toBe('resource');
  });

  it('contexts map to context items', async () => {
    const af = stub({ '/contexts': [{ id: 'c1', displayName: 'Ctx' }] });
    const out = await fetchCategoryItems('resource', 'r1', 'contexts', af, {});
    expect(out[0].entityKind).toBe('context');
  });

  it('unknown resource category returns []', async () => {
    expect(await fetchCategoryItems('resource', 'r1', 'nope', stub(), {})).toEqual([]);
  });
});

describe('fetchCategoryItems — access-package categories', () => {
  it('assignments map principals to user items', async () => {
    const af = stub({ '/assignments': [{ principalId: 'p1', targetDisplayName: 'User One' }] });
    const out = await fetchCategoryItems('access-package', 'ap1', 'assignments', af, {});
    expect(out[0]).toMatchObject({ key: 'user:p1', label: 'User One', entityKind: 'user' });
  });

  it('resources use the first available display name fallback', async () => {
    const af = stub({
      '/resource-roles': [
        { childResourceId: 'c1', resourceDisplayName: 'R1' },
        { childResourceId: 'c2', roleName: 'RoleOnly' },
      ],
    });
    const out = await fetchCategoryItems('access-package', 'ap1', 'resources', af, {});
    expect(out[0].label).toBe('R1');
    expect(out[1].label).toBe('RoleOnly');
  });

  it('policies/reviews/requests map to leaf items', async () => {
    const af = stub({
      '/policies': [{ id: 'pol1', displayName: 'Pol' }],
      '/reviews': [{ id: 'rev1', principalDisplayName: 'Rev' }],
      '/requests': [{ id: 'req1', requestorDisplayName: 'Req' }],
    });
    const pol = await fetchCategoryItems('access-package', 'ap1', 'policies', af, {});
    expect(pol[0]).toMatchObject({ key: 'leaf:pol1', entityKind: 'leaf', label: 'Pol' });
    const rev = await fetchCategoryItems('access-package', 'ap1', 'reviews', af, {});
    expect(rev[0].label).toBe('Rev');
    const req = await fetchCategoryItems('access-package', 'ap1', 'requests', af, {});
    expect(req[0].label).toBe('Req');
  });

  it('catalog uses extras, [] without catalogId', async () => {
    const out = await fetchCategoryItems('access-package', 'ap1', 'catalog', stub(), {
      catalogId: 'cat1', catalogName: 'Catalog One',
    });
    expect(out[0]).toMatchObject({ key: 'leaf:cat1', label: 'Catalog One', entityKind: 'leaf' });
    expect(await fetchCategoryItems('access-package', 'ap1', 'catalog', stub(), {})).toEqual([]);
  });
});

describe('fetchCategoryItems — identity categories', () => {
  it('accounts come from extras.members, no fetch', async () => {
    const out = await fetchCategoryItems('identity', 'i1', 'accounts', stub(), {
      members: [{ principalId: 'p1', displayName: 'Acct' }],
    });
    expect(out[0]).toMatchObject({ key: 'user:p1', label: 'Acct', entityKind: 'user' });
    expect(await fetchCategoryItems('identity', 'i1', 'accounts', stub(), {})).toEqual([]);
  });

  it('contexts fetched via endpoint', async () => {
    const af = stub({ '/contexts': [{ id: 'c1', displayName: 'Ctx' }] });
    const out = await fetchCategoryItems('identity', 'i1', 'contexts', af, {});
    expect(out[0].entityKind).toBe('context');
  });

  it('assignment categories annotate items with via/viaType/viaPrimary and unique keys', async () => {
    const af = stub({
      '/assignments': [
        {
          resourceId: 'r1', resourceDisplayName: 'Res1', resourceType: 'Group',
          principalId: 'p1', principalDisplayName: 'Acct A', accountType: 'cloud', isPrimary: true,
        },
        {
          resourceId: 'r2', resourceDisplayName: 'BR', resourceType: 'BusinessRole',
          userPrincipalName: 'upn@x', accountType: 'onprem', isPrimary: false,
        },
      ],
    });
    const out = await fetchCategoryItems('identity', 'i1', 'assignments-direct', af, {});
    expect(out[0]).toMatchObject({
      key: 'resource:r1:p1', entityKind: 'resource', resourceType: 'Group', via: 'Acct A', viaType: 'cloud', viaPrimary: true,
    });
    // BusinessRole resourceType → access-package kind; via falls back to UPN; no principalId in key.
    expect(out[1]).toMatchObject({
      key: 'access-package:r2:', entityKind: 'access-package', resourceType: 'BusinessRole', via: 'upn@x', viaPrimary: false,
    });
  });

  it('unknown identity category returns []', async () => {
    expect(await fetchCategoryItems('identity', 'i1', 'nope', stub(), {})).toEqual([]);
  });
});

describe('fetchCategoryItems — context categories', () => {
  it('members and subcontexts come from extras', async () => {
    const extras = {
      members: [{ id: 'm1', displayName: 'M1' }],
      subContexts: [{ id: 's1', displayName: 'S1' }],
    };
    const members = await fetchCategoryItems('context', 'c1', 'members', stub(), extras);
    expect(members[0]).toMatchObject({ key: 'user:m1', entityKind: 'user' });
    const subs = await fetchCategoryItems('context', 'c1', 'subcontexts', stub(), extras);
    expect(subs[0]).toMatchObject({ key: 'context:s1', entityKind: 'context' });
  });
});

describe('fetchCategoryItems — recent tagging of regular fanouts', () => {
  it('tags items whose entityId is in recent.addedIds', async () => {
    const af = stub({
      '/assignments': [
        { principalId: 'p1', principalDisplayName: 'A', assignmentType: 'Direct' },
        { principalId: 'p2', principalDisplayName: 'B', assignmentType: 'Direct' },
      ],
    });
    const out = await fetchCategoryItems('resource', 'r1', 'members-direct', af, {
      recent: { addedIds: new Set(['p1']) },
    });
    expect(out.find((i) => i.entityId === 'p1').recent).toBe('added');
    expect(out.find((i) => i.entityId === 'p2').recent).toBeUndefined();
  });
});

describe('fetchEntityCore', () => {
  it('returns the parsed core for a known kind', async () => {
    const af = stub({ '/api/user/': { id: 'u1', contextCount: 2 } });
    expect(await fetchEntityCore('user', 'u1', af)).toEqual({ id: 'u1', contextCount: 2 });
  });

  it('returns null for an unknown kind (no URL)', async () => {
    expect(await fetchEntityCore('nope', 'x', stub())).toBeNull();
  });

  it('returns null when the response is not ok', async () => {
    const af = async () => ({ ok: false, status: 500, json: async () => ({}) });
    expect(await fetchEntityCore('user', 'u1', af)).toBeNull();
  });
});

describe('isExpandableItem', () => {
  it('true for drillable kinds, false otherwise', () => {
    for (const k of ['user', 'resource', 'access-package', 'identity', 'context']) {
      expect(isExpandableItem(k)).toBe(true);
    }
    expect(isExpandableItem('leaf')).toBe(false);
    expect(isExpandableItem('policy')).toBe(false);
    expect(isExpandableItem(undefined)).toBe(false);
  });
});

describe('extrasFromCore', () => {
  it('returns {} for null core', () => {
    expect(extrasFromCore('user', null)).toEqual({});
  });

  it('access-package pulls catalog id/name from attributes', () => {
    expect(extrasFromCore('access-package', { attributes: { catalogId: 'c', catalogName: 'N' } }))
      .toEqual({ catalogId: 'c', catalogName: 'N' });
  });

  it('identity pulls members/aggregateAssignments/contextCount', () => {
    const core = { members: [{ id: 'p' }], aggregateAssignments: [1], contextCount: 3 };
    expect(extrasFromCore('identity', core)).toEqual({
      members: [{ id: 'p' }], aggregateAssignments: [1], contextCount: 3,
    });
  });

  it('context pulls members/subContexts', () => {
    expect(extrasFromCore('context', { members: [1], subContexts: [2] }))
      .toEqual({ members: [1], subContexts: [2] });
  });

  it('user carries linkedResource; resource gets no extras', () => {
    expect(extrasFromCore('user', { foo: 1 })).toEqual({ linkedResource: undefined });
    expect(extrasFromCore('user', { linkedResource: { id: 'r1' } })).toEqual({ linkedResource: { id: 'r1' } });
    expect(extrasFromCore('resource', { foo: 1 })).toEqual({});
  });
});

describe('principal→principal relationship nodes (owners / sponsors / linked resource)', () => {
  it('adds owner/sponsor/reverse + linked-resource nodes only when present', () => {
    const core = {
      ownerCount: 2, sponsorCount: 1, ownedAgentCount: 3, sponsoredGuestCount: 4,
      linkedResource: { id: 'app1', displayName: 'HR Copilot', resourceType: 'Application' },
    };
    const by = Object.fromEntries(getRootNodes('user', core).map((n) => [n.key, n]));
    expect(by.owners.count).toBe(2);
    expect(by.sponsors.count).toBe(1);
    expect(by['owned-agents'].count).toBe(3);
    expect(by['sponsored-guests'].count).toBe(4);
    expect(by['linked-resource'].count).toBe(1);
  });

  it('omits every relationship node when the counts are zero / absent', () => {
    const by = Object.fromEntries(getRootNodes('user', {}).map((n) => [n.key, n]));
    for (const k of ['owners', 'sponsors', 'owned-agents', 'sponsored-guests', 'linked-resource']) {
      expect(by[k]).toBeUndefined();
    }
  });

  it('linked-resource item comes from extras and opens the resource page', async () => {
    const out = await fetchCategoryItems('user', 'u1', 'linked-resource', stub(), {
      linkedResource: { id: 'app1', displayName: 'HR Copilot', resourceType: 'Application' },
    });
    expect(out[0]).toMatchObject({ key: 'resource:app1', entityKind: 'resource', resourceType: 'Application' });
    expect(await fetchCategoryItems('user', 'u1', 'linked-resource', stub(), {})).toEqual([]);
  });

  it.each([
    ['owners', 'type=Owner&reverse=false'],
    ['sponsors', 'type=Sponsor&reverse=false'],
    ['owned-agents', 'type=Owner&reverse=true'],
    ['sponsored-guests', 'type=Sponsor&reverse=true'],
  ])('%s hits the principal-relationships endpoint with %s', async (categoryKey, query) => {
    let calledUrl = '';
    const af = async (url) => {
      calledUrl = String(url);
      return { ok: true, status: 200, json: async () => [{ principalId: 'p9', displayName: 'Counterparty' }] };
    };
    const out = await fetchCategoryItems('user', 'u1', categoryKey, af, {});
    expect(calledUrl).toContain('/api/user/u1/principal-relationships?');
    expect(calledUrl).toContain(query);
    expect(out[0]).toMatchObject({ key: 'user:p9', label: 'Counterparty', entityKind: 'user' });
  });
});

describe('toItem behaviour via item shapes', () => {
  it('falls back label to id then (unknown), and uses empty id when missing', async () => {
    // A member with no id/displayName exercises the `(unknown)` + '' id path.
    const out = await fetchCategoryItems('context', 'c1', 'members', stub(), {
      members: [{}],
    });
    expect(out[0]).toMatchObject({ key: 'user:', label: '(unknown)', entityId: '' });
  });
});
