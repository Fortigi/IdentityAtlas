// Organisation truth — which of the four templates a list is (pure).
//
//   chooseTemplate({ columns, probes, rowCount, forced }) →
//     { kind, picks, summary: { kind, confidence, reason, alternatives: [kind…] } }
//
// `columns` is the column profile (import/profileColumns.js), `probes` the data
// probes (probe.js) when the rows were read, else null (then the headers and the
// samples decide). Every template is evaluated; the first that fits, in the order
// activity → relation → enrichment, is proposed, otherwise collection:
//   activity    a date column, or a year column and a month column; a numeric measure
//               column; a column of people (the actor) and another column the rows are
//               about (the subject: best another list's names or resources)
//   relation    exactly two columns that name existing things (people, resources,
//               another list's entities), at most one other column, no date + measure
//   enrichment  one column that names people (or resources) on nearly every row and is
//               unique (one row per person), other columns to add, and no column that
//               lists several people per row (that is a collection's team)
//   collection  anything else: a name column plus member columns
// `forced` (the wizard's override) returns that kind whatever fits. `picks` are the
// columns the evaluation chose, for templateRecipes.js. `alternatives` are the other
// three kinds: the ones that also fit first (most confident first), then the rest.
import { TEMPLATES } from '../templates.js';
import { monthOf } from '../model/evidence.js';
import { isFullNameColumn, isMultiPersonColumn, isRoleColumn } from './heuristic.js';

const SHARE = 0.5;
const KEY_UNIQUE = 0.9;
const YEAR = /^(19|20)\d\d$/;
const MONTH_HEADER = /maand|month/i;
const MEASURE_HEADER = /uren|uur|hours?|hrs|amount|bedrag|aantal|count|qty|quantity|duur|duration/i;

const probeOf = (probes, c) => probes?.[c.name] ?? null;
const samplesOf = (c) => (c.samples ?? []).map(s => String(s ?? '').trim()).filter(Boolean);
const allSamples = (c, test) => samplesOf(c).length > 0 && samplesOf(c).every(test);

export const isYearColumn = (c) => allSamples(c, s => YEAR.test(s));
export const isMonthColumn = (c) => !isYearColumn(c)
  && (c.shape === 'text' || MONTH_HEADER.test(c.name)) && allSamples(c, s => monthOf(s) !== null);
export const isDateColumn = (c) => c.shape === 'date';
export function isMeasureColumn(c) {
  if (c.shape !== 'number' || isYearColumn(c) || isMonthColumn(c)) return false;
  return MEASURE_HEADER.test(c.name) || samplesOf(c).some(s => /[.,]\d/.test(s));
}

/** The column names people: by the probe when there is one, else by its header or e-mail values. */
export function namesPeople(c, probes) {
  const p = probeOf(probes, c);
  if (p) return p.people >= SHARE;
  return c.shape === 'email' || isFullNameColumn(c) || isRoleColumn(c) || isMultiPersonColumn(c);
}
const namesThings = (c, probes) => {
  const p = probeOf(probes, c);
  return !!p && (p.orgEntities >= SHARE || p.resources >= SHARE);
};
const listsSeveral = (c) => isMultiPersonColumn(c) || samplesOf(c).some(s => s.includes(';#'));
const refStrength = (c, probes) => {
  const p = probeOf(probes, c);
  return p ? Math.max(p.people, p.orgEntities, p.resources) : 0;
};
const byStrength = (probes) => (a, b) => refStrength(b, probes) - refStrength(a, probes);

// ─── activity ────────────────────────────────────────────────────────────
function timeOf(cols) {
  const date = cols.find(isDateColumn);
  if (date) return { dateColumn: date.name, used: [date] };
  const year = cols.find(isYearColumn);
  const month = cols.find(isMonthColumn);
  return year && month ? { yearColumn: year.name, monthColumn: month.name, used: [year, month] } : null;
}

function subjectOf(cols, probes, taken) {
  const free = cols.filter(c => !taken.has(c) && ['text', 'number'].includes(c.shape) && !isMeasureColumn(c));
  const things = free.filter(c => namesThings(c, probes)).sort(byStrength(probes));
  if (things.length > 0) return { column: things[0], probed: true };
  const repeating = free.filter(c => c.shape === 'text' && c.distinct < c.nonEmpty && !namesPeople(c, probes));
  return repeating.length > 0 ? { column: repeating[0], probed: false } : null;
}

