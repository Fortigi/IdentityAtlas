// Natural-language reports (PROTOTYPE) — saved report definitions.
//
// Storage for SavedReports plus the bridge into the report registry: every saved
// report is served as a regular `list` report named `custom-<id>`, so the
// existing report tab, Refresh and Download work for it with no extra code.

import { randomUUID } from 'crypto';
import { query, queryOne } from '../db/connection.js';
import { registerReportSource } from '../reports/registry.js';
import { compileSpec } from './compile.js';
import { validateSpec } from './spec.js';
import { loadValues, runSpec } from './service.js';
import { resolveNamedObjects } from './references.js';
import { isFeatureEnabled } from '../featureFlags.js';

export const SAVED_PREFIX = 'custom-';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLUMNS = `"id", "name", "description", "definition", "question", "createdBy", "createdAt", "updatedBy", "updatedAt"`;

export const isSavedReportId = (id) => typeof id === 'string' && UUID.test(id);

export async function listSavedReports() {
  const { rows } = await query(`SELECT ${COLUMNS} FROM "SavedReports" ORDER BY lower("name")`);
  return rows;
}

export async function getSavedReport(id) {
  if (!isSavedReportId(id)) return null;
  return queryOne(`SELECT ${COLUMNS} FROM "SavedReports" WHERE "id" = $1`, [id]);
}

/** Validate name + definition; returns { errors } or { value } ready to store. */
export async function prepareSavedReport(body) {
  const errors = [];
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name) errors.push('A name is required');
  if (name.length > 200) errors.push('The name is too long (max 200 characters)');
  const description = typeof body?.description === 'string' ? body.description.trim().slice(0, 2000) : '';
  const question = typeof body?.question === 'string' ? body.question.trim().slice(0, 2000) : '';
  const result = validateSpec(body?.definition, await loadValues());
  if (!result.ok) errors.push(...result.errors);
  // Store the resolved record id, so a saved comparison survives a rename.
  if (result.ok) {
    const { confirm } = await resolveNamedObjects(result.spec, query);
    if (confirm) errors.push(confirm.message);
  }
  if (errors.length) return { errors };
  return { value: { name, description: description || null, question: question || null, definition: result.spec } };
}

const isUniqueViolation = (err) => err?.code === '23505';

export async function createSavedReport(value, user) {
  const id = randomUUID();
  try {
    return await queryOne(
      `INSERT INTO "SavedReports" ("id", "name", "description", "definition", "question", "createdBy", "updatedBy")
       VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING ${COLUMNS}`,
      [id, value.name, value.description, JSON.stringify(value.definition), value.question, user],
    );
  } catch (err) {
    if (isUniqueViolation(err)) return { conflict: true };
    throw err;
  }
}

export async function updateSavedReport(id, value, user) {
  if (!isSavedReportId(id)) return null;
  try {
    return await queryOne(
      `UPDATE "SavedReports" SET "name" = $2, "description" = $3, "definition" = $4, "question" = $5,
         "updatedBy" = $6, "updatedAt" = now()
       WHERE "id" = $1 RETURNING ${COLUMNS}`,
      [id, value.name, value.description, JSON.stringify(value.definition), value.question, user],
    );
  } catch (err) {
    if (isUniqueViolation(err)) return { conflict: true };
    throw err;
  }
}

export async function deleteSavedReport(id) {
  if (!isSavedReportId(id)) return false;
  const { rowCount } = await query(`DELETE FROM "SavedReports" WHERE "id" = $1`, [id]);
  return rowCount > 0;
}

/** A saved report, shaped as a report template for the registry. */
export function toReportTemplate(row) {
  const { spec } = validateSpec(row.definition);
  let compiled = { columns: [] };
  try {
    if (spec) compiled = compileSpec(spec);
  } catch (err) {
    // An unresolvable definition must not break the whole report list; running it reports the problem.
    console.error(`saved report ${row.id} cannot be compiled:`, err.message);
  }
  return {
    name: `${SAVED_PREFIX}${row.id}`,
    displayName: row.name,
    description: row.description || '',
    form: 'list',
    parametersSchema: { type: 'object', required: [], properties: {} },
    columns: compiled.columns.map(({ key, label }) => ({ key, label })),
    source: 'custom',
    author: {
      createdBy: row.createdBy || null,
      updatedBy: row.updatedBy || null,
      updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt || null,
    },
    editable: { builderId: row.id },
    async run() {
      const result = await runSpec(row.definition);
      if (!result.ok) throw new Error(`saved report ${row.id} no longer validates: ${result.errors.join('; ')}`);
      return { rows: result.rows, truncated: result.truncated === true };
    },
  };
}

registerReportSource({
  async list() {
    if (!(await isFeatureEnabled('customReports'))) return [];
    return (await listSavedReports()).map(toReportTemplate);
  },
  async get(name) {
    if (!name.startsWith(SAVED_PREFIX)) return null;
    if (!(await isFeatureEnabled('customReports'))) return null;
    const row = await getSavedReport(name.slice(SAVED_PREFIX.length));
    return row ? toReportTemplate(row) : null;
  },
});
