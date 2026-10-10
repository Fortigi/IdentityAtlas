// Organisation truth — the proposed recipe for the activity, enrichment and
// relation templates (collection is heuristic.js / the model). Pure.
//
//   templateProposal(kind, { fileName, columns, probes, picks, hasIdentities })
//     → { recipe, linkRules, notes }   recipe normalised when it validates
//
// `picks` are template.js's choices. When the analyst forced a kind the data did
// not suggest, picks may be missing: the free columns stand in, in file order, and a
// note names what to check — the recipe then has the right shape for the wizard to
// edit, even when it does not validate yet.
import { validateRecipe, normalizeRecipe, normalizeLinkRules } from '../contracts.js';
import { referenceRule, relationLinkRules } from '../referenceRules.js';
import { camelCase, typeFromFileName, uniqueName } from './names.js';
import { isMonthColumn, isYearColumn, isDateColumn, isMeasureColumn, namesPeople } from './template.js';

const MEASURE_UNITS = [[/uren|uur|hours?|hrs/i, 'h'], [/bedrag|amount|eur|€/i, 'EUR'], [/dagen|days?/i, 'd']];
const MULTI_SEPARATOR = /[;,|\n]/;

const typeName = (fileName, fallback) => {
  const t = typeFromFileName(fileName);
  return t === 'Item' ? fallback : t;
};

function attributesOf(cols, used, taken = new Set(['displayName'])) {
  return cols.filter(c => !used.has(c) && c.nonEmpty > 0)
    .map(c => ({ column: c.name, name: uniqueName(camelCase(c.name) || `column${c.index + 1}`, taken) }));
}

// The probe's view of what a column names, as a target.
function targetOf(c, probes) {
  const p = probes?.[c?.name];
  if (!p) return { targetType: 'Resource' };
  if (p.orgEntities >= p.resources && p.orgEntities >= p.people && p.orgEntities > 0) {
    return { targetType: 'OrgEntity', ...(p.orgEntityTypes[0] ? { targetEntityType: p.orgEntityTypes[0] } : {}) };
  }
  if (p.people > p.resources) return { targetType: 'Principal' };
  return { targetType: 'Resource' };
}

function finish(recipe, linkRules, notes, columns) {
  const check = validateRecipe(recipe, columns.map(c => c.name));
  if (!check.ok) return { recipe, linkRules, notes: [...notes, ...check.errors.slice(0, 3)] };
  const normal = normalizeRecipe(recipe);
  return { recipe: normal, linkRules: normal.template === 'relation' ? relationLinkRules(normal) : normalizeLinkRules(linkRules), notes };
}

// ─── activity ────────────────────────────────────────────────────────────
function timeFallback(cols) {
  const date = cols.find(isDateColumn);
  if (date) return { dateColumn: date.name, used: [date] };
  const year = cols.find(isYearColumn) ?? cols[0];
  const month = cols.find(isMonthColumn) ?? cols.find(c => c !== year) ?? year;
  return { yearColumn: year.name, monthColumn: month.name, used: [year, month] };
}

const unitOf = (header) => MEASURE_UNITS.find(([re]) => re.test(header))?.[1];

function activityProposal({ fileName, columns: cols, probes, picks }) {
  const notes = [];
  const time = picks.time ?? timeFallback(cols);
  const measure = picks.measure ?? cols.find(isMeasureColumn);
  const used = new Set([...time.used, measure].filter(Boolean));
  const actor = picks.actor ?? cols.find(c => !used.has(c) && namesPeople(c, probes)) ?? cols.find(c => !used.has(c)) ?? cols[0];
  used.add(actor);
  const subject = picks.subject ?? cols.find(c => !used.has(c) && c.shape === 'text') ?? cols.find(c => !used.has(c)) ?? actor;
  used.add(subject);
  if (!picks.subject) notes.push('Check the actor, subject and date columns: the data did not point them out clearly.');
  const subjectTarget = targetOf(subject, probes);
  const unit = measure ? unitOf(measure.name) : undefined;
  const recipe = {
    version: 1, template: 'activity',
    activity: {
      type: typeName(fileName, 'Activity'),
      actor: { column: actor.name, targetTypes: ['Principal', 'Identity'] },
      subject: { column: subject.name, ...(subjectTarget.targetType === 'Principal' ? { targetType: 'Resource' } : subjectTarget) },
      when: time.dateColumn ? { dateColumn: time.dateColumn } : { yearColumn: time.yearColumn, monthColumn: time.monthColumn },
      ...(measure ? { measure: { column: measure.name, ...(unit ? { unit } : {}) } } : {}),
      attributes: attributesOf(cols, used),
    },
  };
  notes.push(`Each row is one ${recipe.activity.type} of ${actor.name} on ${subject.name}; every distinct value is matched once and can be reviewed under Activity references.`);
  return finish(recipe, [], notes, cols);
}

