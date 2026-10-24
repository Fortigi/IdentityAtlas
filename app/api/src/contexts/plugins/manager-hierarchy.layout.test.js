import { describe, it, expect } from 'vitest';
import RE2 from 're2';
import { majorityValue, splitUnits, nameUnitsFromMembers, findTops, placeUnderTops, NOT_PLACED_EXTERNAL_ID, splitExternalId } from './manager-hierarchy.layout.js';
import { buildManagerIds, buildManagerContexts, buildMemberRows, buildManagerRoles, buildNodeName } from './manager-hierarchy.helpers.js';
import { resolveLayout, withLayoutFields, excludeInactive, applyLayout } from './manager-hierarchy.options.js';

// A small organisation:
//   anna (CEO, Board)  ← carl (CFO, Board), bram (CIO, Board), saar (Board)
//   carl ← tom (Finance), ines (Finance)
//   bram ← eva (IT), joost (IT), gijs (Facilities), koen (Facilities), rosa (Facilities)
//   eva  ← bas (Workplace)
//   koen ← lars (Facilities)        (koen manages someone: his unit follows him)
//   loose: svc (no manager, no reports), chair (no manager) ← anna? no: anna reports to nobody
const P = (id, managerId, department, jobTitle = '', accountEnabled = true) => ({ id, displayName: id[0].toUpperCase() + id.slice(1), managerId, department, jobTitle, accountEnabled });
const ROWS = [
  P('anna', null, 'Board', 'CEO'), P('carl', 'anna', 'Board', 'CFO'), P('bram', 'anna', 'Board', 'CIO'), P('saar', 'anna', 'Board'),
  P('tom', 'carl', 'Finance'), P('ines', 'carl', 'Finance'),
  P('eva', 'bram', 'IT'), P('joost', 'bram', 'IT'), P('gijs', 'bram', 'Facilities'), P('koen', 'bram', 'Facilities'), P('rosa', 'bram', 'Facilities'), P('dirk', 'bram', 'IT'),
  P('bas', 'eva', 'Workplace'), P('lars', 'koen', 'Facilities'),
  P('svc', null, null, 'Service account'),
];
const NAMING = { resolved: [{ name: 'department', real: true }], separator: ' · ', includeManagerName: true };

function base(rows = ROWS) {
  const byId = new Map(rows.map(r => [r.id, r]));
  const { managerIds } = buildManagerIds(rows, byId, [], new Map());
  const contexts = [{ externalId: 'root', displayName: 'Organization', contextType: 'ManagerHierarchy' }, ...buildManagerContexts(managerIds, byId, 'root', NAMING)];
  const members = buildMemberRows(rows, managerIds, new Map(), 'root');
  return { result: { contexts, members }, byId, managerIds, rows };
}
const unitOf = (result, memberId) => result.members.find(m => m.memberId === memberId)?.contextExternalId;
const ctx = (result, ext) => result.contexts.find(c => c.externalId === ext);

describe('majorityValue', () => {
  it('takes the most common non-empty value, the first seen on a tie', () => {
    expect(majorityValue([{ d: 'A' }, { d: 'B' }, { d: 'B' }, { d: ' ' }], 'd')).toBe('B');
    expect(majorityValue([{ d: 'A' }, { d: 'B' }], 'd')).toBe('A');
    expect(majorityValue([{ d: null }, {}], 'd')).toBe('');
  });
});

describe('splitUnits', () => {
  it('gives a minority department of at least minMembers its own unit under the manager; the largest group keeps the manager\'s key', () => {
    const { result, byId, managerIds } = base();
    splitUnits(result, byId, { field: 'department', minMembers: 2, managerIds, naming: (v, m) => `${v} (${m.displayName})` });
    const fac = splitExternalId('bram', 'Facilities');
    expect(ctx(result, fac)).toMatchObject({ displayName: 'Facilities (Bram)', parentExternalId: 'bram' });
    expect(['gijs', 'koen', 'rosa'].map(m => unitOf(result, m))).toEqual([fac, fac, fac]);
    expect(['eva', 'joost', 'dirk'].map(m => unitOf(result, m))).toEqual(['bram', 'bram', 'bram']);
    // koen moved into the split unit, so his own unit hangs under it now
    expect(ctx(result, 'koen').parentExternalId).toBe(fac);
    // the board is one department: nothing split there
    expect(result.contexts.filter(c => String(c.externalId).startsWith('anna::'))).toEqual([]);
  });

  it('leaves a group smaller than minMembers with the manager', () => {
    const { result, byId, managerIds } = base();
    splitUnits(result, byId, { field: 'department', minMembers: 4, managerIds, naming: v => v });
    expect(result.contexts.some(c => String(c.externalId).includes('::'))).toBe(false);
    expect(unitOf(result, 'gijs')).toBe('bram');
  });

  it('does nothing without a field', () => {
    const { result, byId, managerIds } = base();
    const before = JSON.stringify(result);
    splitUnits(result, byId, { field: null, managerIds, naming: v => v });
    expect(JSON.stringify(result)).toBe(before);
  });

  it('makes the manager Accountable for a unit split off their people', () => {
    const { result, byId, managerIds } = base();
    splitUnits(result, byId, { field: 'department', minMembers: 2, managerIds, naming: v => v });
    const roles = buildManagerRoles(managerIds, byId, result.contexts);
    expect(roles).toContainEqual({ contextExternalId: splitExternalId('bram', 'Facilities'), principalId: 'bram', role: 'Accountable' });
    expect(roles.filter(r => r.principalId === 'bram')).toHaveLength(2);
  });
});

