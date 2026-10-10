// Organisation → Import wizard: the four import templates (PURE).
//
// One import is one of four fixed kinds of list (T10). `recipe.template`
// selects the recipe's shape; a recipe without it is a collection, so every
// profile stored before templates existed keeps working.
//   collection   today's recipe: entities[], relations[], link rules
//   enrichment   ONE entity def + enrich: { targetType }; attributes may be multi
//   activity     activity: { type, actor, subject, when, measure?, attributes }
//   relation     relation: { type, predicate, left, right, attributes }
// The shapes are the contract in app/api/src/orgtruth/contracts.js; the API
// validates again on every write.
//
// This file holds what the template steps need and nothing React: the kinds
// and their card text, the defaults a template starts from, the edits to the
// activity / relation / enrich sections, the readiness sentences per template
// and the recipe the API receives for the three new templates. wizardDraft.js
// keeps the draft and the collection recipe and dispatches here.
//
// Decisions made here (not spelled out in the contract):
//   - A subject or relation end that points at a collection is stored as
//     targetType 'OrgEntity' + targetEntityType; the selects encode it as
//     'OrgEntity:<type>' so one control picks both.
//   - An activity's measure is sent only when its column is set; a unit
//     without a column is dropped with it.
//   - Attribute rows without a column are dropped; a blank name is omitted
//     (the API names the attribute after its column).

export const TEMPLATE_KINDS = ['collection', 'enrichment', 'activity', 'relation'];
export const DEFAULT_TEMPLATE = 'collection';

export const TEMPLATE_CARDS = Object.freeze({
  collection: { label: 'Collection', description: 'a customer, project or asset that people and resources belong to' },
  enrichment: { label: 'Enrichment', description: 'extra information about people, accounts or resources' },
  activity: { label: 'Activity', description: 'who did what, on what, when: timesheets, logs' },
  relation: { label: 'Relation', description: 'pairs between things, e.g. incompatible authorisations' },
});

export const ENRICH_TARGETS = ['Identity', 'Principal', 'Resource'];
export const END_TARGETS = ['Resource', 'Principal', 'Identity'];
export const ACTOR_TARGETS = ['Principal', 'Identity'];

const trimmed = (v) => (typeof v === 'string' ? v.trim() : '');
const replaceAt = (list, i, item) => list.map((x, idx) => (idx === i ? item : x));
const withoutAt = (list, i) => list.filter((_, idx) => idx !== i);

export const templateOf = (recipe) => (TEMPLATE_KINDS.includes(recipe?.template) ? recipe.template : DEFAULT_TEMPLATE);
export const linksTemplate = (kind) => kind === 'collection' || kind === 'enrichment';

// ─── Defaults ────────────────────────────────────────────────────────────
const emptyEnd = (targetType) => ({ column: '', targetType });
const emptyActivity = () => ({
  type: '', actor: { column: '', targetTypes: [...ACTOR_TARGETS] }, subject: emptyEnd('Resource'),
  when: { dateColumn: '' }, measure: { column: '', unit: '' }, attributes: [],
});
const emptyRelation = () => ({ type: '', predicate: '', left: emptyEnd('Resource'), right: emptyEnd('Resource'), attributes: [] });
const emptyEntity = () => ({ type: '', nameColumn: '', keyColumn: '', nameAttribute: '', attributes: [] });

// The sections a recipe of `kind` needs, filled with defaults where the
// proposal or the stored profile left them out, so the editors never read
// through an undefined part.
export function withTemplateDefaults(recipe, kind = templateOf(recipe)) {
  const base = { version: 1, entities: [], relations: [], ...recipe };
  if (kind === 'collection') {
    delete base.template;
    return base;
  }
  const out = { ...base, template: kind };
  if (kind === 'enrichment') {
    out.entities = base.entities.length ? base.entities : [emptyEntity()];
    out.enrich = { targetType: ENRICH_TARGETS[0], ...base.enrich };
  } else if (kind === 'activity') {
    out.activity = activityDefaults(base.activity ?? {});
  } else {
    out.relation = relationDefaults(base.relation ?? {});
  }
  return out;
}

function activityDefaults(a) {
  const d = emptyActivity();
  return {
    ...d, ...a,
    actor: { ...d.actor, ...a.actor }, subject: { ...d.subject, ...a.subject },
    when: a.when ?? d.when, measure: { ...d.measure, ...a.measure }, attributes: a.attributes ?? [],
  };
}

function relationDefaults(r) {
  const d = emptyRelation();
  return { ...d, ...r, left: { ...d.left, ...r.left }, right: { ...d.right, ...r.right }, attributes: r.attributes ?? [] };
}

export const emptyTemplateRecipe = (kind) => withTemplateDefaults({}, kind);

