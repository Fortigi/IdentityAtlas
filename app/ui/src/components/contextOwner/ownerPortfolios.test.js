import { describe, it, expect } from 'vitest';
import { portfolioRoleGroups, firstGroupRole, DEFAULT_PORTFOLIO } from './ownerPortfolios';

const role = (id, portfolioId = null, portfolioName = null) => ({ id, displayName: id, role: 'Responsible', portfolioId, portfolioName });
const names = groups => groups.map(g => [g.name, g.isDefault, g.roles.map(r => r.id)]);

describe('portfolioRoleGroups', () => {
  it('files roles under their portfolio by name, keeping the given role order, and the default last', () => {
    const roles = [role('r1'), role('r2', 'P-Z', 'Zeta'), role('r3', 'P-A', 'Alpha'), role('r4', 'P-Z', 'Zeta'), role('r5')];
    expect(names(portfolioRoleGroups(roles, new Set()))).toEqual([
      ['Alpha', false, ['r3']],
      ['Zeta', false, ['r2', 'r4']],
      [DEFAULT_PORTFOLIO, true, ['r1', 'r5']],
    ]);
  });

  it('leaves out a role whose portfolio is in scope, matching ids case-insensitively', () => {
    const roles = [role('r1', 'AAAA-held', 'Held'), role('r2', 'other', 'Other')];
    expect(names(portfolioRoleGroups(roles, new Set(['aaaa-held'])))).toEqual([['Other', false, ['r2']]]);
  });

  it('keeps two portfolios with the same name apart, and names one without a name as the default', () => {
    const roles = [role('r1', 'p1', 'Same'), role('r2', 'p2', 'Same'), role('r3', 'p3', null)];
    const groups = portfolioRoleGroups(roles, new Set());
    expect(groups.map(g => g.key).sort()).toEqual(['p1', 'p2', 'p3']);
    expect(groups.find(g => g.key === 'p3')).toMatchObject({ name: DEFAULT_PORTFOLIO, isDefault: false });
  });

  it('is empty for no roles or no scope given', () => {
    expect(portfolioRoleGroups(undefined, new Set())).toEqual([]);
    expect(names(portfolioRoleGroups([role('r1', 'p1', 'P')], undefined))).toEqual([['P', false, ['r1']]]);
  });
});

describe('firstGroupRole', () => {
  it('is the first role of the first group, or null', () => {
    const groups = portfolioRoleGroups([role('r9'), role('r2', 'p', 'P')], new Set());
    expect(firstGroupRole(groups).id).toBe('r2');
    expect(firstGroupRole([])).toBeNull();
  });
});
