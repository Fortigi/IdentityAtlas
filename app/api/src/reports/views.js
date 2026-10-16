// Saved report views — a built-in report with its parameters filled in and a name.
//
// A report like the access review is only useful once someone has picked its
// contexts, its columns and its pivots, and nobody should have to pick them
// again every time. A view stores those choices, shared across the deployment,
// and is served through the report registry as a report of its own named
// `view-<id>`: the Reports page lists it, its tab runs and downloads it, and
// none of that needed new code (see registerReportSource in registry.js).
//
// Running a view runs the built-in report with the saved parameters, overlaid by
// whatever is set on the tab — so a view can still be adjusted for one run
// without being changed. Nothing is snapshotted except the choices.
//
// Generic: any built-in report that declares parameters can have views. Nothing
// here knows the Entitlement Pivot.

import { randomUUID } from 'crypto';
import { query, queryOne } from '../db/connection.js';
import { getReport, registerReportSource } from './registry.js';

export const VIEW_PREFIX = 'view-';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLUMNS = `"id", "reportName", "name", "description", "params", "createdBy", "createdAt", "updatedBy", "updatedAt"`;

// Bounds on what one view may store. A parameter value is a string or a list of
// strings — that is all a query string can carry, and all a template receives.
export const MAX_NAME = 200;
export const MAX_DESCRIPTION = 2000;
export const MAX_VALUE_LENGTH = 2000;
export const MAX_LIST = 500;

export const isViewId = (id) => typeof id === 'string' && UUID.test(id);

/** The built-in report a view may be saved over, or null: it must exist and take parameters. */
export function viewableReport(reportName) {
  const report = typeof reportName === 'string' ? getReport(reportName) : null;
  const properties = report?.parametersSchema?.properties;
  return report && properties && Object.keys(properties).length ? report : null;
}

/**
 * One parameter value as a view stores it: trimmed text, or a list of trimmed,
 * non-empty texts. Anything else — a number, an object, an empty value — is not
 * stored, because the template would receive it as a string anyway and an empty
 * one means "use the default".
 */
export function cleanValue(value) {
  if (Array.isArray(value)) {
    const list = value.filter(v => typeof v === 'string').map(v => v.trim().slice(0, MAX_VALUE_LENGTH)).filter(Boolean);
    return list.length ? list.slice(0, MAX_LIST) : undefined;
  }
  if (typeof value === 'string') return value.trim().slice(0, MAX_VALUE_LENGTH) || undefined;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

/**
 * The parameters to store: only the ones the report declares — a view must not
 * become a way to smuggle arbitrary keys into a template's run() — each cleaned.
 */
export function cleanParams(report, params) {
  const declared = Object.keys(report.parametersSchema.properties);
  const clean = {};
  for (const key of declared) {
    if (!params || typeof params !== 'object' || !Object.hasOwn(params, key)) continue;
    const value = cleanValue(params[key]);
    if (value !== undefined) clean[key] = value;
  }
  return clean;
}

/** Validate a create/update body. Returns { errors } or { value } ready to store. */
export function prepareView(body, { existingReportName } = {}) {
  const errors = [];
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name) errors.push('A name is required');
  if (name.length > MAX_NAME) errors.push(`The name is too long (max ${MAX_NAME} characters)`);
  const description = typeof body?.description === 'string' ? body.description.trim().slice(0, MAX_DESCRIPTION) : '';

  // A view stays a view of the report it was made from; an update cannot move it.
  const reportName = existingReportName ?? body?.reportName;
  const report = viewableReport(reportName);
  if (!report) errors.push('A view needs a standard report that takes parameters');

  if (errors.length) return { errors };
  return { value: { reportName, name, description: description || null, params: cleanParams(report, body?.params) } };
}

export async function listViews() {
  const { rows } = await query(`SELECT ${COLUMNS} FROM "ReportViews" ORDER BY lower("name")`);
  return rows;
}

export async function getView(id) {
  if (!isViewId(id)) return null;
  return queryOne(`SELECT ${COLUMNS} FROM "ReportViews" WHERE "id" = $1`, [id]);
}

const isUniqueViolation = (err) => err?.code === '23505';

export async function createView(value, user) {
  try {
    return await queryOne(
      `INSERT INTO "ReportViews" ("id", "reportName", "name", "description", "params", "createdBy", "updatedBy")
       VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING ${COLUMNS}`,
      [randomUUID(), value.reportName, value.name, value.description, JSON.stringify(value.params), user],
    );
  } catch (err) {
    if (isUniqueViolation(err)) return { conflict: true };
    throw err;
  }
}

export async function updateView(id, value, user) {
  if (!isViewId(id)) return null;
  try {
    return await queryOne(
      `UPDATE "ReportViews" SET "name" = $2, "description" = $3, "params" = $4, "updatedBy" = $5, "updatedAt" = now()
        WHERE "id" = $1 RETURNING ${COLUMNS}`,
      [id, value.name, value.description, JSON.stringify(value.params), user],
    );
  } catch (err) {
    if (isUniqueViolation(err)) return { conflict: true };
    throw err;
  }
}

export async function deleteView(id) {
  if (!isViewId(id)) return false;
  const { rowCount } = await query(`DELETE FROM "ReportViews" WHERE "id" = $1`, [id]);
  return rowCount > 0;
}

/**
 * The report's parameter schema with the view's values as the defaults. The form
 * shows the effective values as defaults, so a view's tab opens with its own
 * choices filled in; a property the view fills is no longer required of the
 * person running it.
 */
export function viewSchema(schema, params) {
  const properties = Object.fromEntries(Object.entries(schema.properties).map(([key, prop]) => [
    key, Object.hasOwn(params, key) ? { ...prop, default: params[key] } : prop,
  ]));
  const required = (schema.required || []).filter(key => !Object.hasOwn(params, key));
  return { ...schema, properties, required };
}

const isoOrNull = (value) => (value instanceof Date ? value.toISOString() : value || null);

/** A stored view, shaped as a report template — or null when its report is gone. */
export function toReportTemplate(row) {
  const base = viewableReport(row.reportName);
  if (!base) return null;
  const saved = row.params && typeof row.params === 'object' ? row.params : {};
  return {
    name: `${VIEW_PREFIX}${row.id}`,
    displayName: row.name,
    description: row.description || base.description || '',
    form: base.form,
    parametersSchema: viewSchema(base.parametersSchema, saved),
    columns: base.columns,
    pivots: base.pivots,
    source: 'view',
    author: { createdBy: row.createdBy || null, updatedBy: row.updatedBy || null, updatedAt: isoOrNull(row.updatedAt) },
    view: { id: row.id, reportName: base.name, reportDisplayName: base.displayName },
    // The tab's own settings win over the saved ones, so a view can be adjusted
    // for one run without being changed.
    run: (params, ctx) => base.run({ ...saved, ...(params || {}) }, ctx),
  };
}

registerReportSource({
  async list() {
    return (await listViews()).map(toReportTemplate).filter(Boolean);
  },
  async get(name) {
    if (!name.startsWith(VIEW_PREFIX)) return null;
    const row = await getView(name.slice(VIEW_PREFIX.length));
    return row ? toReportTemplate(row) : null;
  },
});
