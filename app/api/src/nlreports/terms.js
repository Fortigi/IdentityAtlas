// Natural-language reports (PROTOTYPE) — the names a question mentions, and where
// they occur in the data.
//
// "Guest accounts from the RDW" names an organisation. The model had no way to know
// where "RDW" lives, so it grabbed the one list of names it is shown — the connected
// systems — and filtered on a system that has nothing to do with RDW: 0 rows, with a
// confident assumption. The data did know: RDW is in the company and email of the
// guests.
//
// So names are looked up in code, the same way named objects are (references.js):
//
//   findTerms()      picks out what is clearly a name: quoted text, all-caps words
//                    ("RDW", "SAP"), capitalised words that do not start a sentence
//   locateTerms()    per name, the searchable fields it occurs in (EXISTS, no rows)
//   termHint()       one line per name for the model — field names only, never data
//   unusedTerms()    names found in the data that the definition does not use
//   termConfirmation()  the analyst's choice when the model still ignored a name
//
// The model never sees a row or a count: only "this name occurs in user.companyName".

import { ENTITIES, GLOSSARY, OPERATORS } from './catalog.js';
import { likeContains } from '../db/sqlParams.js';
import { normalizeName } from './references.js';

const MAX_TERMS = 4;
const MAX_TERM_LENGTH = 60;

// Text fields a name can be looked up in, per entity. `exclude` keeps a base entity
// from repeating what its derived entity already reported (every user is an account).
const SEARCHABLE = [
  { entity: 'user', fields: ['displayName', 'email', 'companyName', 'department', 'jobTitle'] },
  { entity: 'identity', fields: ['displayName', 'email', 'companyName', 'department', 'jobTitle'] },
  { entity: 'group', fields: ['displayName', 'description'] },
  { entity: 'account', fields: ['displayName', 'email'], exclude: `"principalType" <> 'User'` },
  { entity: 'resource', fields: ['displayName', 'description'], exclude: `"resourceType" <> 'Group'` },
];

// Words that are capitalised in a question but are vocabulary, not names.
// Two-letter words are ignored as names altogether ("AI agents", "HR"): as a substring
// they occur almost everywhere, so where they "occur" says nothing.
const STOPWORDS = new Set(['i', 'id', 'ids', 'or', 'and', 'not', 'ok', 'upn']);
const MIN_TERM_LENGTH = 3;

const vocabulary = (() => {
  const words = new Set(STOPWORDS);
  const add = (text) => String(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean).forEach(w => words.add(normalizeName(w)));
  for (const [name, entity] of Object.entries(ENTITIES)) {
    add(name); add(entity.label); add(`${entity.label}s`);
    for (const [fname, f] of Object.entries(entity.fields)) { add(fname); add(f.label); }
    for (const [rname, r] of Object.entries(entity.relations)) { add(rname); add(r.label); }
  }
  for (const g of GLOSSARY) g.terms.forEach(add);
  for (const o of Object.values(OPERATORS)) add(o.label);
  return words;
})();

const isAllCaps = (w) => (w.match(/\p{Lu}/gu) || []).length >= 2 && !/\p{Ll}/u.test(w);
const isCapitalised = (w) => /^\p{Lu}/u.test(w);

/** Enum values of this deployment (Guest, ServicePrincipal …) are vocabulary too; system names are not. */
function isVocabulary(term, values) {
  const n = normalizeName(term);
  if (vocabulary.has(n)) return true;
  return Object.entries(values || {}).some(([key, list]) => key !== 'systemName' && list.some(v => normalizeName(v) === n));
}

/**
 * The names a question mentions, in order, at most MAX_TERMS.
 * @param {string} question
 * @param {object} [values]  the deployment's enum values (loadValues)
 * @returns {string[]}
 */
