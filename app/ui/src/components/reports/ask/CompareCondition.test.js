import { describe, it, expect } from 'vitest';
import { referenceEntities, newCompareCondition } from './CompareCondition';

const rel = (name, target, cardinality = 'many') => ({ name, label: name, target, cardinality });
const CATALOG = {
  entities: {
    user: { table: 'Principals', compareRelations: ['memberOf', 'access'], relations: [rel('manager', 'user', 'one'), rel('memberOf', 'group'), rel('access', 'resource')] },
    account: { table: 'Principals', compareRelations: ['memberOf', 'access'], relations: [rel('memberOf', 'group'), rel('access', 'resource')] },
    group: { table: 'Resources', compareRelations: ['members', 'owners'], relations: [rel('members', 'account'), rel('owners', 'account')] },
    resource: { table: 'Resources', compareRelations: ['members', 'owners'], relations: [rel('members', 'account'), rel('owners', 'account')] },
  },
};

describe('compare condition helpers', () => {
  it('offers only references that have the same relation to the same kind of thing', () => {
    // A group's members can be compared with any group or resource (e.g. a business role) — not with a user.
    expect(referenceEntities(CATALOG, 'group', 'members')).toEqual(['group', 'resource']);
    expect(referenceEntities(CATALOG, 'user', 'memberOf')).toEqual(['user', 'account']);
    expect(referenceEntities(CATALOG, 'user', 'nope')).toEqual([]);
  });

  it('starts a new comparison on the first comparable relation with an empty name', () => {
    expect(newCompareCondition(CATALOG, 'group')).toEqual({
      type: 'compare', relation: 'members', measure: 'identical', reference: { entity: 'group', name: '' },
    });
  });
});
