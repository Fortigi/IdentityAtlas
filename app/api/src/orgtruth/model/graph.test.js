import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js');
import { query } from '../../db/connection.js';
import { parseCategory, shapeGraphCore, linkItem, getEntityGraph, getGraphCategory, LINK_LABELS } from './graph.js';

const ID = 'e0000000-0000-4000-8000-000000000001';
const OWNER = 'e0000000-0000-4000-8000-000000000011';
const P1 = 'c0000000-0000-4000-8000-000000000001';
const entity = { id: ID, entityType: 'Project', displayName: 'Apollo' };

beforeEach(() => { query.mockReset(); });

describe('parseCategory', () => {
  it('parses relation keys, keeping a predicate that itself contains a colon', () => {
    expect(parseCategory('rel:out:owner')).toEqual({ kind: 'rel', direction: 'out', predicate: 'owner' });
    expect(parseCategory('rel:in:part:of')).toEqual({ kind: 'rel', direction: 'in', predicate: 'part:of' });
  });
  it('parses link keys only for a known target type', () => {
    expect(parseCategory('link:Principal')).toEqual({ kind: 'link', targetType: 'Principal' });
    expect(parseCategory('link:Context')).toEqual({ kind: 'link', targetType: 'Context' });
    expect(parseCategory('link:Systems')).toBeNull();
    expect(parseCategory('link:Principal;drop')).toBeNull();
  });
  it.each([['rel:sideways:owner'], ['rel:out:'], ['owner'], [''], [undefined], [['rel:out:owner']]])('rejects %j', (k) => {
    expect(parseCategory(k)).toBeNull();
  });
});

describe('shapeGraphCore', () => {
  it('counts per direction and per system type, and orders categories out → in → links', () => {
    const rel = [
      { direction: 'in', predicate: 'partOf', n: 1 },
      { direction: 'out', predicate: 'sponsor', n: 1 },
      { direction: 'out', predicate: 'owner', n: 2 },
    ];
    const links = [{ targetType: 'Resource', n: 3 }, { targetType: 'Principal', n: 1 }];
    expect(shapeGraphCore(entity, rel, links)).toEqual({
      core: {
        id: ID, entityType: 'Project', displayName: 'Apollo',
        counts: { relationsOut: 3, relationsIn: 1, links: 4, bySystemType: { Principal: 1, Identity: 0, Resource: 3, Context: 0 } },
      },
      categories: [
        { key: 'rel:out:owner', label: 'owner →', count: 2, kind: 'category' },
        { key: 'rel:out:sponsor', label: 'sponsor →', count: 1, kind: 'category' },
        { key: 'rel:in:partOf', label: '← partOf', count: 1, kind: 'category' },
        { key: 'link:Principal', label: 'Accounts', count: 1, kind: 'category' },
        { key: 'link:Resource', label: 'Resources', count: 3, kind: 'category' },
      ],
    });
  });

  it('has zero counts and no categories for an isolated entity', () => {
    expect(shapeGraphCore(entity, [], [])).toEqual({
      core: { ...entity, counts: { relationsOut: 0, relationsIn: 0, links: 0, bySystemType: { Principal: 0, Identity: 0, Resource: 0, Context: 0 } } },
      categories: [],
    });
  });

  it('labels every link category', () => {
    expect(LINK_LABELS).toEqual({ Principal: 'Accounts', Resource: 'Resources', Identity: 'Identities', Context: 'Contexts' });
  });
});

