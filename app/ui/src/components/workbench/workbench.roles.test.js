import { describe, it, expect } from 'vitest';
import { bandRoles, cellProps, roleCellProps, cellLabel, draftName, draftShown, DRAFT_ID } from './workbench.roles';
import { indexCells, cellsByResource, EMPTY_CANDIDATE } from './workbench.model';

const color = (idx) => `#c${idx}`;
const cells = [
  { person: 'a', resourceId: 'br', type: 'Direct' },
  { person: 'a', resourceId: 'r1', type: 'Direct', viaRoles: ['br'] },
  { person: 'b', resourceId: 'r1', type: 'Indirect' },
  { person: 'b', resourceId: 'r2', type: 'Direct' },
];
const columns = [
  { id: 'r1', displayName: 'Read', isRole: false },
  { id: 'br', displayName: 'Handler', isRole: true, contains: ['r1', 'r3'] },
  { id: 'r2', displayName: 'Motor', isRole: false },
];
const candidate = (members, entitlements, name = 'Motor v2') => ({ ...EMPTY_CANDIDATE, name, members: new Set(members), entitlements: new Set(entitlements) });

describe('bandRoles', () => {
  it('lists the existing roles with their holders and composition, then the draft once it has members or entitlements', () => {
    expect(bandRoles(columns, cellsByResource(cells), EMPTY_CANDIDATE).map(r => [r.id, r.idx])).toEqual([['br', 0]]);
    const roles = bandRoles(columns, cellsByResource(cells), candidate(['b'], ['r2']));
    expect(roles.map(r => [r.id, r.displayName, r.idx, r.draft])).toEqual([['br', 'Handler', 0, false], [DRAFT_ID, 'Draft: Motor v2', 1, true]]);
    expect([...roles[0].holders]).toEqual(['a']);
    expect([...roles[0].contains]).toEqual(['r1', 'r3']);
  });

  it('names the draft, and shows it only with content', () => {
    expect(draftName(candidate([], [], '  '))).toBe('Draft');
    expect(draftShown(candidate([], []))).toBe(false);
    expect(draftShown(candidate([], ['r1']))).toBe(true);
  });
});

describe('cellProps — the candidate in the matrix’s words', () => {
  const roles = bandRoles(columns, cellsByResource(cells), candidate(['b'], ['r1', 'r3']));
  const idx = indexCells(cells);
  const props = (person, r) => cellProps({ cell: idx.get(`${person}|${r}`), personKey: person, resourceId: r, roles, color });

  it('colours a held cell a role covers — the API’s viaRoles for an existing role, membership for the draft', () => {
    expect(props('a', 'r1')).toMatchObject({ managed: true, apColor: '#c0', apNames: ['Handler'], apCount: 1 });
    expect(props('b', 'r1')).toMatchObject({ managed: true, apColor: '#c1', apNames: ['Draft: Motor v2'] });
    expect([...props('b', 'r1').membershipTypes]).toEqual(['Indirect']);
  });

  it('marks a potential gain as the role’s provisioning gap, for the draft and for an existing role', () => {
    expect(props('b', 'r3')).toEqual({ provisioningGap: true, gapExpected: 'Direct', apColor: '#c1', apNames: ['Draft: Motor v2'], apCount: 1 });
    expect(props('a', 'r3')).toMatchObject({ provisioningGap: true, apNames: ['Handler'] });
  });

  it('marks a held cell a role in view hands out but does not assign to this person as held outside', () => {
    const asNonMember = cellProps({ cell: { type: 'Direct' }, personKey: 'c', resourceId: 'r1', roles, color });
    expect(asNonMember).toMatchObject({ heldOutsideCount: 2, heldOutsideNames: 'Handler, Draft: Motor v2', heldOutsideHoldsRole: false });
    expect(asNonMember.managed).toBeUndefined();
  });

  it('leaves a member’s access outside the candidate plain — not a removal — and an empty cell empty', () => {
    expect(props('b', 'r2')).toEqual({ membershipTypes: new Set(['Direct']) });
    expect(props('a', 'r2')).toEqual({});
  });
});

describe('roleCellProps', () => {
  const roles = bandRoles(columns, cellsByResource(cells), candidate(['b'], ['r1']));
  const idx = indexCells(cells);

  it('paints a holder’s own role cell in the role’s colour, and a draft member as the draft’s gap', () => {
    expect(roleCellProps({ role: roles[0], personKey: 'a', cellIndex: idx, color })).toMatchObject({ managed: true, apColor: '#c0', apNames: ['Handler'] });
    expect(roleCellProps({ role: roles[0], personKey: 'b', cellIndex: idx, color })).toEqual({});
    expect(roleCellProps({ role: roles[1], personKey: 'b', cellIndex: idx, color })).toMatchObject({ provisioningGap: true, apColor: '#c1' });
    expect(roleCellProps({ role: roles[1], personKey: 'a', cellIndex: idx, color })).toEqual({});
  });
});

describe('cellLabel', () => {
  it('reads the matrix’s own tooltip, after the analyst’s mark', () => {
    expect(cellLabel({ membershipTypes: new Set(['Direct']), managed: true, apNames: ['Draft: X'] }, null)).toBe('Direct\nManaged by: Draft: X');
    expect(cellLabel({}, null)).toBe('Not held');
    expect(cellLabel({ membershipTypes: new Set(['Direct']) }, 'other')).toBe('Other context — Direct');
  });
});
