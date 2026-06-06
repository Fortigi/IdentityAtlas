// Unit tests for entityGraphShape — focused on the IDENTITY entity kind.
//
// Covers:
//   - getRootNodes('identity', core, extras): Linked Accounts + Contexts roots,
//     with recent pseudo-categories prepended when extras.recent is present.
//   - fetchCategoryItems('identity', ...): the 'accounts' kind maps members
//     WITHOUT touching authFetch; assignment kinds build the right URL and
//     annotate each item with via / viaType and a key unique per (resource,
//     account).
//   - extrasFromCore('identity', core).
//
// authFetch is a vi.fn() so we can assert when it is / isn't called.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getRootNodes, fetchCategoryItems, extrasFromCore } from './entityGraphShape.js';

// Build a fake authFetch whose resolved JSON is `rows`. Mirrors the real
// `authFetch(path).then(r => r.ok ? r.json() : [])` contract used in the module.
function makeAuthFetch(rows) {
  return vi.fn().mockResolvedValue({ ok: true, json: async () => rows });
}

describe("getRootNodes('identity', ...)", () => {
  it('returns exactly the Linked Accounts + Contexts roots with counts', () => {
    const core = { members: [{ principalId: 'a' }, { principalId: 'b' }], contextCount: 3 };
    const nodes = getRootNodes('identity', core, {});

    expect(nodes).toHaveLength(2);
    expect(nodes.map(n => n.key)).toEqual(['accounts', 'contexts']);

    const accounts = nodes.find(n => n.key === 'accounts');
    expect(accounts).toMatchObject({ key: 'accounts', label: 'Linked Accounts', count: 2, kind: 'category' });

    const contexts = nodes.find(n => n.key === 'contexts');
    expect(contexts).toMatchObject({ key: 'contexts', label: 'Contexts', count: 3, kind: 'category' });
  });

  it('defaults counts to 0 when members / contextCount are missing', () => {
    const nodes = getRootNodes('identity', {}, {});
    expect(nodes.find(n => n.key === 'accounts').count).toBe(0);
    expect(nodes.find(n => n.key === 'contexts').count).toBe(0);
  });

  it('prepends recent pseudo-categories when extras.recent is present', () => {
    const core = { members: [{ principalId: 'a' }], contextCount: 0 };
    const recent = { addedCount: 2, removedCount: 1 };
    const nodes = getRootNodes('identity', core, { recent });

    // Recent nodes come first, then the identity base roots.
    expect(nodes.map(n => n.key)).toEqual(['recently-added', 'recently-removed', 'accounts', 'contexts']);
    expect(nodes[0]).toMatchObject({ key: 'recently-added', count: 2, recent: 'added' });
    expect(nodes[1]).toMatchObject({ key: 'recently-removed', count: 1, recent: 'removed' });
  });

  it('omits a recent bucket whose count is zero', () => {
    const core = { members: [], contextCount: 0 };
    const nodes = getRootNodes('identity', core, { recent: { addedCount: 5, removedCount: 0 } });
    expect(nodes.map(n => n.key)).toEqual(['recently-added', 'accounts', 'contexts']);
  });
});

describe("fetchCategoryItems('identity', 'accounts', ...)", () => {
  beforeEach(() => vi.clearAllMocks());

  it('maps members to user items WITHOUT calling authFetch', async () => {
    const authFetch = makeAuthFetch([]);
    const members = [
      { principalId: 'p1', displayName: 'Alice' },
      { principalId: 'p2', displayName: 'Alice (adm)' },
    ];

    const items = await fetchCategoryItems('identity', 'id-1', 'accounts', authFetch, { members });

    expect(authFetch).not.toHaveBeenCalled();
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      key: 'user:p1',
      label: 'Alice',
      kind: 'item',
      entityKind: 'user',
      entityId: 'p1',
    });
    expect(items[1]).toMatchObject({ key: 'user:p2', label: 'Alice (adm)', entityKind: 'user', entityId: 'p2' });
  });

  it('returns an empty list (and no fetch) when there are no members', async () => {
    const authFetch = makeAuthFetch([]);
    const items = await fetchCategoryItems('identity', 'id-1', 'accounts', authFetch, {});
    expect(authFetch).not.toHaveBeenCalled();
    expect(items).toEqual([]);
  });
});

