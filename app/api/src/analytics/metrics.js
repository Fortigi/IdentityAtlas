// The analytics metric catalog — what each metric counts, exactly.
//
// A metric is a contract: grain (the one thing counted), measures, which
// entities' fields may slice it, how deleted rows are treated and which history
// method produced the numbers. The SQL lives in aggregator.js / asOfQuery.js;
// this module is data, so the catalog endpoint and the validator read the same
// definitions the aggregator obeys. Bump `version` whenever a definition's
// meaning changes — every dataset response carries it.
//
// See docs/architecture/analytics-profiles.md §4 for the prose definitions.

export const TIMEZONE = 'UTC';

const COMMON = { timezone: TIMEZONE, deletedRows: 'excluded' };

export const METRICS = Object.freeze({
  'principals.count': {
    ...COMMON,
    id: 'principals.count', version: 1, label: 'Accounts', kind: 'snapshot', historyMethod: 'current',
    grain: 'One live account (Principals row with deletedAt IS NULL), excluding group principals, in source scope.',
    description: 'Number of accounts. An account counts once per dataset: one linked to no identity is '
      + '"(not linked)", one linked to several identities is "(multiple identities)" on identity dimensions.',
    measures: [{ name: 'accounts', type: 'integer', description: 'Number of accounts in the cell.' }],
    population: 'accounts',
    entities: ['Principal', 'Identity'],
  },
  'identities.count': {
    ...COMMON,
    id: 'identities.count', version: 1, label: 'Identities', kind: 'snapshot', historyMethod: 'current',
    grain: 'One identity with at least one live, non-group linked account in source scope.',
    description: 'Number of identities (persons). An identity with several accounts counts once. '
      + 'Identities without a live account are reported as excluded, not counted.',
    measures: [{ name: 'identities', type: 'integer', description: 'Number of identities in the cell.' }],
    population: 'identities',
    entities: ['Identity'],
    rejected: {
      Principal: 'An identity can have several accounts with different values, so an account field '
        + 'would count one identity in several cells. Use principals.count with identity dimensions.',
      Resource: 'Identities have no single resource; use assignments.governedShare.',
    },
  },
  'assignments.governedShare': {
    ...COMMON,
    id: 'assignments.governedShare', version: 1, label: 'Governed share of access', kind: 'snapshot',
    historyMethod: 'current',
    grain: 'One distinct (account, resource) pair in the matrix view (tombstones already excluded), held '
      + 'by a live non-group account in source scope, on a resource type visible by default (BusinessRole '
      + 'rows excluded). Same definition as the matrix scope statistics.',
    description: 'governedPairs / pairs, where a pair is governed when a business role / access package the '
      + 'account holds covers it. Ownership pairs count as ungoverned access.',
    measures: [
      { name: 'pairs', type: 'integer', description: 'Denominator: access pairs in the cell.' },
      { name: 'governedPairs', type: 'integer', description: 'Numerator: pairs covered by a held business role.' },
      { name: 'ungovernedPairs', type: 'integer', description: 'pairs - governedPairs.' },
      { name: 'unknownPairs', type: 'integer', description: 'Pairs whose governed state is unknown (always 0 in v1: coverage is decidable).' },
      { name: 'governedShare', type: 'decimal', description: 'governedPairs / pairs, null when pairs is 0 or suppressed.' },
      { name: 'holders', type: 'integer', description: 'Distinct accounts holding the pairs (the suppression population).' },
    ],
    population: 'holders',
    entities: ['Principal', 'Identity', 'Resource'],
  },
  'principals.countAsOf': {
    ...COMMON,
    id: 'principals.countAsOf', version: 1, label: 'Accounts at period end', kind: 'snapshot',
    historyMethod: 'reconstructed', timeGrain: 'month', maxPeriods: 12, defaultPeriods: 6,
    grain: 'One account alive at the end of each calendar month (UTC), reconstructed from the audit log: '
      + 'not tombstoned at that instant, its system already loaded, excluding group principals, in source scope.',
    description: 'Point-in-time account stock with the attribute values the account had at that instant. '
      + 'Periods before the oldest retained audit event are reported as unavailable, never estimated.',
    measures: [{ name: 'accounts', type: 'integer', description: 'Number of accounts alive at period end.' }],
    population: 'accounts',
    entities: ['Principal'],
    rejected: {
      Identity: 'Identities are not audited, so a past department or company cannot be reconstructed. '
        + 'Only current values exist (use principals.count).',
      Resource: 'Not an account attribute.',
    },
  },
});

/** The metric definition, or null. */
export function getMetric(id) {
  return typeof id === 'string' && Object.hasOwn(METRICS, id) ? METRICS[id] : null;
}

/**
 * Why `entity`'s fields cannot slice `metric`, or null when they can.
 * A metric names the entities it accepts; anything else is refused with the
 * metric's own explanation (or a generic one).
 */
export function entityRejection(metric, entity) {
  if (metric.entities.includes(entity)) return null;
  return metric.rejected?.[entity] || `${metric.id} cannot be broken down by ${entity} fields.`;
}

/** Catalog view of every metric. */
export function describeMetrics() {
  return Object.values(METRICS).map(m => ({
    id: m.id, version: m.version, label: m.label, kind: m.kind, historyMethod: m.historyMethod,
    grain: m.grain, description: m.description, measures: m.measures, population: m.population,
    dimensionEntities: m.entities, timezone: m.timezone, deletedRows: m.deletedRows,
    ...(m.timeGrain ? { timeGrain: m.timeGrain, maxPeriods: m.maxPeriods, defaultPeriods: m.defaultPeriods } : {}),
  }));
}
