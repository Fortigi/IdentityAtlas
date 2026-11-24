import { describe, it, expect } from 'vitest';
import { resolvePopulation, withPopulationFields, passesRule, isSecondAccount, applyPopulation } from './manager-hierarchy.population.js';
import { placeManagersInOwnTeam } from './manager-hierarchy.layout.js';

const COLS = new Set(['id', 'displayName', 'managerId', 'employeeId', 'department', 'email']);
const EXT = new Set(['userType']);
const resolve = (params) => resolvePopulation(params, COLS, EXT);
const P = (id, managerId, employeeId, extra = {}) => ({ id, displayName: id, managerId, employeeId, ...extra });
const ids = (rows) => rows.map(r => r.id);
const managerOf = (rows, id) => rows.find(r => r.id === id).managerId;

describe('resolvePopulation', () => {
  it('is inactive without rules or second-account check', () => {
    expect(resolve({}).active).toBe(false);
    expect(resolve({ peopleFilters: 'nope', excludeSecondAccounts: 'true' }).active).toBe(false);
  });

  it('ignores the second-account check when there is no employeeId column', () => {
    expect(resolvePopulation({ excludeSecondAccounts: true }, new Set(['id']), EXT).active).toBe(false);
  });

  it('accepts a real column and an extended key, and says which is which', () => {
    const { rules } = resolve({ peopleFilters: [
      { attribute: 'employeeId', condition: 'isNotNull' },
      { attribute: 'userType', condition: 'equals', value: 'Member' },
    ] });
    expect(rules.map(r => [r.name, r.real])).toEqual([['employeeId', true], ['userType', false]]);
  });

  it.each([
    [{ attribute: 'nope', condition: 'isNotNull' }, /peopleFilters\[0\]: unknown attribute "nope"/],
    [{ attribute: 'department', condition: 'like' }, /unknown condition "like"/],
    [{ attribute: 'department', condition: 'equals', value: '  ' }, /a value is required/],
    [{ attribute: 'department', condition: 'inValues', values: [' '] }, /values are required/],
    [{ attribute: 'department', condition: 'inValues' }, /values are required/],
    [{ attribute: 'email', condition: 'notMatches', value: '[bad' }, /not a valid pattern/],
    [null, /unknown attribute/],
  ])('rejects %j', (rule, message) => {
    expect(() => resolve({ peopleFilters: [rule] })).toThrow(message);
  });
});

describe('withPopulationFields', () => {
  it('adds what the filter reads, once, and never the always-selected columns', () => {
    const population = resolve({ excludeSecondAccounts: true, peopleFilters: [
      { attribute: 'displayName', condition: 'notMatches', value: '^adm' },
      { attribute: 'department', condition: 'isNotNull' },
      { attribute: 'userType', condition: 'isNotNull' },
      { attribute: 'userType', condition: 'equals', value: 'Member' },
    ] });
    const out = withPopulationFields([{ name: 'department', real: true }], population);
    expect(out).toEqual([
      { name: 'department', real: true },
      { name: 'userType', real: false },
      { name: 'employeeId', real: true },
    ]);
  });
});

describe('passesRule', () => {
  const rule = (r) => resolve({ peopleFilters: [{ attribute: 'department', ...r }] }).rules[0];

  it('isNotNull treats blank as empty', () => {
    const r = rule({ condition: 'isNotNull' });
    expect([passesRule({ department: 'IT' }, r), passesRule({ department: '  ' }, r), passesRule({}, r)]).toEqual([true, false, false]);
  });

  it('equals and notEquals ignore case and outer spaces', () => {
    expect(passesRule({ department: ' it ' }, rule({ condition: 'equals', value: 'IT' }))).toBe(true);
    expect(passesRule({ department: 'HR' }, rule({ condition: 'equals', value: 'IT' }))).toBe(false);
    expect(passesRule({ department: 'it' }, rule({ condition: 'notEquals', value: 'IT' }))).toBe(false);
    expect(passesRule({ department: 'HR' }, rule({ condition: 'notEquals', value: 'IT' }))).toBe(true);
  });

  it('inValues matches any listed value', () => {
    const r = rule({ condition: 'inValues', values: ['IT', 'hr'] });
    expect([passesRule({ department: 'HR' }, r), passesRule({ department: 'Sales' }, r)]).toEqual([true, false]);
  });

  it('notMatches keeps what the pattern does not hit, case-insensitively', () => {
    const r = rule({ condition: 'notMatches', value: '^adm-' });
    expect([passesRule({ department: 'ADM-jan' }, r), passesRule({ department: 'jan-adm-' }, r)]).toEqual([false, true]);
  });
});

