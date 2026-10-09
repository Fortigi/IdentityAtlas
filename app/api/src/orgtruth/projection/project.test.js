import { describe, it, expect } from 'vitest';
import {
  buildProjection, projectedTypes, linkMemberId, isLive,
  ROOT_EXTERNAL_ID, typeExternalId, entityExternalId,
} from './project.js';
import { E, SOURCE_ID, entities, relations, links, memberMap } from './__tests__/projectionFixture.js';

const input = { entities, relations, links };

describe('isLive', () => {
  it('is true only for an accepted row with no validTo', () => {
    expect(isLive({ status: 'accepted', validTo: null })).toBe(true);
    expect(isLive({ status: 'accepted' })).toBe(true);
    expect(isLive({ status: 'accepted', validTo: '2026-01-01' })).toBe(false);
    expect(isLive({ status: 'proposed', validTo: null })).toBe(false);
    expect(isLive({ status: 'rejected', validTo: null })).toBe(false);
  });
});

describe('linkMemberId', () => {
  const base = { targetId: 'T', principalId: 'P', memberOverride: null };
  it('passes the target through when the link points at the member type', () => {
    expect(linkMemberId({ ...base, targetType: 'Resource' }, 'Resource')).toBe('T');
    expect(linkMemberId({ ...base, targetType: 'Principal' }, 'Principal')).toBe('T');
  });
  it('expands an Identity link to its account for Principal members only', () => {
    expect(linkMemberId({ ...base, targetType: 'Identity' }, 'Principal')).toBe('P');
    expect(linkMemberId({ ...base, targetType: 'Identity' }, 'Resource')).toBeNull();
  });
  it('drops an identity account the analyst rejected, or an identity with no accounts', () => {
    expect(linkMemberId({ ...base, targetType: 'Identity', memberOverride: 'rejected' }, 'Principal')).toBeNull();
    expect(linkMemberId({ ...base, targetType: 'Identity', principalId: null }, 'Principal')).toBeNull();
  });
  it('ignores a target type that is neither the member type nor an identity', () => {
    expect(linkMemberId({ ...base, targetType: 'Context' }, 'Principal')).toBeNull();
    expect(linkMemberId({ ...base, targetType: 'Principal' }, 'Resource')).toBeNull();
  });
});

describe('projectedTypes', () => {
  const ents = [
    { id: 'a', entityType: 'Project' }, { id: 'b', entityType: 'Team' }, { id: 'c', entityType: 'Asset' },
  ];
  it('defaults to the types that have at least one link, sorted', () => {
    expect(projectedTypes(ents, [{ entityId: 'c' }, { entityId: 'a' }], undefined)).toEqual(['Asset', 'Project']);
    expect(projectedTypes(ents, [{ entityId: 'a' }], [])).toEqual(['Project']);
    expect(projectedTypes(ents, [], undefined)).toEqual([]);
  });
  it('uses an explicit list, linked or not, but never a type with no entity', () => {
    expect(projectedTypes(ents, [], ['Team', 'Nonexistent'])).toEqual(['Team']);
  });
  it('also projects a type reached through one relation from a linked entity (the project whose owner is linked)', () => {
    // Only the Team is linked; the Project is one relation away, the Asset is two.
    const related = new Map([['a', new Set(['b'])], ['b', new Set(['a'])], ['c', new Set(['a'])]]);
    expect(projectedTypes(ents, [{ entityId: 'b' }], undefined, related)).toEqual(['Project', 'Team']);
    expect(projectedTypes(ents, [{ entityId: 'b' }], [], new Map())).toEqual(['Team']);
  });
});