// ─── enrichment ──────────────────────────────────────────────────────────
const isMultiValued = (c) => c.shape === 'text' && (c.samples ?? []).filter(s => MULTI_SEPARATOR.test(String(s))).length * 2 >= Math.max(1, (c.samples ?? []).length);

function enrichTargetType(targetKind, hasIdentities) {
  if (targetKind === 'resource') return 'Resource';
  return hasIdentities ? 'Identity' : 'Principal';
}

function enrichmentProposal({ fileName, columns: cols, probes, picks, hasIdentities }) {
  const key = picks.key ?? cols.find(c => namesPeople(c, probes)) ?? cols[0];
  const email = cols.find(c => c !== key && c.shape === 'email' && c.uniqueness >= 0.9);
  const targetType = enrichTargetType(picks.targetKind, hasIdentities);
  const type = typeName(fileName, 'Enrichment');
  const attributes = attributesOf(cols, new Set([key])).map(a => {
    const c = cols.find(x => x.name === a.column);
    return isMultiValued(c) ? { ...a, multi: true } : a;
  });
  const rule = referenceRule({ entityType: type, via: 'displayName', targetType });
  const emailAttr = email ? attributes.find(a => a.column === email.name)?.name : null;
  if (emailAttr && targetType !== 'Resource') rule.signals.push({ name: `${emailAttr} email exact`, attribute: emailAttr, targetField: 'email', type: 'exact', weight: 95 });
  const recipe = {
    version: 1, template: 'enrichment', enrich: { targetType },
    entities: [{ type, nameColumn: key.name, keyColumn: (email ?? key).name, attributes }], relations: [],
  };
  const multi = attributes.filter(a => a.multi).map(a => a.name);
  const notes = [`Every row adds information to the ${targetType} named in ${key.name}${emailAttr ? ` (or with the address in ${email.name})` : ''}.`];
  if (multi.length > 0) notes.push(`${multi.join(', ')} hold several values per cell; each value is kept, so you can filter on any of them.`);
  return finish(recipe, [rule], notes, cols);
}

// ─── relation ────────────────────────────────────────────────────────────
function relationProposal({ fileName, columns: cols, probes, picks }) {
  const left = picks.left ?? cols[0];
  const right = picks.right ?? cols.find(c => c !== left) ?? left;
  const recipe = {
    version: 1, template: 'relation',
    relation: {
      type: typeName(fileName, 'Relation'), predicate: 'relatedTo',
      left: { column: left.name, ...targetOf(left, probes) },
      right: { column: right.name, ...targetOf(right, probes) },
      attributes: attributesOf(cols, new Set([left, right]), new Set(['displayName', 'left', 'right'])),
    },
  };
  const notes = [`Every row pairs the ${recipe.relation.left.targetType} in ${left.name} with the ${recipe.relation.right.targetType} in ${right.name}; rename the relation and its predicate to say what the pair means.`];
  return finish(recipe, [], notes, cols);
}

const BUILDERS = { activity: activityProposal, enrichment: enrichmentProposal, relation: relationProposal };

export function templateProposal(kind, input) {
  return BUILDERS[kind]({ ...input, picks: input.picks ?? {} });
}
