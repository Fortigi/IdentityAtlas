import { describe, it, expect, vi } from 'vitest';
import { teamMatrixFilter, matrixHrefForUnit } from '@ui/utils/matrixFilter';
import { readOnlyMatrixProps } from '@ui/components/shared/readOnlyMatrixProps';
import { ownerMatrixFor } from '@ui/components/contexts/header/headerActions';
import { fetchCategoryItems } from '@ui/components/entityGraphShape';
import { OWNER_OPENABLE } from './ownerOpenable';

const UNIT = 'aaaaaaaa-0000-4000-8000-000000000001';

describe('teamMatrixFilter', () => {
  it('a unit of people: the ordinary matrix (people as columns, so the business-role band and governed cells draw), with its sub-units', () => {
    expect(teamMatrixFilter({ id: UNIT, targetType: 'Identity' })).toEqual({
      rowType: 'identity',
      subject: { include: [{ kind: 'context', contextId: UNIT, includeChildren: true }], exclude: [] },
      resource: { include: [], exclude: [] },
    });
  });

  it('a unit of accounts: accounts', () => {
    expect(teamMatrixFilter({ id: UNIT, targetType: 'Principal' }).rowType).toBe('principal');
  });

  it('an application: its resources (with its sub-contexts) as the column bound, every holder a row', () => {
    expect(teamMatrixFilter({ id: UNIT, targetType: 'Resource' })).toEqual({
      rowType: 'principal',
      orientation: 'rows-as-subjects',
      subject: { include: [], exclude: [] },
      resource: { include: [{ kind: 'context', contextId: UNIT, includeChildren: true }], exclude: [] },
    });
  });

  it.each([['Identity'], ['Principal'], ['Resource']])('is exactly what an analyst opens from a %s context (View in matrix)', (targetType) => {
    const ctx = { id: UNIT, targetType };
    const analyst = JSON.parse(new URLSearchParams(matrixHrefForUnit(ctx).split('?')[1]).get('filter'));
    expect(teamMatrixFilter(ctx)).toEqual(analyst);
  });
});

describe('ownerMatrixFor', () => {
  const scope = new Set([UNIT]);
  it.each([
    [{ id: UNIT, targetType: 'Identity' }, scope, 'Team matrix'],
    [{ id: UNIT.toUpperCase(), targetType: 'Principal' }, scope, 'Team matrix'],
    [{ id: UNIT, targetType: 'Resource' }, scope, 'Application matrix'],
    [{ id: UNIT, targetType: 'System' }, scope, null],
    [{ id: 'aaaaaaaa-0000-4000-8000-000000000002', targetType: 'Identity' }, scope, null],
    [{ id: UNIT, targetType: 'Identity' }, null, null],
    [null, scope, null],
  ])('%o in %o → %s', (attrs, ownerScope, label) => {
    expect(ownerMatrixFor(attrs, { ownerScope })?.label ?? null).toBe(label);
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