// ─── Section edits (recipe → recipe) ─────────────────────────────────────
export const patchSection = (recipe, section, patch) => ({ ...recipe, [section]: { ...recipe[section], ...patch } });
export const patchPart = (recipe, section, part, patch) =>
  patchSection(recipe, section, { [part]: { ...recipe[section][part], ...patch } });

// 'date' (one date column) or 'yearMonth' (a year and a month column).
export const whenMode = (when) => (when && ('yearColumn' in when || 'monthColumn' in when) ? 'yearMonth' : 'date');
export function setWhenMode(recipe, mode) {
  if (whenMode(recipe.activity.when) === mode) return recipe;
  return patchSection(recipe, 'activity', { when: mode === 'yearMonth' ? { yearColumn: '', monthColumn: '' } : { dateColumn: '' } });
}

const sectionAttributes = (recipe, section) => recipe[section].attributes ?? [];
export const addSectionAttribute = (recipe, section) =>
  patchSection(recipe, section, { attributes: [...sectionAttributes(recipe, section), { column: '', name: '' }] });
export function updateSectionAttribute(recipe, section, j, patch) {
  const list = sectionAttributes(recipe, section);
  return list[j] ? patchSection(recipe, section, { attributes: replaceAt(list, j, { ...list[j], ...patch }) }) : recipe;
}
export const removeSectionAttribute = (recipe, section, j) =>
  patchSection(recipe, section, { attributes: withoutAt(sectionAttributes(recipe, section), j) });

// ─── Targets: 'Resource' | 'Principal' | 'Identity' | 'OrgEntity:<type>' ─
export function targetValue(end) {
  if (end?.targetType !== 'OrgEntity') return end?.targetType ?? '';
  return end.targetEntityType ? `OrgEntity:${end.targetEntityType}` : '';
}

export function parseTarget(value) {
  if (typeof value === 'string' && value.startsWith('OrgEntity:')) return { targetType: 'OrgEntity', targetEntityType: value.slice('OrgEntity:'.length) };
  return { targetType: value };
}

// Replaces the end's target (a collection's type goes when Resource is picked)
// and keeps its column.
export const setTarget = (recipe, section, part, value) =>
  patchSection(recipe, section, { [part]: { column: recipe[section][part].column, ...parseTarget(value) } });

// GET /model → the collection types an activity or relation can point at:
// entity types whose template is collection (a type without one predates
// templates and is a collection).
export function collectionTypes(model) {
  return (model?.entityTypes ?? [])
    .filter(t => (t.template ?? DEFAULT_TEMPLATE) === DEFAULT_TEMPLATE && trimmed(t.type))
    .map(t => t.type);
}

// The options of a target select: the fixed system types, then every
// collection type (plus the one already chosen, when /model did not list it).
export function targetOptions(base, collections, current) {
  const types = [...collections];
  if (current?.targetType === 'OrgEntity' && current.targetEntityType && !types.includes(current.targetEntityType)) types.push(current.targetEntityType);
  return [
    ...base.map(t => ({ value: t, label: t })),
    ...types.map(t => ({ value: `OrgEntity:${t}`, label: `${t} (collection)` })),
  ];
}

// ─── Readiness ───────────────────────────────────────────────────────────
function endProblems(end, label, problems) {
  if (!trimmed(end.column)) problems.push(`Choose the ${label} column.`);
  if (!trimmed(targetValue(end))) problems.push(`Choose what the ${label} column refers to.`);
}

export function activityProblems(a) {
  const problems = [];
  if (!trimmed(a.type)) problems.push('Name the activity, e.g. Hours.');
  if (!trimmed(a.actor.column)) problems.push('Choose the actor column.');
  endProblems(a.subject, 'subject', problems);
  const w = a.when ?? {};
  const dated = whenMode(w) === 'date' ? trimmed(w.dateColumn) : trimmed(w.yearColumn) && trimmed(w.monthColumn);
  if (!dated) problems.push('Choose when each row happened: a date column, or a year and a month column.');
  return problems;
}

export function relationProblems(r) {
  const problems = [];
  if (!trimmed(r.type)) problems.push('Name the relation, e.g. Incompatibility.');
  if (!trimmed(r.predicate)) problems.push('Say how the left side relates to the right, e.g. incompatibleWith.');
  endProblems(r.left, 'left', problems);
  endProblems(r.right, 'right', problems);
  return problems;
}

export function enrichmentProblems(recipe) {
  const problems = [];
  const [entity] = recipe.entities;
  if (recipe.entities.length !== 1) problems.push('An enrichment describes exactly one list.');
  if (!ENRICH_TARGETS.includes(recipe.enrich?.targetType)) problems.push('Choose what the list adds information to.');
  if (!trimmed(entity?.type)) problems.push('Name the list, e.g. Expertise.');
  if (!trimmed(entity?.nameColumn)) problems.push('Choose the key column: the values that identify who or what each row is about.');
  return problems;
}

