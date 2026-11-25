// The business roles a context owner answers for themselves, filed under the role
// portfolio each sits in (/api/auth-me contextOwner.businessRoles: portfolioId,
// portfolioName). On the owner's page they sit on the Role portfolios tab, beside
// the portfolios the owner holds, so everything they answer for is organised by
// context. A role in a portfolio the owner holds is left out: it is a member of
// that portfolio and opens from there. A role in a portfolio they do not hold is
// filed under its name (shown light, not a link: the portfolio is outside their
// scope); a role in no portfolio under "Default portfolio".

export const PORTFOLIO_TAB = 'Catalog';
export const DEFAULT_PORTFOLIO = 'Default portfolio';

const lower = id => String(id ?? '').toLowerCase();
const byName = (a, b) => String(a.name).localeCompare(String(b.name));

/**
 * [{ key, name, isDefault, roles }] — portfolios by name, the default one last;
 * the roles keep the order given (by name, from the API). `scope` is the set of
 * lower-cased context ids the owner may open. Pure.
 */
export function portfolioRoleGroups(roles, scope) {
  const groups = new Map();
  for (const role of roles || []) {
    const portfolio = role.portfolioId ? lower(role.portfolioId) : null;
    if (portfolio && scope?.has(portfolio)) continue;
    const key = portfolio ?? '';
    if (!groups.has(key)) {
      groups.set(key, { key, name: portfolio ? (role.portfolioName || DEFAULT_PORTFOLIO) : DEFAULT_PORTFOLIO, isDefault: !portfolio, roles: [] });
    }
    groups.get(key).roles.push(role);
  }
  const all = [...groups.values()];
  return [...all.filter(g => !g.isDefault).sort(byName), ...all.filter(g => g.isDefault)];
}

/** The first role of the groups, or null. Pure. */
export const firstGroupRole = groups => groups[0]?.roles[0] ?? null;
