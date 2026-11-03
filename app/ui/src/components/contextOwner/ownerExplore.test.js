import { describe, it, expect, vi } from 'vitest';
import { teamMatrixFilter } from '@ui/utils/matrixFilter';
import { readOnlyMatrixProps } from '@ui/components/shared/readOnlyMatrixProps';
import { offersTeamMatrix } from '@ui/components/contexts/header/headerActions';
import { fetchCategoryItems } from '@ui/components/entityGraphShape';
import { OWNER_OPENABLE } from './ownerOpenable';

const UNIT = 'aaaaaaaa-0000-4000-8000-000000000001';

describe('teamMatrixFilter', () => {
  it('a unit of people: identities as rows, the unit itself without its sub-units', () => {
    expect(teamMatrixFilter({ id: UNIT, targetType: 'Identity' })).toEqual({
      rowType: 'identity',
      orientation: 'rows-as-subjects',
      subject: { include: [{ kind: 'context', contextId: UNIT, includeChildren: false }], exclude: [] },
      resource: { include: [], exclude: [] },
    });
  });

  it('a unit of accounts: accounts as rows', () => {
    expect(teamMatrixFilter({ id: UNIT, targetType: 'Principal' }).rowType).toBe('principal');
  });
});

describe('offersTeamMatrix', () => {
  const scope = new Set([UNIT]);
  it.each([
    [{ id: UNIT, targetType: 'Identity' }, scope, true],
    [{ id: UNIT.toUpperCase(), targetType: 'Principal' }, scope, true],
    [{ id: UNIT, targetType: 'Resource' }, scope, false],
    [{ id: 'aaaaaaaa-0000-4000-8000-000000000002', targetType: 'Identity' }, scope, false],
    [{ id: UNIT, targetType: 'Identity' }, null, false],
  ])('%o in %o → %s', (attrs, ownerScope, out) => {
    expect(offersTeamMatrix(attrs, { ownerScope })).toBe(out);
  });
});

describe('readOnlyMatrixProps', () => {
  it('hands the loaded matrix through and switches every editing hook off', () => {
    const noop = () => {};
    const matrix = { rollup: null, data: [1], counts: { a: 1 }, refreshing: false, accessPackageGroups: [], managedByPackages: [2], resourceContexts: [3], groupTagMap: new Map(), hasData: true };
    const p = readOnlyMatrixProps({ matrix, filter: { f: 1 }, managedFilter: 'all', setManagedFilter: noop, onOpenDetail: noop, noop });
    expect(p).toMatchObject({ data: [1], matrixFilter: { f: 1 }, managedByPackages: [2], resourceContexts: [3], wizardOpen: false, hasData: true });
    expect(p.setMatrixFilter).toBe(noop);
    expect(p.onWizardApply).toBe(noop);
  });
});

describe('OWNER_OPENABLE', () => {
  it('is the team matrix and the detail pages — never a run, a report or a builder', () => {
    expect([...OWNER_OPENABLE].sort()).toEqual(['access-package', 'group', 'identity', 'resource', 'team-matrix', 'user']);
  });
});

describe('the graph carries the API\'s flag', () => {
  it('a resource member the owner may not open becomes a non-openable item', async () => {
    const rows = [
      { principalId: 'p1', principalDisplayName: 'Tim', assignmentType: 'Direct', accessible: true },
      { principalId: 'p2', principalDisplayName: 'Olga', assignmentType: 'Direct', accessible: false },
    ];
    const authFetch = vi.fn(async () => ({ ok: true, json: async () => rows }));
    const items = await fetchCategoryItems('resource', 'r1', 'members-direct', authFetch);
    expect(items.map(i => [i.label, i.accessible])).toEqual([['Tim', undefined], ['Olga', false]]);
  });
});
