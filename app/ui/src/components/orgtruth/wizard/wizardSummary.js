// Organisation → Import wizard: what step 7 shows (PURE).
//
//   confirmRows(draft)   the [label, value] rows of the summary above Start import
//   runSummary(stats)    the sentence a completed run reads as
//
// Run stats per template (POST /runs → GET /runs/:id `stats`):
//   collection / enrichment / relation: { rows, entities: { byType }, links: { linked, proposed, none } }
//   activity: { rows, activities, keys: { actor: { total, accepted, proposed, unmatched }, subject: {…} }, skipped }
import { ruleTitle } from './wizardDraft';
import { KEY_ROLES, TEMPLATE_CARDS, keyCountLine, templateOf, whenMode } from './templateDraft';

const list = (items, empty = '—') => items.filter(Boolean).join(', ') || empty;
const targetLabel = (end) => (end.targetType === 'OrgEntity' ? end.targetEntityType : end.targetType);

function whenLine(when) {
  return whenMode(when) === 'date' ? `date in ${when.dateColumn}` : `year in ${when.yearColumn}, month in ${when.monthColumn}`;
}

function activityRows(a) {
  return [
    ['Activity', `${a.type}: ${a.actor.column} on ${a.subject.column} (${targetLabel(a.subject)})`],
    ['When', whenLine(a.when ?? {})],
    ['Measure', a.measure?.column ? `${a.measure.column}${a.measure.unit ? ` (${a.measure.unit})` : ''}` : 'none'],
  ];
}

function relationRows(r) {
  return [['Relation', `${r.type}: ${r.left.column} (${targetLabel(r.left)}) ${r.predicate} ${r.right.column} (${targetLabel(r.right)})`]];
}

const linkRuleRow = (draft) => ['Link rules', list(draft.linkRules.map(r => `${r.entityType}: ${ruleTitle(r)} (${r.signals.length} signals)`), 'none')];

function enrichmentRows(draft) {
  const e = draft.recipe.entities[0] ?? {};
  const attrs = (e.attributes ?? []).map(a => `${a.name || a.column}${a.multi ? ' (multiple values)' : ''}`);
  return [
    ['Adds to', `${draft.recipe.enrich?.targetType} by ${e.nameColumn} (${e.type})`],
    ['Attributes', list(attrs)],
    linkRuleRow(draft),
  ];
}

function collectionRows(draft) {
  return [
    ['Entities', list(draft.recipe.entities.map(e => e.type))],
    ['Relations', list(draft.recipe.relations.map(r => `${r.from} ${r.predicate} ${r.to}`))],
    linkRuleRow(draft),
  ];
}

const ROWS = { collection: collectionRows, enrichment: enrichmentRows, activity: d => activityRows(d.recipe.activity), relation: d => relationRows(d.recipe.relation) };

export function confirmRows(draft) {
  const kind = templateOf(draft.recipe);
  return [
    ['Source', `${draft.source?.displayName ?? '—'} (${draft.source?.rowCount ?? '—'} rows)`],
    ['Mode', draft.runMode === 'full' ? 'Full: closes what the list no longer contains' : 'Delta: changes only what is in the list'],
    ['Kind', TEMPLATE_CARDS[kind].label],
    ...ROWS[kind](draft),
  ];
}

function activityParts(stats) {
  const parts = [`${stats.activities ?? 0} activities`];
  for (const role of KEY_ROLES) if (stats.keys?.[role]) parts.push(keyCountLine(role, stats.keys[role]));
  if (stats.skipped > 0) parts.push(`${stats.skipped} rows skipped`);
  return parts;
}

function entityParts(stats) {
  const parts = [];
  const byType = Object.entries(stats.entities?.byType ?? {});
  if (byType.length > 0) parts.push(byType.map(([t, n]) => `${n} ${t}`).join(', '));
  const links = stats.links ?? {};
  if (links.linked != null) parts.push(`${links.linked} linked, ${links.proposed ?? 0} proposed for review, ${links.none ?? 0} without a match`);
  return parts;
}

// "Import completed: 3 rows; 3 Project, 2 Owner; 2 linked, 0 proposed for review, 0 without a match."
// An activity run (its stats carry `keys`) reads its activities and key match counts instead.
export function runSummary(stats = {}) {
  const parts = stats.keys ? activityParts(stats) : entityParts(stats);
  return [`Import completed: ${stats.rows ?? 0} rows`, ...parts].join('; ') + '.';
}
