import { describe, it, expect, vi } from 'vitest';
import {
  relationOf,
  itemEdgeLabel,
  categoryRelations,
  relationItems,
  loadNeighbours,
} from '@ui/components/graph/graphNeighbours';
import { makeAuthFetch, jsonResponse } from '@ui/test-utils/renderWithProviders';

describe('relationOf', () => {
  it('reads the same relation the same way from both ends', () => {
    // member of: user → group from the user side AND from the group side.
    expect(relationOf('user', { key: 'assignments-direct' })).toEqual({ label: 'member of', dir: 'out' });
    expect(relationOf('resource', { key: 'members-direct' })).toEqual({ label: 'member of', dir: 'in' });
    expect(relationOf('user', { key: 'manager' })).toEqual({ label: 'reports to', dir: 'out' });
    expect(relationOf('user', { key: 'reports' })).toEqual({ label: 'reports to', dir: 'in' });
    expect(relationOf('identity', { key: 'accounts' })).toEqual({ label: 'linked account', dir: 'out' });
    expect(relationOf('user', { key: 'identity' })).toEqual({ label: 'linked account', dir: 'in' });
    expect(relationOf('access-package', { key: 'resources' })).toEqual({ label: 'contains', dir: 'out' });
    expect(relationOf('resource', { key: 'business-roles' })).toEqual({ label: 'contains', dir: 'in' });
    expect(relationOf('context', { key: 'members' })).toEqual({ label: 'in context', dir: 'in' });
    expect(relationOf('user', { key: 'contexts' })).toEqual({ label: 'in context', dir: 'out' });
  });

  it('labels an org entity relation by its predicate, both directions, and a link generically', () => {
    expect(relationOf('org-entity', { key: 'rel:out:eigenaar' })).toEqual({ label: 'eigenaar', dir: 'out' });
    expect(relationOf('org-entity', { key: 'rel:in:partOf' })).toEqual({ label: 'partOf', dir: 'in' });
    expect(relationOf('org-entity', { key: 'link:Resource' })).toEqual({ label: 'linked', dir: 'in', generic: true });
  });

  it('falls back on the category label, lower-cased, pointing out', () => {
    expect(relationOf('org-entity', { key: 'odd', label: 'Something Else' })).toEqual({ label: 'something else', dir: 'out' });
    expect(relationOf('user', { key: 'new-thing', label: 'New Thing' })).toEqual({ label: 'new thing', dir: 'out' });
    expect(relationOf('leaf', { key: 'x' })).toEqual({ label: 'x', dir: 'out' });
  });
});

describe('itemEdgeLabel', () => {
  it('holding an ownership resource reads as owner; anything else keeps the relation label', () => {
    expect(itemEdgeLabel('member of', { resourceType: 'GroupOwnership' })).toBe('owner');
    expect(itemEdgeLabel('member of', { resourceType: 'ApplicationOwnership' })).toBe('owner');
    expect(itemEdgeLabel('member of', { resourceType: 'Group' })).toBe('member of');
    expect(itemEdgeLabel('member of', {})).toBe('member of');
    expect(itemEdgeLabel('eligible', { resourceType: 'GroupOwnership' })).toBe('eligible');
  });
});

describe('categoryRelations', () => {
  it('drops empty categories and the recent-changes time views', () => {
    const out = categoryRelations('resource', [
      { key: 'recently-added', label: 'Recently Added', count: 3 },
      { key: 'members-direct', label: 'Direct Members', count: '1' },
      { key: 'members-eligible', label: 'Eligible', count: 0 },
      { key: 'parents', label: 'Member Of' },
    ]);
    expect(out).toEqual([{
      key: 'members-direct', categoryKey: 'members-direct', title: 'Direct Members', count: 1, items: null,
      label: 'member of', dir: 'in',
    }]);
  });
});

const GROUP = { attributes: { displayName: 'GRP-Northwind' }, assignmentByType: { Direct: 2, Eligible: 9 }, contextCount: 0 };
const ASSIGNMENTS = [
  { principalId: 'u1', principalDisplayName: 'Ann Contoso', assignmentType: 'Direct' },
  { principalId: 'u2', principalDisplayName: 'Bob Contoso', assignmentType: 'Direct' },
];
const LINKED = { total: 1, groups: [{ key: 'direct|Klant|displayName', entityType: 'Klant', via: 'displayName', kind: 'direct', label: 'Klant · name', count: 1, items: [{ entityId: 'k1', entityType: 'Klant', label: 'Northwind' }] }] };

