// Who is in the organisation tree at all: the manager-hierarchy plugin's optional
// people filter. Applied before the tree is built, so an account that is out
// (an admin account, a shared mailbox) can never make its "manager" a team.
//
//   peopleFilters          rules on an attribute; an account must pass all of them
//   excludeSecondAccounts  drop an account whose manager has the same employee id:
//                          that is the person's own admin account, which often
//                          carries a copy of the id and so passes "has an employee id"
//
// Someone whose manager is filtered out moves up to the nearest manager who is in,
// so a team stays in the tree. Pure — run() reads the rows.

import RE2 from 're2';

const CONDITIONS = new Set(['isNotNull', 'equals', 'notEquals', 'inValues', 'notMatches']);
const ALWAYS_SELECTED = new Set(['id', 'displayName', 'managerId']);

const text = (v) => (v == null ? '' : String(v).trim());
const fold = (v) => text(v).toLowerCase();

function resolveRule(rule, i, validCols, validExtKeys) {
  const attribute = text(rule?.attribute);
  const real = validCols.has(attribute);
  if (!real && !validExtKeys.has(attribute)) throw new Error(`peopleFilters[${i}]: unknown attribute "${attribute}"`);
  const condition = rule.condition;
  if (!CONDITIONS.has(condition)) throw new Error(`peopleFilters[${i}]: unknown condition "${condition}"`);
  const base = { name: attribute, real, condition };
  if (condition === 'isNotNull') return base;
  if (condition === 'inValues') {
    const values = (Array.isArray(rule.values) ? rule.values : []).map(fold).filter(Boolean);
    if (!values.length) throw new Error(`peopleFilters[${i}]: values are required`);
    return { ...base, values: new Set(values) };
  }
  if (!text(rule.value)) throw new Error(`peopleFilters[${i}]: a value is required`);
  if (condition !== 'notMatches') return { ...base, value: fold(rule.value) };
  try { return { ...base, regex: new RE2(text(rule.value), 'i') }; }
  catch (e) { throw new Error(`peopleFilters[${i}] is not a valid pattern: ${e.message}`, { cause: e }); }
}

// The validated filter. Throws on a rule that cannot work, rather than quietly
// building a tree of everyone or of nobody.
export function resolvePopulation(params, validCols, validExtKeys) {
  const rules = (Array.isArray(params.peopleFilters) ? params.peopleFilters : [])
    .map((r, i) => resolveRule(r, i, validCols, validExtKeys));
  const excludeSecondAccounts = params.excludeSecondAccounts === true && validCols.has('employeeId');
  return { rules, excludeSecondAccounts, active: rules.length > 0 || excludeSecondAccounts };
}

// The fields to read plus the ones the filter needs, each once.
export function withPopulationFields(resolved, population) {
  const seen = new Set([...ALWAYS_SELECTED, ...resolved.map(r => r.name)]);
  const needed = population.rules.map(r => ({ name: r.name, real: r.real }));
  if (population.excludeSecondAccounts) needed.push({ name: 'employeeId', real: true });
  return [...resolved, ...needed.filter(f => !seen.has(f.name) && seen.add(f.name))];
}

export function passesRule(row, rule) {
  const value = fold(row[rule.name]);
  if (rule.condition === 'isNotNull') return value !== '';
  if (rule.condition === 'equals') return value === rule.value;
  if (rule.condition === 'notEquals') return value !== rule.value;
  if (rule.condition === 'inValues') return rule.values.has(value);
  return !rule.regex.test(text(row[rule.name]));
}

export function isSecondAccount(row, byId) {
  const own = fold(row.employeeId);
  return !!own && !!row.managerId && fold(byId.get(row.managerId)?.employeeId) === own;
}

// The nearest manager up the chain who is in. A manager id that is not in the
// data at all is returned as is: the tree keeps those as an "Unknown" unit.
function nearestKeptManager(row, byId, keptIds) {
  const visited = new Set([row.id]);
  let current = row.managerId;
  while (current && byId.has(current) && !keptIds.has(current)) {
    if (visited.has(current)) return null;
    visited.add(current);
    current = byId.get(current).managerId;
  }
  return current && !visited.has(current) ? current : null;
}

export function applyPopulation(rows, population) {
  if (!population.active) return { rows, stats: null };
  const byId = new Map(rows.map(r => [r.id, r]));
  let secondAccounts = 0;
  const kept = rows.filter((r) => {
    if (!population.rules.every(rule => passesRule(r, rule))) return false;
    if (population.excludeSecondAccounts && isSecondAccount(r, byId)) { secondAccounts++; return false; }
    return true;
  });
  const keptIds = new Set(kept.map(r => r.id));
  return {
    rows: kept.map(r => ({ ...r, managerId: nearestKeptManager(r, byId, keptIds) })),
    stats: {
      accountsTotal: rows.length,
      peopleIncluded: kept.length,
      filteredOut: rows.length - kept.length - secondAccounts,
      secondAccounts,
    },
  };
}
