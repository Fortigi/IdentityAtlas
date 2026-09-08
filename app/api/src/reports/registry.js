// Report-template registry, mirroring the context-plugin registry.
//
// Templates are in-tree code modules, never user-uploaded, so there is no
// dynamic import from user input: the built-ins are imported statically by
// templates/index.js and seeded here at module load. `registerReport` exists so
// a test (or a future in-tree module) can add a template without touching the
// engine — which is exactly the property the seam test asserts.

import { BUILT_IN_REPORTS } from './templates/index.js';

// Seeded straight from the built-ins — importing the registry must not be able
// to throw, so the field validation below is applied to templates registered at
// runtime and asserted for the built-ins by registry.test.js instead.
/** @type {Map<string, import('./types.js').ReportTemplate>} */
const REPORTS = new Map(BUILT_IN_REPORTS.map(t => [t.name, t]));

const REQUIRED_FIELDS = ['name', 'displayName', 'form', 'columns', 'run'];

/**
 * Add a template to the registry.
 * @param {import('./types.js').ReportTemplate} template
 * @returns {() => void} unregister callback
 */
export function registerReport(template) {
  const missing = REQUIRED_FIELDS.filter(f => !template?.[f]);
  if (missing.length) throw new Error(`Invalid report template: missing ${missing.join(', ')}`);
  REPORTS.set(template.name, template);
  return () => { REPORTS.delete(template.name); };
}

/** Every registered template, ordered by display name. */
export function listReports() {
  return [...REPORTS.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/** The template with this name, or null when it isn't registered. */
export function getReport(name) {
  return REPORTS.get(name) || null;
}

/**
 * The client-facing metadata of a template — everything the UI needs to list it
 * and to render whatever form it declares, and nothing executable.
 */
export function reportMetadata(template) {
  return {
    name: template.name,
    displayName: template.displayName,
    description: template.description || '',
    form: template.form,
    parametersSchema: template.parametersSchema || { type: 'object', required: [], properties: {} },
    columns: template.columns,
  };
}