describe('loadNeighbours', () => {
  it('loads the small relations, leaves the big ones for their cluster, and adds organisation links when on', async () => {
    const authFetch = makeAuthFetch({
      '/api/resources/g1/assignments': ASSIGNMENTS,
      '/api/org-truth/linked/Resource/g1': LINKED,
    });
    const { relations, extras } = await loadNeighbours({ kind: 'resource', id: 'g1', core: GROUP, extras: {} }, authFetch, { orgTruth: true });
    expect(extras).toEqual({});
    expect(relations.map(r => [r.key, r.label, r.dir, r.count, r.items?.length ?? null])).toEqual([
      ['members-direct', 'member of', 'in', 2, 2],
      ['members-eligible', 'eligible', 'in', 9, null],
      ['org:type:Klant', 'name', 'out', 1, 1],
    ]);
    expect(relations[0].items[0]).toMatchObject({ entityKind: 'user', entityId: 'u1', label: 'Ann Contoso', edgeLabel: 'member of' });
    // The 9 eligible members are not fetched until their cluster is opened.
    expect(authFetch.mock.calls.map(c => c[0])).toEqual(['/api/resources/g1/assignments', '/api/org-truth/linked/Resource/g1']);
  });

  it('asks nothing of the organisation lists when the feature is off', async () => {
    const authFetch = makeAuthFetch({ '/api/resources/g1/assignments': ASSIGNMENTS });
    const { relations } = await loadNeighbours({ kind: 'resource', id: 'g1', core: GROUP }, authFetch);
    expect(relations.some(r => r.key.startsWith('org:'))).toBe(false);
    expect(authFetch.mock.calls.some(c => c[0].includes('/org-truth/'))).toBe(false);
  });

  it('fetches the core of a neighbour and derives its extras', async () => {
    const ctx = { members: [{ id: 'u7', displayName: 'Cy' }], subContexts: [] };
    const authFetch = makeAuthFetch({ '/api/contexts/c1': ctx, '/api/org-truth/linked/Context/c1': jsonResponse({}, { ok: false, status: 404 }) });
    const { relations, extras } = await loadNeighbours({ kind: 'context', id: 'c1' }, authFetch, { orgTruth: true });
    expect(extras).toEqual({ members: ctx.members, subContexts: [] });
    expect(relations).toEqual([expect.objectContaining({ key: 'members', label: 'in context', dir: 'in', items: [expect.objectContaining({ entityId: 'u7' })] })]);
  });

  it('expands an org entity from its graph route, with no organisation lookup of its own', async () => {
    const graph = { core: { id: 'k1' }, categories: [{ key: 'link:Resource', label: 'Resources', count: 1 }] };
    const authFetch = makeAuthFetch({
      'graph?category=': { items: [{ key: 'resource:g1', label: 'GRP-Northwind', entityKind: 'resource', entityId: 'g1', resourceType: 'Group' }] },
      '/api/org-truth/entities/k1/graph': graph,
    });
    const { relations } = await loadNeighbours({ kind: 'org-entity', id: 'k1' }, authFetch, { orgTruth: true });
    expect(relations).toEqual([expect.objectContaining({ key: 'link:Resource', label: 'linked', generic: true, dir: 'in' })]);
    expect(relations[0].items[0]).toMatchObject({ entityKind: 'resource', entityId: 'g1', edgeLabel: 'linked' });
    expect(authFetch.mock.calls.some(c => c[0].includes('/linked/'))).toBe(false);
  });

  it('keeps a relation whose objects fail to load as an unloaded cluster, and the other relations', async () => {
    const core = { members: [{ principalId: 'p1', displayName: 'acct' }], contextCount: 2 };
    // The contexts route answers an object instead of a list: its mapping throws.
    const authFetch = makeAuthFetch({ '/api/identities/i1/contexts': { error: 'odd' } });
    const { relations } = await loadNeighbours({ kind: 'identity', id: 'i1', core }, authFetch);
    expect(relations.map(r => [r.key, r.items === null ? null : r.items.length])).toEqual([['accounts', 1], ['contexts', null]]);
  });

  it('answers null for a kind without relations or an object that cannot be loaded', async () => {
    const authFetch = makeAuthFetch({ '/api/user/u404': jsonResponse({}, { ok: false, status: 404 }) });
    expect(await loadNeighbours({ kind: 'leaf', id: 'x' }, authFetch)).toBeNull();
    expect(await loadNeighbours({ kind: 'user', id: 'u404' }, authFetch)).toBeNull();
    expect(authFetch).toHaveBeenCalledTimes(1);
  });
});

describe('relationItems', () => {
  it('answers loaded objects without a fetch', async () => {
    const authFetch = vi.fn();
    const items = [{ entityKind: 'org-entity', entityId: 'k1' }];
    expect(await relationItems({ kind: 'user', id: 'u1' }, { items }, authFetch)).toBe(items);
    expect(authFetch).not.toHaveBeenCalled();
  });

  it('fetches a cluster through the source\'s category, with its extras and per-object labels', async () => {
    const authFetch = makeAuthFetch({
      '/api/user/u1/memberships': [
        { resourceId: 'r1', resourceDisplayName: 'GRP-A', membershipType: 'Direct', resourceType: 'Group' },
        { resourceId: 'r2', resourceDisplayName: 'GRP-A owners', membershipType: 'Direct', resourceType: 'GroupOwnership' },
        { resourceId: 'r3', resourceDisplayName: 'Other', membershipType: 'Indirect', resourceType: 'Group' },
      ],
    });
    const relation = { categoryKey: 'assignments-direct', label: 'member of', items: null };
    const items = await relationItems({ kind: 'user', id: 'u1' }, relation, authFetch);
    expect(items.map(i => [i.entityId, i.edgeLabel])).toEqual([['r1', 'member of'], ['r2', 'owner']]);
  });
});
