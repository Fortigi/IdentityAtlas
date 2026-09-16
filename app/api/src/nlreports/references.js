// Natural-language reports (PROTOTYPE) — looking up the objects a report names.
//
// A question often names a specific object: "business role Fortigi - Algemeen -
// Maten", "the Sales group", "Folkertsma, Sipke". Before a definition runs, every
// named object is looked up:
//
//   • compare references            → must resolve to exactly one record id
//   • "name is X" field conditions  → the name must exist for that entity
//
// Matching, strictest first:
//   exact (case-insensitive)                    → used silently
//   same apart from spaces/punctuation, unique  → used silently, name corrected
//   fuzzy (pg_trgm similarity / word match)     → the analyst CONFIRMS a choice
//   nothing close                               → the analyst types the exact name
//
// Only one confirmation is returned at a time; applyChoice() applies the
// analyst's answer and the caller resolves again. No model round-trip is needed.

import { ENTITIES } from './catalog.js';
import { baseEntityOf, humanType } from './compare.js';
import { likeContains } from '../db/sqlParams.js';

const TYPE_COLUMN = { Resources: 'resourceType', Principals: 'principalType' };
const MIN_SIMILARITY = 0.25;
const MIN_WORD_SIMILARITY = 0.6;
const MAX_CHOICES = 5;

const typeSelect = (entity, t) => (TYPE_COLUMN[entity.table] ? `${t}."${TYPE_COLUMN[entity.table]}"` : 'NULL');

export const normalizeName = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

const entityWord = (entityName) => ENTITIES[entityName].label.toLowerCase();

async function exactMatches(query, entityName, name) {
  const entity = ENTITIES[entityName];
  const t = 'n0';
  const { rows } = await query(
    `SELECT ${t}."id", ${t}."displayName", ${typeSelect(entity, t)} AS type, lower(${t}."displayName") = lower($1) AS exact
     FROM "${entity.table}" ${t}
     WHERE ${entity.where(t)} AND (lower(${t}."displayName") = lower($1)
       OR regexp_replace(lower(${t}."displayName"), '[^[:alnum:]]+', '', 'g') = $2)
     ORDER BY exact DESC, ${t}."displayName" LIMIT 6`,
    [name, normalizeName(name)],
  );
  return rows;
}

async function fuzzyMatches(query, entityName, name) {
  const entity = ENTITIES[entityName];
  const t = 'n0';
  const dn = `lower(${t}."displayName")`;
  const { rows } = await query(
    `SELECT ${t}."id", ${t}."displayName", ${typeSelect(entity, t)} AS type,
       round((similarity(${dn}, lower($1)) * 0.6 + word_similarity(lower($1), ${dn}) * 0.4)::numeric, 2) AS score
     FROM "${entity.table}" ${t}
     WHERE ${entity.where(t)} AND (${t}."displayName" ILIKE $2 ESCAPE '\\'
       OR similarity(${dn}, lower($1)) >= ${MIN_SIMILARITY}
       OR word_similarity(lower($1), ${dn}) >= ${MIN_WORD_SIMILARITY})
     ORDER BY score DESC, ${t}."displayName" LIMIT ${MAX_CHOICES}`,
    [name, likeContains(name)],
  );
  return rows.map(r => ({ id: r.id, name: r.displayName, type: r.type, score: Number(r.score) }));
}

/** Names for the reference picker in the editor. */
export async function searchNames(query, entityName, text) {
  return fuzzyMatches(query, entityName, text);
}

/** Every named object in a spec, with the path to its condition and the entity it names. */
function* namedObjects(conditions, entityName, path = []) {
  for (let i = 0; i < conditions.length; i++) {
    const c = conditions[i];
    const p = [...path, i];
    if (c.type === 'compare') yield { c, path: p, kind: 'reference', entityName: c.reference.entity };
    else if (c.type === 'field' && c.op === 'eq' && c.field === 'displayName' && !c.checked) yield { c, path: p, kind: 'value', entityName };
    else if (c.type === 'group') yield* namedObjects(c.conditions, entityName, p);
    else if (c.type === 'relation') yield* namedObjects(c.conditions, ENTITIES[entityName].relations[c.relation].target, p);
  }
}