describe('linkItem', () => {
  const link = { targetType: 'Resource', targetId: 'r1', status: 'proposed', confidence: 55 };
  it.each([
    ['Principal', 'user'], ['Resource', 'resource'], ['Identity', 'identity'], ['Context', 'context'],
  ])('maps %s to entityKind %s', (targetType, entityKind) => {
    expect(linkItem({ ...link, targetType }, { label: 'L' })).toEqual({
      key: `${entityKind}:r1`, label: 'L', kind: 'item', entityKind, entityId: 'r1', status: 'proposed', confidence: 55,
    });
  });
  it('opens a business role as an access package and carries the resource type', () => {
    expect(linkItem(link, { label: 'BR', resourceType: 'BusinessRole' })).toMatchObject({ entityKind: 'access-package', key: 'access-package:r1', resourceType: 'BusinessRole' });
    expect(linkItem(link, { label: 'G', resourceType: 'Group' })).toMatchObject({ entityKind: 'resource', resourceType: 'Group' });
  });
  it('falls back to the id when no label was found', () => {
    expect(linkItem(link, undefined).label).toBe('r1');
  });
});

describe('getEntityGraph', () => {
  it('returns null for an unknown entity without further queries', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect(await getEntityGraph(ID)).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('loads the core, relation counts and link counts for the live picture', async () => {
    query
      .mockResolvedValueOnce({ rows: [entity] })
      .mockResolvedValueOnce({ rows: [{ direction: 'out', predicate: 'owner', n: 1 }] })
      .mockResolvedValueOnce({ rows: [{ targetType: 'Principal', n: 2 }] });
    const out = await getEntityGraph(ID);
    expect(out.categories.map(c => c.key)).toEqual(['rel:out:owner', 'link:Principal']);
    expect(query.mock.calls[1][0]).toMatch(/r\.status <> 'rejected' AND r\."validTo" IS NULL/);
    expect(query.mock.calls[2][0]).toMatch(/l\."analystOverride" IS DISTINCT FROM 'rejected'/);
    expect(query.mock.calls.every(c => c[1][0] === ID)).toBe(true);
  });
});

describe('getGraphCategory', () => {
  it('returns null for an unknown entity', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect(await getGraphCategory(ID, { kind: 'rel', direction: 'out', predicate: 'owner' })).toBeNull();
  });

  it('lists related org entities in the chosen direction, predicate bound', async () => {
    query
      .mockResolvedValueOnce({ rows: [entity] })
      .mockResolvedValueOnce({ rows: [{ id: OWNER, displayName: 'Ada Contoso', entityType: 'Person', status: 'accepted' }] });
    const out = await getGraphCategory(ID, parseCategory('rel:out:owner'));
    expect(out).toEqual({ items: [{
      key: `org-entity:${OWNER}`, label: 'Ada Contoso', kind: 'item', entityKind: 'org-entity', entityId: OWNER, entityType: 'Person', status: 'accepted',
    }] });
    expect(query.mock.calls[1][0]).toMatch(/JOIN "OrgEntities" o ON o\.id = r\."toEntityId"/);
    expect(query.mock.calls[1][1]).toEqual([ID, 'owner']);
  });

  it('uses the incoming join for an rel:in key', async () => {
    query.mockResolvedValueOnce({ rows: [entity] }).mockResolvedValueOnce({ rows: [] });
    expect(await getGraphCategory(ID, parseCategory('rel:in:partOf'))).toEqual({ items: [] });
    expect(query.mock.calls[1][0]).toMatch(/JOIN "OrgEntities" o ON o\.id = r\."fromEntityId"/);
    expect(query.mock.calls[1][0]).toMatch(/WHERE r\."toEntityId" = \$1/);
  });

  it('lists the linked system objects with labels', async () => {
    query
      .mockResolvedValueOnce({ rows: [entity] })
      .mockResolvedValueOnce({ rows: [{ targetType: 'Principal', targetId: P1, confidence: 92, status: 'accepted' }] })
      .mockResolvedValueOnce({ rows: [{ id: P1, label: 'ada@contoso.example' }] });
    const out = await getGraphCategory(ID, parseCategory('link:Principal'));
    expect(out).toEqual({ items: [{
      key: `user:${P1}`, label: 'ada@contoso.example', kind: 'item', entityKind: 'user', entityId: P1, status: 'accepted', confidence: 92,
    }] });
    expect(query.mock.calls[1][1]).toEqual([ID, 'Principal']);
  });
});
