// Save and reopen a workbench investigation (M2a) — the pure part: what is sent
// when the analyst saves, how a saved investigation becomes the view and the draft
// again, whether there are unsaved changes, and how much the access data changed
// since it was saved. API: /api/contexts/:id/workbench/investigations,
// /api/workbench/investigations/:id. Design: docs/architecture/m1-discovery-and-design.md.

import { columnByKey } from './workbench.columns';

const ACCESS_TYPES = new Set(['Direct', 'Indirect', 'Eligible']);
const VIEW_KEYS = ['columns', 'filters', 'sort', 'includeChildren', 'minHolders', 'columnSearch', 'groupBy'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const splitKey = (k) => { const i = k.lastIndexOf('|'); return [k.slice(0, i), k.slice(i + 1)]; };
const sorted = (iterable) => [...iterable].sort();

// Filters as they can be saved: a filter's ticked values (a Set) become a sorted list.
function filtersToSave(src) {
  const filters = {};
  for (const [key, f] of Object.entries(src || {})) {
    if (f && f.values) filters[key] = { ...f, values: sorted(f.values) };
  }
  return filters;
}

// Saved filters back: values a Set again, a filter on a column the workbench no longer has dropped.
function filtersFromSaved(src) {
  const filters = {};
  for (const [key, f] of Object.entries(src || {})) {
    if (columnByKey.has(key) && f && Array.isArray(f.values)) filters[key] = { ...f, values: new Set(f.values) };
  }
  return filters;
}

/** The view as it can be saved: a filter's ticked values (a Set) become a sorted list. Pure. */
export function viewToSave(view) {
  const filters = filtersToSave(view.filters);
  const out = Object.fromEntries(VIEW_KEYS.filter(k => view[k] !== undefined).map(k => [k, view[k]]));
  return { ...out, filters };
}

/**
 * A saved view over the default one: only columns the workbench still has, a
 * filter's values a Set again, a filter on a column it no longer has dropped. Pure.
 */
export function viewFromSaved(saved, defaults) {
  const src = saved && typeof saved === 'object' ? saved : {};
  const view = { ...defaults };
  for (const k of VIEW_KEYS) if (src[k] !== undefined) view[k] = src[k];
  const columns = Array.isArray(src.columns) ? src.columns.filter(k => columnByKey.has(k)) : [];
  view.columns = columns.length ? columns : defaults.columns;
  view.filters = filtersFromSaved(src.filters);
  return view;
}

/** The held cells on screen, as the snapshot stores them: "person|resource|type". Pure. */
export function accessCellsOf(cells) {
  return (cells || []).filter(c => ACCESS_TYPES.has(c.type)).map(c => `${c.person}|${c.resourceId}|${c.type}`);
}

const marksToSave = (marks) => sorted(marks.keys()).map(k => {
  const [person, resourceId] = splitKey(k);
  return { person, resourceId, mark: marks.get(k) };
});

// A proposed role as saved, with how it is assigned (kind, rule, exceptions, policies, approver, why).
const proposalToSave = (d) => ({
  id: d.id, name: d.name, description: d.description || null, baseBusinessRoleId: d.baseBusinessRoleId || null,
  members: sorted(d.members), entitlements: sorted(d.entitlements),
  kind: d.kind ?? null,
  rule: d.rule ? { includeChildren: d.rule.includeChildren !== false, filters: filtersToSave(d.rule.filters) } : null,
  excluded: sorted(d.excluded || []),
  joinerPolicy: d.joinerPolicy ?? 'auto', leaverPolicy: d.leaverPolicy ?? 'remove',
  approver: d.approver ?? null, rationale: d.rationale || null,
});

/**
 * The whole investigation as the API takes it. `expectedUpdatedAt`: the time the
 * saved one was opened or last saved at, so a save over someone else's is refused. Pure.
 */
export function toSavePayload({ view, data, draft, name, expectedUpdatedAt }) {
  const body = {
    view: viewToSave(view),
    accessReadAt: data?.generatedAt ?? null,
    accessCells: accessCellsOf(data?.cells),
    marks: marksToSave(draft.marks),
    proposals: draft.drafts.map(proposalToSave),
  };
  if (name !== undefined) body.name = name;
  if (expectedUpdatedAt) body.expectedUpdatedAt = expectedUpdatedAt;
  return body;
}

/** A saved investigation's marks and proposed roles as the draft holds them. Pure. */
export function draftFromSaved(inv) {
  const marks = new Map((inv.marks || []).map(m => [`${m.person}|${m.resourceId}`, m.mark]));
  const drafts = (inv.proposals || []).map(p => ({
    id: p.id, name: p.name ?? '', description: p.description ?? '', baseBusinessRoleId: p.baseBusinessRoleId ?? null,
    members: new Set(p.members || []), entitlements: new Set(p.entitlements || []),
    kind: p.kind ?? null,
    rule: p.rule ? { includeChildren: p.rule.includeChildren !== false, filters: filtersFromSaved(p.rule.filters) } : null,
    excluded: new Set(p.excluded || []),
    joinerPolicy: p.joinerPolicy ?? 'auto', leaverPolicy: p.leaverPolicy ?? 'remove',
    approver: p.approver ?? null, rationale: p.rationale ?? '',
  }));
  return { marks, drafts };
}

/**
 * What decides whether the work changed since it was saved — the view, the marks
 * and the proposed roles, in a stable order. The selection and which proposed role
 * is open are not saved work. Pure.
 */
export function fingerprint(view, draft) {
  return JSON.stringify({
    view: viewToSave(view),
    marks: marksToSave(draft.marks),
    proposals: draft.drafts.map(d => { const p = proposalToSave(d); return UUID_RE.test(p.id) ? p : { ...p, id: null }; }),
  });
}

/** The save state in words, for the strip. Pure. */
export function statusText({ saved, dirty }) {
  if (!saved) return dirty ? 'Not saved — this work lives in this tab only' : 'Nothing to save yet';
  if (dirty) return `Unsaved changes to “${saved.name}”`;
  return `Saved as “${saved.name}” · ${saved.updatedBy}, ${new Date(saved.updatedAt).toLocaleString()}`;
}

/**
 * How many cells differ between the snapshot saved with the investigation and the
 * access data on screen now: held then and not now, held now and not then, or held
 * with another grant type. Pure.
 */
export function accessChanges(savedCells, cells) {
  const before = new Map((savedCells || []).map(c => { const i = c.lastIndexOf('|'); return [c.slice(0, i), c.slice(i + 1)]; }));
  const now = new Map(accessCellsOf(cells).map(c => { const i = c.lastIndexOf('|'); return [c.slice(0, i), c.slice(i + 1)]; }));
  let n = 0;
  for (const [k, type] of before) if (now.get(k) !== type) n++;
  for (const k of now.keys()) if (!before.has(k)) n++;
  return n;
}

const pad = (n) => String(n).padStart(2, '0');

/** The name a first save of a role suggests: "<unit> — dd-mm-yyyy". Pure. */
export function defaultInvestigationName(unitName, now = new Date()) {
  return `${unitName} — ${pad(now.getDate())}-${pad(now.getMonth() + 1)}-${now.getFullYear()}`;
}
