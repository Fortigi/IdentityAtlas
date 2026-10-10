// Analytics Profile validation — the shape check, with no database access.
//
// validateProfileInput() takes an untrusted request body and returns either the
// normalized profile or a list of errors, each naming the path it is about and
// why. Field ids are checked against the whitelist (fields.js) and against the
// metric's allowed entities (metrics.js); anything unknown is an error, never
// silently dropped. Database-dependent checks (does a discovered key exist, how
// many distinct values does a field have) live in profileChecks.js.

import { resolveField } from './fields.js';
import { getMetric, entityRejection } from './metrics.js';

export const LIMITS = Object.freeze({
  maxProfileDimensions: 8,
  maxDatasets: 10,
  maxDatasetDimensions: 4,
  maxDimensionValues: 200,
  defaultMaxRows: 10000,
  maxRowsCeiling: 50000,
  defaultMinGroupSize: 5,
  maxMinGroupSize: 100,
  maxScopeSystems: 500,
});

export const DEFAULT_UNKNOWN_LABEL = '(unknown)';
const STATUSES = ['active', 'retired'];
const DATASET_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

function optionalText(value, path, max, errors) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > max) {
    errors.push({ path, code: 'invalid', message: `must be a string of at most ${max} characters` });
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function intInRange(value, fallback, min, max, path, errors) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    errors.push({ path, code: 'out_of_range', message: `must be an integer from ${min} to ${max}` });
    return fallback;
  }
  return value;
}

function validateScope(scope, errors) {
  if (scope === undefined || scope === null) return { systemIds: null };
  if (!isObject(scope)) {
    errors.push({ path: 'scope', code: 'invalid', message: 'must be an object' });
    return { systemIds: null };
  }
  const ids = scope.systemIds;
  if (ids === undefined || ids === null) return { systemIds: null };
  const valid = Array.isArray(ids) && ids.length > 0 && ids.length <= LIMITS.maxScopeSystems
    && ids.every(n => Number.isInteger(n) && n > 0);
  if (!valid) {
    errors.push({ path: 'scope.systemIds', code: 'invalid', message: `must be 1-${LIMITS.maxScopeSystems} positive integer system ids` });
    return { systemIds: null };
  }
  return { systemIds: [...new Set(ids)].sort((a, b) => a - b) };
}

function validateDimension(dim, i, errors) {
  const path = `dimensions[${i}]`;
  if (!isObject(dim)) {
    errors.push({ path, code: 'invalid', message: 'must be an object with a field' });
    return null;
  }
  const field = resolveField(dim.field);
  if (!field) {
    errors.push({ path: `${path}.field`, code: 'unknown_field', message: `"${String(dim.field)}" is not a known field id` });
    return null;
  }
  if (!field.reportable) {
    errors.push({ path: `${path}.field`, code: 'not_reportable', message: `${field.id}: ${field.reason}` });
    return null;
  }
  return {
    field: field.id,
    label: optionalText(dim.label, `${path}.label`, 100, errors) || field.label,
    unknownLabel: optionalText(dim.unknownLabel, `${path}.unknownLabel`, 50, errors) || DEFAULT_UNKNOWN_LABEL,
  };
}

function validateDimensions(list, errors) {
  if (!Array.isArray(list) || list.length === 0 || list.length > LIMITS.maxProfileDimensions) {
    errors.push({ path: 'dimensions', code: 'invalid', message: `must list 1-${LIMITS.maxProfileDimensions} dimensions` });
    return [];
  }
  const out = [];
  const seen = new Set();
  list.forEach((dim, i) => {
    const d = validateDimension(dim, i, errors);
    if (!d) return;
    if (seen.has(d.field)) {
      errors.push({ path: `dimensions[${i}].field`, code: 'duplicate', message: `${d.field} is selected twice` });
      return;
    }
    seen.add(d.field);
    out.push(d);
  });
  return out;
}

function validateDatasetDimensions(ds, path, metric, profileFields, errors) {
  const dims = ds.dimensions ?? [];
  if (!Array.isArray(dims) || dims.length > LIMITS.maxDatasetDimensions) {
    errors.push({ path: `${path}.dimensions`, code: 'invalid', message: `must list at most ${LIMITS.maxDatasetDimensions} dimensions` });
    return [];
  }
  if (new Set(dims).size !== dims.length) {
    errors.push({ path: `${path}.dimensions`, code: 'duplicate', message: 'lists a dimension twice' });
    return [];
  }
  const ok = [];
  dims.forEach((fieldId, j) => {
    const p = `${path}.dimensions[${j}]`;
    if (!profileFields.has(fieldId)) {
      errors.push({ path: p, code: 'not_in_profile', message: `"${String(fieldId)}" is not one of the profile's dimensions` });
      return;
    }
    const why = metric ? entityRejection(metric, resolveField(fieldId).entity) : null;
    if (why) {
      errors.push({ path: p, code: 'unsupported_breakdown', message: `${fieldId}: ${why}` });
      return;
    }
    ok.push(fieldId);
  });
  return ok;
}