export function findTerms(question, values) {
  const text = String(question || '');
  const found = [];
  const push = (t) => {
    const term = t.trim();
    if (normalizeName(term).length < MIN_TERM_LENGTH || term.length > MAX_TERM_LENGTH || isVocabulary(term, values)) return;
    if (!found.some(f => normalizeName(f) === normalizeName(term))) found.push(term);
  };

  for (const m of text.matchAll(/["“”]([^"“”]{2,60})["“”]/gu)) push(m[1]);
  const unquoted = text.replace(/["“”][^"“”]{2,60}["“”]/gu, ' . ');

  // Consecutive name-like words form one name, kept as written between the first and
  // the last word ("Fortigi - Algemeen - Maten", "Folkertsma, Sipke").
  let phrase = null;   // { start, end }
  let sentenceStart = true;
  const flush = () => { if (phrase) push(unquoted.slice(phrase.start, phrase.end)); phrase = null; };
  for (const m of unquoted.matchAll(/[\p{L}\p{N}](?:[\p{L}\p{N}&+_-]|\.(?=[\p{L}\p{N}]))*|[.?!;:]/gu)) {
    const w = m[0];
    if (/^[.?!;:]$/.test(w)) { flush(); sentenceStart = true; continue; }
    const nameLike = isAllCaps(w) || (isCapitalised(w) && !sentenceStart);
    sentenceStart = false;
    const startsWithVocabulary = !phrase && !isAllCaps(w) && vocabulary.has(normalizeName(w));
    if (nameLike && !startsWithVocabulary) {
      phrase = { start: phrase ? phrase.start : m.index, end: m.index + w.length };
    } else flush();
  }
  flush();
  return found.slice(0, MAX_TERMS);
}

/**
 * A case-insensitive Postgres regex matching the term as written, not inside a longer
 * word. Letters and digits bound a word; the term's own punctuation ("UMC+") is literal.
 */
export function wholeWordPattern(term) {
  const literal = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `(^|[^[:alnum:]])${literal}($|[^[:alnum:]])`;
}

/**
 * Where each term occurs: [{ term, places: [{ entity, field }], system: boolean }].
 * Terms that occur nowhere are left out — there is nothing to point the model at.
 * @param {Function} query  db query function
 */
export async function locateTerms(terms, query, values) {
  const located = [];
  for (const term of terms) {
    const places = [];
    for (const { entity: entityName, fields, exclude } of SEARCHABLE) {
      const entity = ENTITIES[entityName];
      const t = 'tm';
      const where = `${entity.where(t)}${exclude ? ` AND ${t}.${exclude}` : ''}`;
      // As a whole word: "RDW" is in "@rdw.nl" and in the company "RDW", but a plain
      // substring search also found it inside "Forwarding" — and pointed the model at
      // every name field there is. ILIKE narrows cheaply first; the regex decides.
      const checks = fields.map((f, i) => {
        const sql = entity.fields[f].sql(t);
        return `EXISTS (SELECT 1 FROM "${entity.table}" ${t} WHERE ${where} AND ${sql} ILIKE $1 ESCAPE '\\' AND ${sql} ~* $2) AS f${i}`;
      });
      const { rows } = await query(`SELECT ${checks.join(', ')}`, [likeContains(term), wholeWordPattern(term)]);
      fields.forEach((f, i) => { if (rows[0]?.[`f${i}`]) places.push({ entity: entityName, field: f }); });
    }
    const n = normalizeName(term);
    const system = (values?.systemName || []).some(s => normalizeName(s).includes(n));
    if (places.length || system) located.push({ term, places, system });
  }
  return located;
}

/** The lines added in front of the request. Field names only. */
export function termHint(located) {
  if (!located.length) return '';
  const lines = located.map(({ term, places, system }) => {
    const where = places.map(p => `${p.entity}.${p.field}`);
    if (system) where.push('system');
    return `- "${term}": ${where.join(', ')}${system ? '' : ' — not a system name'}`;
  });
  return 'Where the names in this request occur in the data. Filter with contains on the ONE field that fits the request ' +
    '(an organisation: companyName; a person: displayName) — only when several fit equally, put them in a group with match "any":\n' +
    lines.join('\n');
}

/** Every text a definition filters on: values and referenced names, at any depth. */
function* usedTexts(conditions) {
  for (const c of conditions || []) {
    if (typeof c.value === 'string') yield c.value;
    if (c.reference?.name) yield c.reference.name;
    if (c.conditions) yield* usedTexts(c.conditions);
  }
}

const uses = (spec, term) => {
  const n = normalizeName(term);
  return [...usedTexts(spec.conditions)].some(v => {
    const nv = normalizeName(v);
    return nv.includes(n) || (nv.length >= 3 && n.includes(nv));
  });
};

/** The located terms a definition does not filter on anywhere. */
export function unusedTerms(spec, located) {
  return located.filter(l => !uses(spec, l.term));
}

export function correctionMessage(unused) {
  const parts = unused.map(({ term, places }) => `"${term}" occurs in: ${places.map(p => `${p.entity}.${p.field}`).join(', ') || 'system'}`);
  return `The request mentions ${unused.map(u => `"${u.term}"`).join(' and ')}, but your definition does not use it. ${parts.join('; ')}. ` +
    'Filter with contains on the one field that fits (a group with match "any" only when several fit equally), ' +
    'remove any condition you used in its place, and reply with the corrected complete JSON.';
}

/**
 * Top-level system conditions whose system name shares no word with the question —
 * what the model reaches for when it does not know where a name lives.
 */
export function ungroundedSystemConditions(spec, question) {
  const q = normalizeName(question);
  const paths = [];
  spec.conditions.forEach((c, i) => {
    if (c.type !== 'field' || c.field !== 'system' || typeof c.value !== 'string') return;
    const words = c.value.split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 3 && !/\d/.test(w));
    if (!words.some(w => q.includes(normalizeName(w)))) paths.push([i]);
  });
  return paths;
}

/**
 * Ask the analyst where a name should be matched, on the report's own entity.
 * Returns null when the name does not occur on that entity (nothing to offer).
 */
export function termConfirmation(spec, { term, places }, question) {
  const entity = ENTITIES[spec.entity];
  const fields = places.filter(p => p.entity === spec.entity).map(p => p.field).filter(f => entity.fields[f]);
  if (!fields.length) return null;
  const labels = fields.map(f => entity.fields[f].label);
  const choices = fields.map((f, i) => ({ name: `${labels[i]} contains “${term}”`, fields: [f] }));
  if (fields.length > 1) choices.push({ name: `${labels.join(' or ')} contains “${term}”`, fields });
  const drop = ungroundedSystemConditions(spec, question);
  const replaced = drop.map(([i]) => `System is “${spec.conditions[i].value}”`);
  const message = replaced.length
    ? `“${term}” is not a system — it appears in ${labels.join(' and ')}. Which should the report match? This replaces ${replaced.join(', ')}.`
    : `The report does not use “${term}” yet. It appears in ${labels.join(' and ')}. Which should the report match?`;
  return { kind: 'term', path: [], name: term, label: entity.label.toLowerCase(), choices, drop, message };
}

/**
 * Apply the analyst's answer to a term confirmation, in place.
 * @param {{ name: string, fields?: string[], drop?: number[][], skip?: boolean }} choice
 * @returns {boolean} false when the choice does not fit this report
 */
export function applyTermChoice(spec, choice) {
  if (choice.skip === true) return true;
  const entity = ENTITIES[spec.entity];
  const term = typeof choice.term === 'string' ? choice.term.trim() : '';
  const fields = Array.isArray(choice.fields) ? choice.fields : [];
  if (!term || term.length > MAX_TERM_LENGTH || !fields.length) return false;
  if (!fields.every(f => typeof f === 'string' && Object.hasOwn(entity.fields, f) && entity.fields[f].type === 'text')) return false;

  // Only top-level system conditions can be dropped — that is all a confirmation offers.
  const drop = (Array.isArray(choice.drop) ? choice.drop : [])
    .map(p => (Array.isArray(p) && p.length === 1 && Number.isInteger(p[0]) ? p[0] : -1))
    .filter(i => i >= 0 && i < spec.conditions.length && spec.conditions[i].type === 'field' && spec.conditions[i].field === 'system');
  for (const i of [...new Set(drop)].sort((a, b) => b - a)) spec.conditions.splice(i, 1);

  const conditions = fields.map(field => ({ type: 'field', field, op: 'contains', value: term }));
  spec.conditions.push(conditions.length === 1 ? conditions[0] : { type: 'group', match: 'any', conditions });
  return true;
}
