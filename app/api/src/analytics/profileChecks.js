// The database half of profile validation, run on save and on preview:
//
//   * every discovered `extendedAttributes` field must exist in this install;
//   * every scoped system id must exist;
//   * every dimension's distinct values are MEASURED over the profile's scope —
//     above LIMITS.maxDimensionValues the field is refused with the number, so a
//     customer learns that "comment" is free text before Power BI does;
//   * each dataset gets an upper bound on its row count (the product of its
//     dimensions' distinct counts) — the impact preview. Exceeding maxRows is a
//     warning here, because the joint combinations that actually occur are
//     usually far fewer; the hard limit is enforced when the dataset runs.

import * as db from '../db/connection.js';
import { createParams } from '../db/sqlParams.js';
import { resolveField, discoveredKeys, fieldSql } from './fields.js';
import { LIMITS } from './profileSchema.js';
import { liveAccountWhere } from './sqlParts.js';

// FROM/WHERE per entity, matching what the datasets count.
function populationSql(entity, scope, bind) {
  if (entity === 'Principal') return `FROM "Principals" p WHERE ${liveAccountWhere(scope, bind)}`;
  if (entity === 'Identity') {
    return `FROM "Identities" i WHERE EXISTS (
      SELECT 1 FROM "IdentityMembers" im JOIN "Principals" p ON p."id" = im."principalId"
       WHERE im."identityId" = i."id" AND ${liveAccountWhere(scope, bind)})`;
  }
  return `FROM "Resources" r WHERE r."deletedAt" IS NULL`;
}

/** Distinct non-blank values of one field, counted up to cap + 1. */
export async function measureDistinct(field, scope, cap = LIMITS.maxDimensionValues) {
  const q = createParams();
  const value = `NULLIF(btrim(${fieldSql(field, q.bind)}), '')`;
  const sql = `SELECT COUNT(*)::int AS n FROM (
      SELECT DISTINCT ${value} AS v ${populationSql(field.entity, scope, q.bind)} LIMIT ${q.bind(cap + 1)}
    ) x WHERE x.v IS NOT NULL`;
  const row = await db.queryOne(sql, q.params);
  return row?.n ?? 0;
}

async function checkDiscoveredFields(definition, errors) {
  const cache = new Map();
  for (const [i, dim] of definition.dimensions.entries()) {
    const field = resolveField(dim.field);
    if (!field.discovered) continue;
    if (!cache.has(field.entity)) cache.set(field.entity, await discoveredKeys(field.entity));
    if (!cache.get(field.entity).has(field.extKey)) {
      errors.push({ path: `dimensions[${i}].field`, code: 'unknown_field',
        message: `${field.id}: no ${field.entity} in this install has an extended attribute "${field.extKey}"` });
    }
  }
}

async function checkScope(definition, errors) {
  const ids = definition.scope.systemIds;
  if (!ids) return;
  const { rows } = await db.query(`SELECT "id" FROM "Systems" WHERE "id" = ANY($1::int[])`, [ids]);
  const found = new Set(rows.map(r => r.id));
  const missing = ids.filter(id => !found.has(id));
  if (missing.length) {
    errors.push({ path: 'scope.systemIds', code: 'unknown_system', message: `No such system: ${missing.join(', ')}` });
  }
}

async function measureDimensions(definition, errors) {
  const measured = [];
  for (const [i, dim] of definition.dimensions.entries()) {
    const field = resolveField(dim.field);
    const distinctValues = await measureDistinct(field, definition.scope);
    measured.push({ field: field.id, distinctValues: Math.min(distinctValues, LIMITS.maxDimensionValues + 1), bounded: field.bounded });
    if (distinctValues > LIMITS.maxDimensionValues) {
      errors.push({ path: `dimensions[${i}].field`, code: 'high_cardinality',
        message: `${field.id} has more than ${LIMITS.maxDimensionValues} distinct values in scope; it is not a category `
          + '(free text or an identifier) and cannot be a reporting dimension.' });
    }
  }
  return measured;
}

/**
 * Upper bound on a dataset's cells: the product, over its dimensions, of the
 * distinct values plus the buckets a value can fall into besides them — the
 * unknown bucket, and for identity fields read through an account also
 * "(not linked)" and "(multiple identities)".
 */
export function estimateRows(dataset, measured) {
  const byField = new Map(measured.map(m => [m.field, m.distinctValues]));
  return dataset.dimensions.reduce((acc, f) => {
    const extraBuckets = resolveField(f).entity === 'Identity' ? 3 : 1;
    return acc * ((byField.get(f) ?? 0) + extraBuckets);
  }, 1);
}

/**
 * Run the database checks for a shape-valid definition.
 * Returns { errors, warnings, preview }.
 */
export async function checkAgainstData(definition) {
  const errors = [];
  await checkScope(definition, errors);
  await checkDiscoveredFields(definition, errors);
  if (errors.length) return { errors, warnings: [], preview: null };

  const dimensions = await measureDimensions(definition, errors);
  const warnings = [];
  const datasets = definition.datasets.map((ds) => {
    const estimatedMaxRows = estimateRows(ds, dimensions);
    if (estimatedMaxRows > definition.limits.maxRows) {
      warnings.push({ path: `datasets.${ds.id}`, code: 'may_exceed_max_rows',
        message: `Up to ${estimatedMaxRows} cells are possible; more than ${definition.limits.maxRows} will be refused at run time.` });
    }
    return { id: ds.id, estimatedMaxRows };
  });
  return { errors, warnings, preview: { dimensions, datasets } };
}