describe('nameUnitsFromMembers', () => {
  it('names a unit after what its people share, not after its manager', () => {
    const { result, byId } = base();
    expect(ctx(result, 'carl').displayName).toBe('Board (Carl)'); // the manager's own department
    nameUnitsFromMembers(result, byId, { fields: ['department'], rootExt: 'root', buildName: row => buildNodeName(row, NAMING) });
    expect(ctx(result, 'carl').displayName).toBe('Finance (Carl)');
    expect(ctx(result, 'eva').displayName).toBe('Workplace (Eva)');
    expect(ctx(result, 'root').displayName).toBe('Organization');
  });
});

describe('findTops and placeUnderTops', () => {
  it('finds the top by job title pattern or by id', () => {
    expect(findTops(ROWS, { topJobTitleRegex: new RE2('^ceo$', 'i') })).toEqual(new Set(['anna']));
    expect(findTops(ROWS, { topPrincipalIds: ['CARL', 'nobody'] })).toEqual(new Set(['carl']));
    expect(findTops(ROWS, {})).toBeNull();
  });

  it('puts what is not under the chosen top in Not placed, as whole teams, and keeps the top person at the top', () => {
    const { result } = base();
    placeUnderTops(result, { tops: new Set(['carl']), rootExt: 'root', notPlacedUnit: true });
    expect(ctx(result, 'carl').parentExternalId).toBe('root');
    expect(ctx(result, 'anna').parentExternalId).toBe(NOT_PLACED_EXTERNAL_ID);
    expect(ctx(result, 'bram').parentExternalId).toBe('anna'); // stays inside anna's team
    expect(ctx(result, NOT_PLACED_EXTERNAL_ID)).toMatchObject({ displayName: 'Not placed', parentExternalId: 'root' });
    expect(unitOf(result, 'carl')).toBe('root');
    expect(unitOf(result, 'svc')).toBe(NOT_PLACED_EXTERNAL_ID);
  });

  it('with only notPlacedUnit keeps the units and moves just the loose people', () => {
    const { result } = base();
    placeUnderTops(result, { tops: null, rootExt: 'root', notPlacedUnit: true });
    expect(ctx(result, 'anna').parentExternalId).toBe('root');
    expect(unitOf(result, 'svc')).toBe(NOT_PLACED_EXTERNAL_ID);
  });

  it('changes nothing when neither is asked', () => {
    const { result } = base();
    const before = JSON.stringify(result);
    placeUnderTops(result, { tops: null, rootExt: 'root', notPlacedUnit: false });
    expect(JSON.stringify(result)).toBe(before);
  });
});

describe('layout options', () => {
  const cols = new Set(['department', 'jobTitle', 'accountEnabled']);

  it('validates the top choice', () => {
    expect(() => resolveLayout({ topMode: 'jobTitle' }, cols, new Set())).toThrow(/topJobTitle is required/);
    expect(() => resolveLayout({ topMode: 'people', topPrincipalIds: [] }, cols, new Set())).toThrow(/topPrincipalIds is required/);
    expect(() => resolveLayout({ topMode: 'jobTitle', topJobTitle: '(' }, cols, new Set())).toThrow(/not a valid pattern/);
    const l = resolveLayout({ topMode: 'jobTitle', topJobTitle: 'ceo', splitBy: 'department', splitMinMembers: '0', nameFrom: 'members' }, cols, new Set());
    expect(l).toMatchObject({ topMode: 'jobTitle', notPlacedUnit: true, nameFromMembers: true, split: { name: 'department', real: true }, splitMinMembers: 2 });
    expect(resolveLayout({ topMode: 'weird', splitBy: 'nope' }, cols, new Set()).topMode).toBe('auto');
    expect(resolveLayout({ splitBy: 'sfTeam' }, cols, new Set(['sfTeam'])).split).toEqual({ name: 'sfTeam', real: false });
  });

  it('reads the extra columns once', () => {
    const l = resolveLayout({ topMode: 'jobTitle', topJobTitle: 'x', splitBy: 'department', excludeInactive: true }, cols, new Set());
    expect(withLayoutFields([{ name: 'department', real: true }], l, cols).map(f => f.name)).toEqual(['department', 'jobTitle', 'accountEnabled']);
  });

  it('drops leavers, and whoever reported to one has no manager any more', () => {
    const rows = [P('a', null, 'X'), P('b', 'a', 'X', '', false), P('c', 'b', 'X')];
    expect(excludeInactive(rows, { excludeInactive: true })).toEqual([rows[0], { ...rows[2], managerId: null }]);
    expect(excludeInactive(rows, { excludeInactive: false })).toBe(rows);
  });

  it('applies split, naming and top together', () => {
    const { result, byId, managerIds, rows } = base();
    const layout = resolveLayout({ topMode: 'jobTitle', topJobTitle: '^CEO$', splitBy: 'department', nameFrom: 'members' }, cols, new Set());
    applyLayout(result, { rows, byId, managerIds, rootExt: 'root', naming: NAMING, layout });
    expect(ctx(result, 'anna')).toMatchObject({ parentExternalId: 'root', displayName: 'Board (Anna)' });
    expect(ctx(result, splitExternalId('bram', 'Facilities')).displayName).toBe('Facilities (Bram)');
    expect(ctx(result, 'bram').displayName).toBe('IT (Bram)');
    expect(unitOf(result, 'svc')).toBe(NOT_PLACED_EXTERNAL_ID);
  });
});