// Every column a non-collection recipe refers to (for the stale-column check).
export function sectionColumns(recipe) {
  const kind = templateOf(recipe);
  const attrs = (list) => (list ?? []).map(x => x.column);
  if (kind === 'activity') {
    const a = recipe.activity;
    return [a.actor.column, a.subject.column, ...Object.values(a.when ?? {}), a.measure?.column, ...attrs(a.attributes)];
  }
  if (kind === 'relation') return [recipe.relation.left.column, recipe.relation.right.column, ...attrs(recipe.relation.attributes)];
  return [];
}

// ─── What the API receives ───────────────────────────────────────────────
export const attributesForApi = (list) => (list ?? []).filter(a => trimmed(a.column)).map(a => {
  const out = { column: a.column };
  if (trimmed(a.name)) out.name = trimmed(a.name);
  if (a.multi === true) out.multi = true;
  return out;
});

function endForApi(end) {
  const out = { column: end.column, targetType: end.targetType };
  if (end.targetType === 'OrgEntity') out.targetEntityType = end.targetEntityType;
  return out;
}

function whenForApi(when) {
  return whenMode(when) === 'date' ? { dateColumn: when.dateColumn } : { yearColumn: when.yearColumn, monthColumn: when.monthColumn };
}

export function activityForApi(a) {
  const out = {
    type: trimmed(a.type),
    actor: { column: a.actor.column, targetTypes: a.actor.targetTypes?.length ? a.actor.targetTypes : [...ACTOR_TARGETS] },
    subject: endForApi(a.subject),
    when: whenForApi(a.when ?? {}),
  };
  if (trimmed(a.measure?.column)) {
    out.measure = { column: a.measure.column };
    if (trimmed(a.measure.unit)) out.measure.unit = trimmed(a.measure.unit);
  }
  out.attributes = attributesForApi(a.attributes);
  return out;
}

export function relationForApi(r) {
  return {
    type: trimmed(r.type), predicate: trimmed(r.predicate),
    left: endForApi(r.left), right: endForApi(r.right), attributes: attributesForApi(r.attributes),
  };
}

// ─── The activity dry run ────────────────────────────────────────────────
// POST /runs/dry-run on an activity recipe answers
//   { rows, activities, skipped, keys: { actor: { total, accepted, proposed, unmatched }, subject: {…} }, sample: [parsed rows] }.
export const KEY_ROLES = ['actor', 'subject'];
const plural = (n, one, many) => (n === 1 ? one : many);

// Blocks when no row could be read as an activity; warns on skipped rows and
// on values that match nothing yet (they are reviewed after the import).
export function activityFindings(report, blockers, warnings) {
  if (!report?.keys) return;
  if (report.activities === 0) blockers.push('No row could be read as an activity: check the actor, subject and date columns.');
  if (report.skipped > 0) warnings.push(`${report.skipped} ${plural(report.skipped, 'row is', 'rows are')} skipped: no date, actor or subject could be read.`);
  for (const role of KEY_ROLES) {
    const k = report.keys[role];
    if (k?.unmatched > 0) warnings.push(`${k.unmatched} of ${k.total ?? k.unmatched} ${role} values match nothing yet; review them after the import.`);
  }
}

// "12 actors: 9 matched, 2 proposed, 1 without a match".
export function keyCountLine(role, k) {
  const c = { total: 0, accepted: 0, proposed: 0, unmatched: 0, ...k };
  return `${c.total} ${role} ${plural(c.total, 'value', 'values')}: ${c.accepted} matched, ${c.proposed} proposed, ${c.unmatched} without a match`;
}

// The first parsed rows of an activity dry run, for the preview table.
export const PREVIEW_ROWS = 5;
export function previewRows(report) {
  const rows = Array.isArray(report?.sample) ? report.sample : [];
  return rows.slice(0, PREVIEW_ROWS);
}

// "2026-03-01 – 2026-03-31" for a month, "2026-03-04" for a point in time.
export const periodText = (row) => (row.periodEnd ? `${row.occurredOn} – ${row.periodEnd}` : row.occurredOn ?? '');

// ─── The proposal's template block ───────────────────────────────────────
// POST /propose/recipe → template: { kind, confidence, reason, alternatives }.
// Kept only when it names a known kind.
export function proposalTemplate(proposal) {
  const t = proposal?.template;
  return t && TEMPLATE_KINDS.includes(t.kind) ? t : null;
}

// The kind a proposal's recipe has: its recipe's own template, else the
// template block's kind, else a collection.
export function proposedKind(proposal) {
  if (TEMPLATE_KINDS.includes(proposal?.recipe?.template)) return proposal.recipe.template;
  return proposalTemplate(proposal)?.kind ?? DEFAULT_TEMPLATE;
}
