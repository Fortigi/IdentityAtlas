import { describe, it, expect } from 'vitest';
import {
  expectedTypeFor, cellDeviation, buildRoleDeviationCounts, heldOutsideRoleCount, NO_DEVIATION,
} from './coverageDeviation';

// SOLL mapping as MatrixView builds it: "RESOURCEID|roleid" → role name on the
// Contains edge. BR1 grants G1 as a member and G2 just-in-time.
const AP_GROUP_MAP = new Map([
  ['G1|br1', 'Member'],
  ['G2|br1', 'Eligible Member'],
]);

const types = (...t) => new Set(t);
const deviate = (props) => cellDeviation({ apGroupMap: AP_GROUP_MAP, ...props });

describe('expectedTypeFor', () => {
  it('reads an eligible role name as just-in-time and everything else as standing', () => {
    expect(expectedTypeFor('Eligible Member')).toBe('Eligible');
    expect(expectedTypeFor('Member')).toBe('Direct');
    expect(expectedTypeFor(null)).toBe('Direct');
  });
});

describe('cellDeviation', () => {
  it('reports nothing for a cell no business role covers', () => {
    expect(deviate({ types: types('Direct'), apIds: [], resourceKey: 'G1' })).toBe(NO_DEVIATION);
  });

  it('reports FEWER when the role assigns a membership the subject does not have', () => {
    expect(deviate({ types: undefined, apIds: ['br1'], resourceKey: 'G1' }))
      .toEqual({ missing: ['Direct'], excess: [] });
  });

  it('names the just-in-time membership when that is what is missing', () => {
    expect(deviate({ types: types(), apIds: ['br1'], resourceKey: 'G2' }))
      .toEqual({ missing: ['Eligible'], excess: [] });
  });

  it('reports MORE when the subject holds permanently what the role grants just-in-time', () => {
    expect(deviate({ types: types('Direct'), apIds: ['br1'], resourceKey: 'G2' }))
      .toEqual({ missing: [], excess: ['Eligible'] });
    // Inherited standing access counts the same — it stands without activation.
    expect(deviate({ types: types('Indirect'), apIds: ['br1'], resourceKey: 'G2' }).excess)
      .toEqual(['Eligible']);
  });

  it('accepts eligible access where the role grants it', () => {
    expect(deviate({ types: types('Eligible'), apIds: ['br1'], resourceKey: 'G2' })).toBe(NO_DEVIATION);
  });

  it('accepts eligible access where the role assigns a standing membership', () => {
    // Holding a role eligibly rather than actively is a legitimate way to hold
    // what it assigns — not an under-grant.
    expect(deviate({ types: types('Eligible'), apIds: ['br1'], resourceKey: 'G1' })).toBe(NO_DEVIATION);
  });

  it('does not call a standing membership excessive when any role assigns one', () => {
    const map = new Map([['G2|br1', 'Eligible Member'], ['G2|br2', 'Member']]);
    expect(cellDeviation({ types: types('Direct'), apIds: ['br1', 'br2'], apGroupMap: map, resourceKey: 'G2' }))
      .toBe(NO_DEVIATION);
  });

  it('treats an unmapped role as assigning a standing membership', () => {
    expect(deviate({ types: types(), apIds: ['unknown'], resourceKey: 'G9' }).missing).toEqual(['Direct']);
  });
});