describe("fetchCategoryItems('identity', <assignment kind>, ...)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("builds the assignments URL with the mapped type and annotates via / viaType", async () => {
    const rows = [
      {
        resourceId: 'r1', resourceDisplayName: 'Finance Group', resourceType: 'EntraGroup',
        principalId: 'p1', principalDisplayName: 'Alice', accountType: 'regular', isPrimary: true,
      },
      {
        // same resource, different account — must produce a distinct key.
        resourceId: 'r1', resourceDisplayName: 'Finance Group', resourceType: 'EntraGroup',
        principalId: 'p2', userPrincipalName: 'adm-alice@x', accountType: 'admin', isPrimary: false,
      },
    ];
    const authFetch = makeAuthFetch(rows);

    const items = await fetchCategoryItems('identity', 'id-1', 'groups-direct', authFetch, {});

    expect(authFetch).toHaveBeenCalledTimes(1);
    expect(authFetch).toHaveBeenCalledWith('/api/identities/id-1/assignments?type=Direct');

    expect(items).toHaveLength(2);
    // Keys are unique per (resource, account): base key is `resource:<id>` then
    // `:<principalId>` is appended.
    expect(items[0].key).toBe('resource:r1:p1');
    expect(items[1].key).toBe('resource:r1:p2');
    expect(new Set(items.map(i => i.key)).size).toBe(2);

    expect(items[0]).toMatchObject({
      entityKind: 'resource', entityId: 'r1', via: 'Alice', viaType: 'regular', viaPrimary: true,
    });
    // Falls back to userPrincipalName when principalDisplayName is absent.
    expect(items[1]).toMatchObject({
      via: 'adm-alice@x', viaType: 'admin', viaPrimary: false,
    });
  });

  it('encodes the identity id and maps OAuth2Grant correctly', async () => {
    const authFetch = makeAuthFetch([]);
    await fetchCategoryItems('identity', 'id with space', 'oauth2-grants', authFetch, {});
    expect(authFetch).toHaveBeenCalledWith('/api/identities/id%20with%20space/assignments?type=OAuth2Grant');
  });

  it('treats a BusinessRole resource as an access-package item kind', async () => {
    const rows = [{
      resourceId: 'br1', resourceDisplayName: 'Treasury Role', resourceType: 'BusinessRole',
      principalId: 'p1', principalDisplayName: 'Alice',
    }];
    const authFetch = makeAuthFetch(rows);
    const items = await fetchCategoryItems('identity', 'id-1', 'groups-governed', authFetch, {});
    expect(authFetch).toHaveBeenCalledWith('/api/identities/id-1/assignments?type=Governed');
    expect(items[0].entityKind).toBe('access-package');
    expect(items[0].key).toBe('access-package:br1:p1');
  });

  it('returns [] for an unknown identity category key without calling authFetch', async () => {
    const authFetch = makeAuthFetch([]);
    const items = await fetchCategoryItems('identity', 'id-1', 'totally-unknown', authFetch, {});
    expect(authFetch).not.toHaveBeenCalled();
    expect(items).toEqual([]);
  });
});

describe("extrasFromCore('identity', core)", () => {
  it('extracts members, aggregateAssignments and contextCount', () => {
    const core = {
      members: [{ principalId: 'p1' }],
      aggregateAssignments: [{ resourceId: 'r1' }],
      contextCount: 4,
    };
    expect(extrasFromCore('identity', core)).toEqual({
      members: core.members,
      aggregateAssignments: core.aggregateAssignments,
      contextCount: 4,
    });
  });

  it('returns {} for a null core', () => {
    expect(extrasFromCore('identity', null)).toEqual({});
  });
});
