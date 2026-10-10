// Runs one dataset of one Analytics Profile and shapes the response.
//
// Bounded by construction: the dimensions are a whitelisted, validated subset
// of the profile (≤ 4), the result is refused — never truncated — above
// limits.maxRows, every statement runs under a statement_timeout, and small
// cells are suppressed. Read-only: nothing here writes.

import * as db from '../db/connection.js';
import { createParams } from '../db/sqlParams.js';
import { resolveField } from './fields.js';
import { iriFor } from './ontologyTerms.js';
import { getMetric } from './metrics.js';
import { dimensionOf } from './profileSchema.js';
import {
  principalsCountSql, identitiesCountSql, identitiesExcludedSql, governedShareSql, governedExcludedSql,
} from './snapshotQueries.js';
import { monthPeriods, classifyPeriods, principalsAsOfSql, bindAsOf, HISTORY_START_SQL } from './asOfQuery.js';
import {
  AnalyticsError, assertWithinRowLimit, deriveGovernedMeasures, suppressSmallCells, namedRows, columnsFor,
} from './shaping.js';

export const API_VERSION = 'analytics/v1';
export const STATEMENT_TIMEOUT_MS = 120000;

const SNAPSHOT_BUILDERS = {
  'principals.count': { sql: principalsCountSql },
  'identities.count': { sql: identitiesCountSql, excluded: identitiesExcludedSql },
  'assignments.governedShare': { sql: governedShareSql, excluded: governedExcludedSql, derive: deriveGovernedMeasures },
};

/** The dataset's dimensions, resolved against the registry and the profile. */
export function resolveDims(definition, dataset) {
  return dataset.dimensions.map((fieldId) => {
    const field = resolveField(fieldId);
    const dimension = dimensionOf(definition, fieldId);
    if (!field || !dimension) {
      // A stored profile is validated on save; this only fires if the registry
      // changed under it (a field removed in an upgrade).
      throw new AnalyticsError(409, 'profile_outdated', `Field ${fieldId} is no longer available; edit and re-save the profile.`);
    }
    return { field, dimension: { ...dimension, iri: iriFor(fieldId) } };
  });
}

async function inTimedTx(fn) {
  return db.tx(async (client) => {
    await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    return fn(client);
  });
}

async function runSnapshot(client, metric, dims, definition) {
  const builder = SNAPSHOT_BUILDERS[metric.id];
  const { scope, limits } = definition;
  const q = createParams();
  const sql = builder.sql({ dims, scope, maxRows: limits.maxRows, bind: q.bind });
  const { rows } = await client.query(sql, q.params);
  assertWithinRowLimit(rows.length, limits.maxRows);
  let excluded = {};
  if (builder.excluded) {
    const e = createParams();
    excluded = (await client.query(builder.excluded({ scope, bind: e.bind }), e.params)).rows[0] || {};
  }
  const derived = builder.derive ? rows.map(builder.derive) : rows;
  return { rawRows: derived, excluded, leading: [], coverage: null };
}

async function runAsOf(client, metric, dims, definition, dataset, now) {
  const { scope, limits } = definition;
  const startRow = (await client.query(HISTORY_START_SQL)).rows[0];
  const historyStart = startRow?.start ? new Date(startRow.start) : null;
  const { available, unavailable } = classifyPeriods(monthPeriods(dataset.periods, now), historyStart);

  const q = createParams();
  const base = principalsAsOfSql({ dims, scope, maxRows: limits.maxRows, bind: q.bind });
  const sql = bindAsOf(base, q.params);
  const rawRows = [];
  for (const p of available) {
    const { rows } = await client.query(sql, [...q.params, p.periodEnd]);
    const method = p.periodComplete ? 'reconstructed' : 'current';
    for (const r of rows) {
      rawRows.push({ period: p.period, periodEnd: p.periodEnd, periodComplete: p.periodComplete, historyMethod: method, ...r });
    }
    assertWithinRowLimit(rawRows.length, limits.maxRows);
  }
  return {
    rawRows,
    excluded: {},
    leading: ['period', 'periodEnd', 'periodComplete', 'historyMethod'],
    coverage: {
      historyStart: historyStart ? historyStart.toISOString() : null,
      periods: available.map(p => p.period),
      unavailablePeriods: unavailable.map(p => p.period),
      reason: unavailable.length
        ? 'These months end before the oldest retained audit event (HISTORY_RETENTION_DAYS or the start of auditing); they are not estimated.'
        : null,
    },
  };
}