describe('isSecondAccount', () => {
  const byId = new Map([['jan', P('jan', null, 'E1')], ['noid', P('noid', null, null)]]);
  it('is true only when the manager has the same non-empty employee id', () => {
    expect(isSecondAccount(P('adm', 'jan', ' e1 '), byId)).toBe(true);
    expect(isSecondAccount(P('x', 'jan', 'E2'), byId)).toBe(false);
    expect(isSecondAccount(P('x', 'noid', null), byId)).toBe(false);
    expect(isSecondAccount(P('x', null, 'E1'), byId)).toBe(false);
    expect(isSecondAccount(P('x', 'ghost', 'E1'), byId)).toBe(false);
  });
});

describe('applyPopulation', () => {
  const hrOnly = { peopleFilters: [{ attribute: 'employeeId', condition: 'isNotNull' }], excludeSecondAccounts: true };

  it('returns the same rows and no stats when no filter is set', () => {
    const rows = [P('a', null, null)];
    const out = applyPopulation(rows, resolve({}));
    expect(out.rows).toBe(rows);
    expect(out.stats).toBeNull();
  });

  it('removes an admin account with no id AND one with a copied id, so its owner is no manager', () => {
    const rows = [
      P('boss', null, 'E1'), P('jan', 'boss', 'E2'),
      P('adm-nocopy', 'jan', null), P('adm-copy', 'jan', 'E2'),
    ];
    const out = applyPopulation(rows, resolve(hrOnly));
    expect(ids(out.rows)).toEqual(['boss', 'jan']);
    expect(out.rows.some(r => r.managerId === 'jan')).toBe(false);
    expect(out.stats).toEqual({ accountsTotal: 4, peopleIncluded: 2, filteredOut: 1, secondAccounts: 1 });
  });

  it('moves someone whose manager is out up to the nearest manager who is in', () => {
    const rows = [P('top', null, 'E1'), P('gap1', 'top', null), P('gap2', 'gap1', null), P('ic', 'gap2', 'E4')];
    expect(managerOf(applyPopulation(rows, resolve(hrOnly)).rows, 'ic')).toBe('top');
  });

  it('leaves someone without a manager when nobody up the chain is in', () => {
    const rows = [P('gap', null, null), P('ic', 'gap', 'E2')];
    expect(managerOf(applyPopulation(rows, resolve(hrOnly)).rows, 'ic')).toBeNull();
  });

  it('survives a reporting loop among filtered-out accounts', () => {
    const rows = [P('x', 'y', null), P('y', 'x', null), P('ic', 'x', 'E3')];
    expect(managerOf(applyPopulation(rows, resolve(hrOnly)).rows, 'ic')).toBeNull();
  });

  it('keeps a manager id that is not in the data at all', () => {
    const rows = [P('ic', 'ghost', 'E1')];
    expect(managerOf(applyPopulation(rows, resolve(hrOnly)).rows, 'ic')).toBe('ghost');
  });
});

describe('placeManagersInOwnTeam', () => {
  it('moves a manager into their own unit, adds a top manager, skips a ghost and leaves others', () => {
    const byId = new Map([['top', {}], ['mgr', {}], ['ic', {}]]);
    const result = { contexts: [], members: [
      { contextExternalId: 'top', memberId: 'mgr' },
      { contextExternalId: 'mgr', memberId: 'ic' },
    ] };
    placeManagersInOwnTeam(result, byId, new Set(['top', 'mgr', 'ghost']));
    expect(result.members).toEqual([
      { contextExternalId: 'mgr', memberId: 'mgr' },
      { contextExternalId: 'mgr', memberId: 'ic' },
      { contextExternalId: 'top', memberId: 'top' },
    ]);
  });
});
