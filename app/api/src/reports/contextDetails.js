// The Entitlement Pivot's first tab: everything known about the contexts a run
// covers, one block per context.
//
// A review pack is mailed to people who cannot open the context page, so the
// workbook says what that page says: every attribute the page lists under "More
// details" (the context's own columns and every key its source stored in
// extendedAttributes), and the people who answer for it — the Accountable and the
// Responsibles, or, when nobody is Accountable yet, the suggestion the page makes
// and why (contexts/roleSuggestion.js; a rejected person is never suggested).
// There is no suggestion for a Responsible anywhere in the product, so none is
// made up here.
//
// Set-based: one read of the contexts and one of their roles whatever the
// number of contexts. Only the suggestion runs per context — it is the same call
// the context page makes — and only for contexts that have no Accountable, at
// most MAX_SUGGESTIONS of them.

import * as db from '../db/connection.js';
import { suggestAccountable } from '../contexts/roleSuggestion.js';
import { ROLE_BEARING_CATEGORIES } from '../lib/contextCategories.js';

// Excel's limit for the text of one cell.
export const MAX_CELL_TEXT = 32767;

// A run over many contexts asks for at most this many suggestions: each is two
// reads, and a review of hundreds of contexts at once is not what it is for.
export const MAX_SUGGESTIONS = 20;

// The context's columns left out of its block: internal bookkeeping (temporal
// columns, ids that only point at something shown by name) and what the block
// shows in its own rows.
const HIDDEN = new Set([
  'SysStartTime', 'SysEndTime', 'ValidFrom', 'ValidTo',
  'parentContextId', 'scopeSystemId', 'sourceAlgorithmId', 'sourceRunId',
  'extendedAttributes',
]);

// Labels that read better than the split column name — the same words the
// context page uses.
const LABELS = {
  id: 'Id',
  displayName: 'Name',
  scopeSystemName: 'Source system',
  sourceAlgorithmName: 'Derived by rule',
  parentDisplayName: 'Parent',
  ownerUserId: 'Owner (as the source names it)',
  lastCalculatedAt: 'Last updated',
};

/** A column name as a heading: "lastSyncedAt" → "Last Synced At". */
export function detailLabel(key) {
  if (Object.hasOwn(LABELS, key)) return LABELS[key];
  return String(key).replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim();
}

/**
 * One stored value as a cell: numbers and booleans typed, a date as its ISO
 * text, anything nested as its JSON, and no text longer than a cell holds.
 */
export function cellValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  let text;
  if (value instanceof Date) text = value.toISOString();
  else if (typeof value === 'object') text = JSON.stringify(value);
  else text = String(value);
  if (text.trim() === '') return null;
  return text.length > MAX_CELL_TEXT ? text.slice(0, MAX_CELL_TEXT) : text;
}

const isEmpty = value => value === null || value === undefined || value === '';

/** The context's own columns, then every extendedAttributes key, as label/value entries. */
export function attributeEntries(row) {
  const core = Object.entries(row)
    .filter(([key, value]) => !HIDDEN.has(key) && !isEmpty(value))
    .map(([key, value]) => ({ label: detailLabel(key), value: cellValue(value) }));
  const ext = row.extendedAttributes && typeof row.extendedAttributes === 'object' ? row.extendedAttributes : {};
  const extended = Object.keys(ext)
    .filter(key => !isEmpty(ext[key]))
    .sort((a, b) => a.localeCompare(b))
    .map(key => ({ label: key, value: cellValue(ext[key]) }));
  return [...core, ...extended];
}

/** A person as one cell: "Name · employee ID · e-mail", leaving out what is not known. */
export function personText({ displayName, employeeId, email }) {
  return [displayName, employeeId, email].filter(v => !isEmpty(v)).join(' · ') || null;
}

/** The people block: Accountable (or the suggestion), then every Responsible. */
export function peopleEntries(roles, suggestion) {
  const accountable = roles.find(r => r.role === 'Accountable');
  const entries = [{ label: 'Accountable', value: accountable ? personText(accountable) : null }];
  if (!accountable && suggestion) {
    entries.push({ label: 'Suggested Accountable', value: `${suggestion.displayName} · ${suggestion.reason}` });
  }
  const responsible = roles.filter(r => r.role === 'Responsible');
  for (const r of responsible) entries.push({ label: 'Responsible', value: personText(r) });
  if (!responsible.length) entries.push({ label: 'Responsible', value: null });
  return entries;
}

/** One context's block. */
export function detailBlock(row, roles = [], suggestion = null) {
  return {
    title: `Context: ${row.displayName}`,
    entries: [...peopleEntries(roles, suggestion), ...attributeEntries(row)],
  };
}

async function fetchRows(ids) {
  const { rows } = await db.query(
    `SELECT c.*, s."displayName" AS "scopeSystemName", a.name AS "sourceAlgorithmName",
            parent."displayName" AS "parentDisplayName"
       FROM "Contexts" c
       LEFT JOIN "Systems" s           ON s.id = c."scopeSystemId"
       LEFT JOIN "ContextAlgorithms" a ON a.id = c."sourceAlgorithmId"
       LEFT JOIN "Contexts" parent     ON parent.id = c."parentContextId"
      WHERE c.id = ANY($1::uuid[])
      ORDER BY c."displayName", c.id`, [ids]);
  return rows;
}

// Every role of every context, with the holder's employee ID and e-mail —
// an account (Principals) or a person (Identities), exactly one.
async function fetchRoles(ids) {
  const { rows } = await db.query(
    `SELECT r."contextId", r.role,
            COALESCE(p."displayName", i."displayName") AS "displayName",
            COALESCE(p."employeeId", i."employeeId")   AS "employeeId",
            COALESCE(p.email, i.email)                 AS email
       FROM "ContextRoles" r
       LEFT JOIN "Principals" p ON p.id = r."principalId"
       LEFT JOIN "Identities" i ON i.id = r."identityId"
      WHERE r."contextId" = ANY($1::uuid[])
      ORDER BY r."contextId", (r.role = 'Accountable') DESC, "displayName"`, [ids]);
  const byContext = new Map();
  for (const row of rows) {
    if (!byContext.has(row.contextId)) byContext.set(row.contextId, []);
    byContext.get(row.contextId).push(row);
  }
  return byContext;
}

/** Whether the context page would offer a suggestion: a role-bearing context with no Accountable. */
export const wantsSuggestion = (row, roles) => ROLE_BEARING_CATEGORIES.has(row.contextCategory)
  && !roles.some(r => r.role === 'Accountable');

/**
 * The detail blocks of `contexts` ([{ id }]), in name order, plus a notice when
 * suggestions were left out for being too many.
 */
export async function fetchContextDetails(contexts) {
  const ids = contexts.map(c => c.id);
  if (!ids.length) return { details: [], notices: [] };
  const [rows, roles] = await Promise.all([fetchRows(ids), fetchRoles(ids)]);
  const asking = rows.filter(row => wantsSuggestion(row, roles.get(row.id) || []));
  const suggested = asking.slice(0, MAX_SUGGESTIONS);
  const suggestions = new Map(await Promise.all(
    suggested.map(async row => [row.id, await suggestAccountable(row)]),
  ));
  const notices = asking.length > suggested.length
    ? [{
      severity: 'info',
      text: `${asking.length} contexts have no Accountable; a suggestion is shown for the first ${MAX_SUGGESTIONS} only.`,
    }]
    : [];
  return {
    details: rows.map(row => detailBlock(row, roles.get(row.id) || [], suggestions.get(row.id) || null)),
    notices,
  };
}