const LEADING_COLUMNS = {
  period: { name: 'period', label: 'period', role: 'time', type: 'text', description: 'Calendar month (UTC), YYYY-MM.' },
  periodEnd: { name: 'periodEnd', label: 'periodEnd', role: 'time', type: 'datetime', description: 'The instant reconstructed: last millisecond of the month (UTC), or now for the running month.' },
  periodComplete: { name: 'periodComplete', label: 'periodComplete', role: 'time', type: 'boolean', description: 'False for the running month.' },
  historyMethod: { name: 'historyMethod', label: 'historyMethod', role: 'label', type: 'text', description: 'reconstructed (from the audit log) or current (live rows).' },
};

/** Freshness of the source data in scope: the latest completed sync. */
async function freshness(client, scope) {
  const q = createParams();
  const where = scope?.systemIds ? `WHERE "id" = ANY(${q.bind(scope.systemIds)}::int[])` : '';
  const row = (await client.query(
    `SELECT MAX("lastSyncDateTime") AS "lastSyncAt", COUNT(*)::int AS systems,
            COUNT(*) FILTER (WHERE "lastSyncDateTime" IS NULL)::int AS "neverSynced"
       FROM "Systems" ${where}`, q.params)).rows[0] || {};
  return {
    lastSyncAt: row.lastSyncAt ? new Date(row.lastSyncAt).toISOString() : null,
    systemsInScope: row.systems ?? 0,
    systemsNeverSynced: row.neverSynced ?? 0,
    note: 'Current metrics read the live tables and the matrix views, which are refreshed after every sync; '
      + 'the view refresh instant itself is not recorded.',
  };
}

/**
 * Run dataset `datasetId` of a stored profile row
 * ({ id, name, version, status, definition }).
 */
export async function runDataset(profile, datasetId, { now = new Date() } = {}) {
  if (profile.status !== 'active') throw new AnalyticsError(409, 'profile_retired', 'This profile is retired.');
  const { definition } = profile;
  const dataset = definition.datasets.find(d => d.id === datasetId);
  if (!dataset) throw new AnalyticsError(404, 'not_found', 'No such dataset in this profile.');
  const metric = getMetric(dataset.metric);
  const dims = resolveDims(definition, dataset);

  const result = await inTimedTx(async (client) => {
    const run = metric.historyMethod === 'reconstructed'
      ? await runAsOf(client, metric, dims, definition, dataset, now)
      : await runSnapshot(client, metric, dims, definition);
    return { ...run, fresh: await freshness(client, definition.scope) };
  });

  const dimensionIds = dims.map(d => d.field.id);
  const measureNames = metric.measures.map(m => m.name);
  const named = namedRows(result.rawRows, dimensionIds, measureNames, result.leading);
  const { rows, suppressed } = suppressSmallCells(named, {
    population: metric.population, measures: measureNames, minGroupSize: definition.privacy.minGroupSize,
  });

  return {
    apiVersion: API_VERSION,
    generatedAt: now.toISOString(),
    profile: { id: profile.id, name: profile.name, version: profile.version },
    dataset: {
      id: dataset.id, metric: metric.id, metricVersion: metric.version, kind: metric.kind,
      historyMethod: metric.historyMethod, grain: metric.grain, timezone: metric.timezone,
      ...(dataset.periods ? { timeGrain: metric.timeGrain, periods: dataset.periods } : {}),
    },
    columns: columnsFor({
      dimensions: dims.map(d => ({ field: d.field.id, ...d.dimension })),
      metric,
      leading: result.leading.map(k => LEADING_COLUMNS[k]),
    }),
    rows,
    rowCount: rows.length,
    suppression: { minGroupSize: definition.privacy.minGroupSize, suppressedCells: suppressed },
    excluded: result.excluded,
    coverage: result.coverage,
    freshness: result.fresh,
  };
}