describe('heldOutsideRoleCount', () => {
  // BR1 grants this row; the subject either got it through a business role they
  // hold or from somewhere else entirely.
  const outside = (props) => heldOutsideRoleCount({ roleGrantIds: ['BR1'], ...props });

  it('counts the granting role when the subject holds the resource without it', () => {
    expect(outside({ types: types('Direct'), apIds: [] })).toBe(1);
  });

  it('says nothing when the role that grants it is what the subject holds it through', () => {
    expect(outside({ types: types('Indirect'), apIds: ['br1'] })).toBe(0);
  });

  it('says nothing for a row no business role in the grid grants', () => {
    expect(heldOutsideRoleCount({ types: types('Direct'), roleGrantIds: [], apIds: [] })).toBe(0);
    expect(heldOutsideRoleCount({ types: types('Direct'), apIds: [] })).toBe(0);
  });

  it('says nothing when the subject holds nothing — that is a gap, not excess', () => {
    expect(outside({ types: undefined, apIds: [] })).toBe(0);
    expect(outside({ types: types(), apIds: [] })).toBe(0);
  });

  it('counts every granting role when none of them accounts for the access', () => {
    expect(heldOutsideRoleCount({ types: types('Direct'), roleGrantIds: ['BR1', 'BR2'], apIds: [] })).toBe(2);
  });

  it('is all-or-nothing: one covering role already explains the access', () => {
    expect(heldOutsideRoleCount({
      types: types('Direct'), roleGrantIds: ['BR1', 'BR2'], apIds: ['br2'],
    })).toBe(0);
  });

  // A role only covers a cell by granting the resource to someone who holds the
  // role, so a covering role explains the membership even when it has no row in
  // this matrix. Marking such a cell red claimed the subject's access was
  // outside business-role governance when a role of theirs did account for it.
  it('says nothing when a covering role has no row of its own in the grid', () => {
    expect(outside({ types: types('Indirect'), apIds: ['br-off-grid'] })).toBe(0);
  });
});

describe('buildRoleDeviationCounts', () => {
  // BR1 folded away G1 (member) and G2 (eligible). Three subjects:
  //   u1 — exactly what the role assigns
  //   u2 — holds the role, missing G1, permanent on G2  → fewer AND more
  //   u3 — does not hold the role but holds G1 anyway   → more
  const foldedChildRows = new Map([['BR1', [{ id: 'G1' }, { id: 'G2' }]]]);
  const users = [{ id: 'u1' }, { id: 'u2' }, { id: 'u3' }];
  const memberships = new Map([
    ['G1|u1', types('Direct')], ['G2|u1', types('Eligible')],
    ['G2|u2', types('Direct')],
    ['G1|u3', types('Direct')],
  ]);
  const managedApMap = new Map([
    ['g1|u1', ['br1']], ['g2|u1', ['br1']],
    ['g1|u2', ['br1']], ['g2|u2', ['br1']],
  ]);
  const build = (extra = {}) => buildRoleDeviationCounts({
    foldedChildRows, users, memberships, managedApMap, apGroupMap: AP_GROUP_MAP, ...extra,
  });

  it('is null while nothing is folded', () => {
    expect(buildRoleDeviationCounts({ foldedChildRows: new Map(), users })).toBeNull();
    expect(buildRoleDeviationCounts({})).toBeNull();
  });

  it('leaves a subject who holds exactly what the role assigns uncounted', () => {
    const { extra, missing } = build();
    expect(extra.get('BR1|u1')).toBeUndefined();
    expect(missing.get('BR1|u1')).toBeUndefined();
  });

  it('counts fewer and more for the same subject at the same time', () => {
    const { extra, missing } = build();
    expect(missing.get('BR1|u2')).toBe(1); // G1 assigned, not held
    expect(extra.get('BR1|u2')).toBe(1);   // G2 held permanently, granted just-in-time
  });

  it('counts access the role does not cover for this subject at all', () => {
    const { extra, missing } = build();
    expect(extra.get('BR1|u3')).toBe(1);
    expect(missing.get('BR1|u3')).toBeUndefined();
  });

  // The folded count is a roll-up of the marks the hidden rows carry themselves,
  // so it has to clear on the same condition: another business role covering the
  // cell already accounts for the membership.
  it('leaves access another business role accounts for uncounted', () => {
    const { extra } = build({
      managedApMap: new Map([...managedApMap, ['g1|u3', ['br2']]]),
    });
    expect(extra.get('BR1|u3')).toBeUndefined();
  });

  it('tallies onto the aggregate column when subjects are folded together', () => {
    const { extra, missing } = build({ userToAgg: new Map([['u2', 'agg-1'], ['u3', 'agg-1']]) });
    expect(extra.get('BR1|agg-1')).toBe(2);
    expect(missing.get('BR1|agg-1')).toBe(1);
  });

  it('reads a synthetic row through its real resource id', () => {
    const { missing } = buildRoleDeviationCounts({
      foldedChildRows: new Map([['BR1', [{ id: 'G1__owner', realGroupId: 'G1' }]]]),
      users: [{ id: 'u2' }], memberships: new Map(), managedApMap, apGroupMap: AP_GROUP_MAP,
    });
    expect(missing.get('BR1|u2')).toBe(1);
  });
});