describe('buildProjection — Resource members', () => {
  const out = buildProjection(input, { memberType: 'Resource' });

  it('builds root → one node per linked type → one node per live entity', () => {
    expect(out.contexts.map(c => [c.externalId, c.parentExternalId, c.contextType])).toEqual([
      [ROOT_EXTERNAL_ID, undefined, 'OrganisationTruth'],
      ['org:type:Person', ROOT_EXTERNAL_ID, 'OrganisationEntityType'],
      ['org:type:Project', ROOT_EXTERNAL_ID, 'OrganisationEntityType'],
      ['org:type:Team', ROOT_EXTERNAL_ID, 'OrganisationEntityType'],
      [`org:${E.P1}`, 'org:type:Project', 'Project'],
      [`org:${E.P2}`, 'org:type:Project', 'Project'],
      [`org:${E.U1}`, 'org:type:Person', 'Person'],
      [`org:${E.U2}`, 'org:type:Person', 'Person'],
      [`org:${E.T1}`, 'org:type:Team', 'Team'],
    ]);
    expect(out.contexts[0].displayName).toBe('Organisation truth');
    expect(out.contexts[2].displayName).toBe('Project');
    expect(out.contexts[2].description).toBe('Organisation entities of type Project');
  });

  it('never makes a context of a proposed or closed entity', () => {
    const ids = out.contexts.map(c => c.externalId);
    expect(ids).not.toContain(`org:${E.P3}`);
    expect(ids).not.toContain(`org:${E.P4}`);
  });

  it('names an entity context after the entity and carries its attributes plus provenance', () => {
    const apollo = out.contexts.find(c => c.externalId === `org:${E.P1}`);
    expect(apollo.displayName).toBe('Apollo');
    expect(apollo.extendedAttributes).toEqual({
      budget: 100, costCenter: 'CC-7', orgEntityId: E.P1, sourceId: SOURCE_ID, observedAt: '2026-09-30T00:00:00.000Z',
    });
  });

  it('members = own accepted links + one hop over accepted, open relations', () => {
    expect(memberMap(out.members)).toEqual({
      [`org:${E.P1}`]: ['G1'],            // G2 proposed, G3 analyst-rejected, G9 via a proposed entity, G7 two hops
      [`org:${E.U1}`]: ['G1', 'G7'],      // one hop either direction: P1 (from) and T1 (to)
      [`org:${E.T1}`]: ['G7'],
    });
  });

  it('keeps an unlinked entity as a context with no members (a finding)', () => {
    expect(out.contexts.some(c => c.externalId === `org:${E.P2}`)).toBe(true);
    expect(out.members.some(m => m.contextExternalId === `org:${E.P2}`)).toBe(false);
  });
});

describe('buildProjection — Principal members', () => {
  const out = buildProjection(input, { memberType: 'Principal' });

  it('expands identity links to their accounts and carries them one hop', () => {
    expect(memberMap(out.members)).toEqual({
      [`org:${E.P1}`]: ['A1', 'A2', 'A3'],   // the owner's accounts; A4 rejected on the identity; B1 only via a closed relation
      [`org:${E.U1}`]: ['A1', 'A2', 'A3'],
      [`org:${E.U2}`]: ['B1'],               // I2 has no accounts; the proposed/rejected relations to P2 give nothing
      [`org:${E.T1}`]: ['A1', 'A2', 'A3'],
    });
  });

  it('emits each member once per context even when two paths lead to it', () => {
    const dup = buildProjection({
      entities: [entities[0], entities[4]],
      relations: [relations[0], { fromEntityId: E.U1, toEntityId: E.P1, status: 'accepted', validTo: null }],
      links: [links[3], { ...links[3], entityId: E.P1 }],
    }, { memberType: 'Principal' });
    expect(memberMap(dup.members)).toEqual({ [`org:${E.P1}`]: ['A1'], [`org:${E.U1}`]: ['A1'] });
  });
});

describe('buildProjection — parameters and edge cases', () => {
  it('projects only the requested types', () => {
    const out = buildProjection(input, { memberType: 'Resource', entityTypes: ['Project', 'Nonexistent'] });
    expect(out.contexts.map(c => c.externalId)).toEqual([
      ROOT_EXTERNAL_ID, typeExternalId('Project'), entityExternalId(E.P1), entityExternalId(E.P2),
    ]);
    expect(memberMap(out.members)).toEqual({ [`org:${E.P1}`]: ['G1'] });
  });

  it('still uses a relation to an entity of a type that is not projected', () => {
    const out = buildProjection(input, { memberType: 'Principal', entityTypes: ['Project'] });
    expect(memberMap(out.members)).toEqual({ [`org:${E.P1}`]: ['A1', 'A2', 'A3'] });
  });

  it('emits nothing at all — not even a root — when nothing is projected', () => {
    expect(buildProjection({ entities, relations, links: [] }, { memberType: 'Resource' }))
      .toEqual({ contexts: [], members: [] });
    expect(buildProjection({ entities: [], relations: [], links: [] }, { memberType: 'Resource', entityTypes: ['Project'] }))
      .toEqual({ contexts: [], members: [] });
  });

  it('treats non-object attributes as none and passes a string observedAt through', () => {
    const odd = { ...entities[1], attributes: ['x'], observedAt: '2026-01-02T00:00:00Z' };
    const out = buildProjection({ entities: [odd], relations: [], links: [] }, { memberType: 'Resource', entityTypes: ['Project'] });
    expect(out.contexts[2].extendedAttributes).toEqual({ orgEntityId: E.P2, sourceId: SOURCE_ID, observedAt: '2026-01-02T00:00:00Z' });
    const nulls = buildProjection({ entities: [{ ...odd, attributes: null, observedAt: undefined }], relations: [], links: [] },
      { memberType: 'Resource', entityTypes: ['Project'] });
    expect(nulls.contexts[2].extendedAttributes).toEqual({ orgEntityId: E.P2, sourceId: SOURCE_ID, observedAt: null });
  });
});
