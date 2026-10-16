// The steps of the "save as view" wizard, derived from a report's parameters.
//
// A report groups its parameters into steps with `x-step` on each property —
// the Entitlement Pivot asks for its scope, then its columns, then its Excel pivots.
// A property without one lands in a "Settings" step, so a report that never
// heard of the wizard still gets one. The last step names the view. Nothing here
// knows any particular report.

export const SETTINGS_STEP = 'Settings';
export const NAME_STEP = 'Name';

/** `[{ n, label, keys }]` in the order the properties are declared, then the name step. */
export function viewSteps(schema) {
  const groups = new Map();
  for (const [key, prop] of Object.entries(schema?.properties || {})) {
    const label = prop?.['x-step'] || SETTINGS_STEP;
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(key);
  }
  const steps = [...groups].map(([label, keys], i) => ({ n: i + 1, label, keys }));
  return [...steps, { n: steps.length + 1, label: NAME_STEP, keys: [] }];
}

const isEmpty = value => value === undefined || value === null || value === ''
  || (Array.isArray(value) && value.length === 0);

/** The required parameters among `keys` that have no value yet — what blocks "Next". */
export function missingRequired(schema, keys, params) {
  const required = new Set(schema?.required || []);
  return keys.filter(key => required.has(key) && isEmpty(params?.[key]));
}

/** The schema narrowed to one step's properties, for the shared parameter form. */
export function stepSchema(schema, keys) {
  return { ...schema, properties: Object.fromEntries(keys.map(key => [key, schema.properties[key]])) };
}

/**
 * Where and how to save. A report that is already a view is updated in place,
 * unless the person asked for a new one; a new view is always of the STANDARD
 * report, never of another view.
 */
export function viewRequest(report, { name, description, params }, { asNew = false } = {}) {
  const body = { name, description, params };
  if (report?.view && !asNew) {
    return { method: 'PUT', url: `/api/report-views/${encodeURIComponent(report.view.id)}`, body };
  }
  return { method: 'POST', url: '/api/report-views', body: { ...body, reportName: report?.view?.reportName ?? report?.name } };
}