function validateDataset(ds, i, profileFields, seenIds, errors) {
  const path = `datasets[${i}]`;
  if (!isObject(ds)) {
    errors.push({ path, code: 'invalid', message: 'must be an object' });
    return null;
  }
  if (typeof ds.id !== 'string' || !DATASET_ID.test(ds.id)) {
    errors.push({ path: `${path}.id`, code: 'invalid', message: 'must be lowercase letters, digits and dashes (max 63)' });
  } else if (seenIds.has(ds.id)) {
    errors.push({ path: `${path}.id`, code: 'duplicate', message: `dataset id "${ds.id}" is used twice` });
  } else {
    seenIds.add(ds.id);
  }
  const metric = getMetric(ds.metric);
  if (!metric) errors.push({ path: `${path}.metric`, code: 'unknown_metric', message: `"${String(ds.metric)}" is not a known metric` });
  const dimensions = validateDatasetDimensions(ds, path, metric, profileFields, errors);
  const out = { id: ds.id, metric: ds.metric, dimensions };
  if (metric?.timeGrain) {
    out.periods = intInRange(ds.periods, metric.defaultPeriods, 1, metric.maxPeriods, `${path}.periods`, errors);
  } else if (ds.periods !== undefined) {
    errors.push({ path: `${path}.periods`, code: 'invalid', message: `${ds.metric} is a current snapshot and takes no periods` });
  }
  return out;
}

function validateDatasets(list, profileFields, errors) {
  if (!Array.isArray(list) || list.length === 0 || list.length > LIMITS.maxDatasets) {
    errors.push({ path: 'datasets', code: 'invalid', message: `must list 1-${LIMITS.maxDatasets} datasets` });
    return [];
  }
  const seenIds = new Set();
  return list.map((ds, i) => validateDataset(ds, i, profileFields, seenIds, errors)).filter(Boolean);
}

/** The definition part: scope, dimensions, datasets, privacy, limits. */
export function validateDefinition(input) {
  const errors = [];
  if (!isObject(input)) return { errors: [{ path: 'definition', code: 'invalid', message: 'must be an object' }] };
  const scope = validateScope(input.scope, errors);
  const dimensions = validateDimensions(input.dimensions, errors);
  const datasets = validateDatasets(input.datasets, new Set(dimensions.map(d => d.field)), errors);
  const privacy = {
    minGroupSize: intInRange(input.privacy?.minGroupSize, LIMITS.defaultMinGroupSize, 1, LIMITS.maxMinGroupSize, 'privacy.minGroupSize', errors),
  };
  const limits = {
    maxRows: intInRange(input.limits?.maxRows, LIMITS.defaultMaxRows, 1, LIMITS.maxRowsCeiling, 'limits.maxRows', errors),
  };
  return errors.length ? { errors } : { errors: [], definition: { scope, dimensions, datasets, privacy, limits } };
}

/** A whole profile request body: { name, description?, status?, definition }. */
export function validateProfileInput(body) {
  const errors = [];
  if (!isObject(body)) return { errors: [{ path: '', code: 'invalid', message: 'body must be an object' }] };
  const name = optionalText(body.name, 'name', 200, errors);
  if (!name && !errors.some(e => e.path === 'name')) errors.push({ path: 'name', code: 'required', message: 'is required' });
  const description = optionalText(body.description, 'description', 2000, errors);
  const status = body.status ?? 'active';
  if (!STATUSES.includes(status)) errors.push({ path: 'status', code: 'invalid', message: `must be one of ${STATUSES.join(', ')}` });
  const def = validateDefinition(body.definition);
  errors.push(...def.errors);
  return errors.length ? { errors } : { errors: [], profile: { name, description, status, definition: def.definition } };
}

/** The profile dimension entry for a field id (label + unknown label). */
export function dimensionOf(definition, fieldId) {
  return definition.dimensions.find(d => d.field === fieldId);
}