function confirmation(kind, path, name, entityName, choices) {
  const label = choices.length ? humanType(choices[0].type, entityWord(entityName)) : entityWord(entityName);
  const message = choices.length
    ? `No ${label} is named exactly "${name}". Did you mean:`
    : `I could not find any ${label} named "${name}". What is its exact name?`;
  return { kind, path, name, label, choices, message };
}

async function resolveReference(query, c, path) {
  const ref = c.reference;
  if (ref.id) {
    const entity = ENTITIES[ref.entity];
    const { rows } = await query(
      `SELECT n0."id", n0."displayName", ${typeSelect(entity, 'n0')} AS type FROM "${entity.table}" n0 WHERE n0."id" = $1`, [ref.id]);
    if (rows.length === 1) { Object.assign(ref, { name: rows[0].displayName, type: rows[0].type }); return null; }
    delete ref.id;
    delete ref.type;
  }
  // A business role named as a "group" is still found: try the base entity too.
  for (const entityName of new Set([ref.entity, baseEntityOf(ref.entity)])) {
    const rows = await exactMatches(query, entityName, ref.name);
    const exact = rows.filter(r => r.exact);
    const pick = exact.length === 1 ? exact[0] : (exact.length === 0 && rows.length === 1 ? rows[0] : null);
    if (pick) {
      Object.assign(ref, { entity: entityName, id: pick.id, name: pick.displayName, type: pick.type });
      return null;
    }
    if (rows.length > 1) {
      return confirmation('reference', path, ref.name, entityName, rows.map(r => ({ id: r.id, name: r.displayName, type: r.type })));
    }
  }
  const base = baseEntityOf(ref.entity);
  return confirmation('reference', path, ref.name, base, await fuzzyMatches(query, base, ref.name));
}

async function resolveValue(query, c, path, entityName) {
  const rows = await exactMatches(query, entityName, c.value);
  if (rows.some(r => r.exact)) return null;
  if (rows.length === 1) { c.value = rows[0].displayName; return null; }
  const choices = rows.length > 1
    ? rows.map(r => ({ id: r.id, name: r.displayName, type: r.type }))
    : await fuzzyMatches(query, entityName, c.value);
  return confirmation('value', path, c.value, entityName, choices);
}

/**
 * Look up every named object in a validated spec, in place.
 * @returns {Promise<{ confirm: object|null }>} the first object the analyst has to confirm, if any
 */
export async function resolveNamedObjects(spec, query) {
  for (const item of namedObjects(spec.conditions, spec.entity)) {
    const confirm = item.kind === 'reference'
      ? await resolveReference(query, item.c, item.path)
      : await resolveValue(query, item.c, item.path, item.entityName);
    if (confirm) return { confirm };
  }
  return { confirm: null };
}

// The path comes from the browser. Only whole, in-range array positions are followed:
// a key like "__proto__" or "constructor" would otherwise walk into a prototype, and
// the assignments in applyChoice() would then write onto it.
const isIndexInto = (list, i) => Array.isArray(list) && Number.isInteger(i) && i >= 0 && i < list.length;

function conditionAt(spec, path) {
  let list = spec.conditions;
  let c = null;
  for (const i of path) {
    c = isIndexInto(list, i) ? list[i] : undefined;
    if (!c) return null;
    list = c.conditions;
  }
  return c;
}

/**
 * Apply the analyst's answer to a confirmation, in place.
 * @param {{ path: number[], name: string, id?: string, keep?: boolean }} choice
 *   name  the chosen (or typed) exact name · id  the chosen record, when known
 *   keep  use a "name is X" value as written, without checking it again
 * @returns {boolean} false when the path does not point at a named object
 */
export function applyChoice(spec, choice) {
  if (!choice || !Array.isArray(choice.path) || typeof choice.name !== 'string' || !choice.name.trim()) return false;
  const c = conditionAt(spec, choice.path);
  if (c?.type === 'compare') {
    c.reference.name = choice.name.trim();
    delete c.reference.type;
    if (typeof choice.id === 'string') c.reference.id = choice.id;
    else delete c.reference.id;
    return true;
  }
  if (c?.type === 'field' && c.field === 'displayName') {
    c.value = choice.name.trim();
    if (choice.keep === true) c.checked = true;
    return true;
  }
  return false;
}