export function evaluateActivity(cols, probes) {
  const time = timeOf(cols);
  const measure = cols.find(isMeasureColumn);
  const actor = cols.filter(c => c.shape === 'text' && namesPeople(c, probes) && !listsSeveral(c)).sort(byStrength(probes))[0];
  if (!time || !measure || !actor) return { ok: false, picks: { time, measure, actor } };
  const subject = subjectOf(cols, probes, new Set([...time.used, measure, actor]));
  if (!subject) return { ok: false, picks: { time, measure, actor } };
  const when = time.dateColumn ? time.dateColumn : `${time.yearColumn} + ${time.monthColumn}`;
  return {
    ok: true,
    confidence: subject.probed ? 0.9 : 0.7,
    reason: `${when} say when, ${measure.name} is a number per row, ${actor.name} names people and ${subject.column.name} what they worked on: who did how much on what, when.`,
    picks: { time, measure, actor, subject: subject.column },
  };
}

// ─── relation ────────────────────────────────────────────────────────────
export function evaluateRelation(cols, probes) {
  const filled = cols.filter(c => c.nonEmpty > 0);
  const refs = filled.filter(c => !listsSeveral(c) && (namesThings(c, probes) || (probeOf(probes, c) && namesPeople(c, probes))));
  const others = filled.length - refs.length;
  const timed = !!timeOf(cols) && cols.some(isMeasureColumn);
  // Two columns unique on every row are one thing named twice (a person's name and
  // address), not pairs: in a list of pairs an end repeats.
  const sameThing = refs.length === 2 && refs.every(c => c.uniqueness >= KEY_UNIQUE);
  if (refs.length !== 2 || others > 1 || timed || sameThing) return { ok: false, picks: { left: refs[0], right: refs[1] } };
  return {
    ok: true, confidence: 0.8,
    reason: `${refs[0].name} and ${refs[1].name} both name things that already exist, and little else is on a row: every row is a pair.`,
    picks: { left: refs[0], right: refs[1] },
  };
}

// ─── enrichment ──────────────────────────────────────────────────────────
function enrichKey(cols, probes, rowCount) {
  // a cell listing several people (a team) never identifies one person, however unique the cells are
  const unique = (c) => c.uniqueness >= KEY_UNIQUE && c.nonEmpty >= KEY_UNIQUE * rowCount && !listsSeveral(c);
  const people = cols.filter(c => unique(c) && namesPeople(c, probes)).sort(byStrength(probes));
  if (people.length > 0) return { column: people.find(c => c.shape !== 'email') ?? people[0], targetKind: 'person' };
  const resources = cols.filter(c => unique(c) && (probeOf(probes, c)?.resources ?? 0) >= SHARE);
  return resources.length > 0 ? { column: resources[0], targetKind: 'resource' } : null;
}

export function evaluateEnrichment(cols, probes, rowCount) {
  const key = enrichKey(cols, probes, rowCount);
  const blocked = cols.some(c => c !== key?.column && listsSeveral(c) && namesPeople(c, probes));
  const rest = cols.filter(c => c !== key?.column && c.shape !== 'email' && c.nonEmpty > 0);
  if (!key || blocked || rest.length === 0) return { ok: false, picks: { key: key?.column, targetKind: key?.targetKind ?? 'person' } };
  return {
    ok: true,
    confidence: probes ? 0.85 : 0.6,
    reason: `${key.column.name} names a different ${key.targetKind} on every row and no column lists several people, so the list adds information to ${key.targetKind === 'person' ? 'people' : 'resources'} that already exist.`,
    picks: { key: key.column, targetKind: key.targetKind },
  };
}

// ─── choice ──────────────────────────────────────────────────────────────
const COLLECTION_REASON = 'Each row is a thing of its own (a customer, project or asset) that people and resources belong to.';

export function evaluateAll(columns, probes, rowCount) {
  const rows = Number.isFinite(rowCount) ? rowCount : Math.max(0, ...columns.map(c => c.nonEmpty ?? 0));
  return {
    activity: evaluateActivity(columns, probes),
    relation: evaluateRelation(columns, probes),
    enrichment: evaluateEnrichment(columns, probes, rows),
    collection: { ok: true, confidence: 0.5, reason: COLLECTION_REASON, picks: {} },
  };
}

function alternativesOf(kind, evals) {
  const rest = TEMPLATES.filter(k => k !== kind);
  const fits = rest.filter(k => evals[k].ok).sort((a, b) => evals[b].confidence - evals[a].confidence);
  return [...fits, ...rest.filter(k => !evals[k].ok)];
}

export function chooseTemplate({ columns, probes = null, rowCount, forced = null }) {
  const evals = evaluateAll(columns, probes, rowCount);
  const detected = ['activity', 'relation', 'enrichment'].find(k => evals[k].ok) ?? 'collection';
  const kind = TEMPLATES.includes(forced) ? forced : detected;
  const e = evals[kind];
  const reason = e.ok ? e.reason : `You chose ${kind}; the data did not suggest it, so check the proposed columns.`;
  return {
    kind,
    picks: e.picks,
    summary: { kind, confidence: e.ok ? e.confidence : 0, reason, alternatives: alternativesOf(kind, evals) },
  };
}
