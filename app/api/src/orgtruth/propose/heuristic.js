// Organisation truth — the heuristic proposal (column profile → recipe + link rules).
//
// Deterministic and pure: no model, no database. It is the answer the wizard gets when
// the report generator is not there, and the fallback when the model's answer does not
// validate. It must ALWAYS return a recipe that passes validateRecipe and link rules that
// pass validateLinkRules — a heuristic that fails its own contract is a bug, and the
// tests run it on degenerate profiles to prove it does not.
//
// Input: the column profile produced by import/profileColumns.js (workstream T1):
//   [{ name, index, nonEmpty, distinct, uniqueness, shape: 'email'|'number'|'date'|'boolean'|'text',
//      samples: string[], duplicates }]
//
// Decisions, in order:
//   1. Every e-mail-shaped column is a person entity. Its type is the role in the header
//      when that is a role word ("OwnerEmail" → Owner), else Person; a collision gets a
//      number (Owner, Owner2). Its name column is the sibling header with the same prefix
//      ("OwnerName", "Owner"), nearest first, else the e-mail column itself.
//   2. The primary entity is built from the remaining columns. Its key is chosen among the
//      text and number columns that are ≥ 80% unique and ≥ 90% filled — a real list has a
//      few duplicate keys, which the quality step shows, so a near-unique column still
//      keys it: first the one whose header says it is a key (code/id/nummer/number/key/
//      name/naam/titel/title), else the most unique. A header with name/naam/title/titel/
//      omschrijving/description is its name.
//      Its type comes from the file name ("Projects.xlsx" → Project), else Item.
//      When every column is an e-mail column there is no primary entity.
//   3. Primary → each person, the predicate being the camelCased role prefix.
//   4. Every column not used above is an attribute of the primary.
//   5. Person → Principal on email (exact 90) + displayName (name 60), threshold 50; the
//      primary → Resource on displayName (exact 80, token 50) only when its names look
//      like group names.

import { validateLinkRules, validateRecipe, normalizeLinkRules, normalizeRecipe, NAME_ATTRIBUTE, LIMITS } from '../contracts.js';
import { camelCase, pascalCase, squash, typeFromFileName, uniqueName, words } from './names.js';

export const MAX_NOTES = 8;
const KEY_UNIQUENESS = 0.8;
const KEY_HEADER = /code|id|nummer|number|key|name|naam|titel|title/i;
const KEY_FILLED = 0.9;
const NAME_HEADER = /name|naam|title|titel|omschrijving|description/i;
const ROLE_WORDS = new Set(['owner', 'manager', 'eigenaar', 'beheerder', 'contact']);
const EMAIL_WORDS = new Set(['e', 'email', 'mail', 'emailadres', 'mailadres', 'address', 'adres', 'upn']);
const PERSON_NAME_WORDS = ['name', 'naam', 'fullname', 'displayname', 'volledigenaam'];
const GROUP_NAME = /^(SG|GG|DL|AAD|AZ)[_-]/i;

const num = (v) => (Number.isFinite(v) ? v : 0);

/** "OwnerEmail" → "Owner", "E-mailadres eigenaar" → "eigenaar", "Email" → "". */
export function emailPrefix(header) {
  return words(header).filter(w => !EMAIL_WORDS.has(w.toLowerCase())).join(' ');
}

/** The free column nearest to `email` whose header is the prefix, or the prefix plus a name word. */
export function personNameColumn(email, prefix, free) {
  const p = squash(prefix);
  if (!p) return null;
  const wanted = new Set([p, ...PERSON_NAME_WORDS.flatMap(n => [p + n, n + p])]);
  const matches = free.filter(c => wanted.has(squash(c.name)));
  matches.sort((a, b) => Math.abs(num(a.index) - num(email.index)) - Math.abs(num(b.index) - num(email.index)));
  return matches[0] ?? null;
}

function isRole(prefix) {
  const last = words(prefix).pop();
  return !!last && ROLE_WORDS.has(last.toLowerCase());
}

function personEntity(email, free, taken) {
  const prefix = emailPrefix(email.name);
  const nameCol = personNameColumn(email, prefix, free);
  if (nameCol) free.splice(free.indexOf(nameCol), 1);
  const type = uniqueName(isRole(prefix) ? pascalCase(prefix) : 'Person', taken);
  return {
    entity: { type, nameColumn: (nameCol ?? email).name, attributes: [{ column: email.name, name: 'email' }] },
    predicate: camelCase(prefix) || 'person',
    note: `${email.name} looks like an e-mail address, so ${type} is a person${nameCol ? ` named by ${nameCol.name}` : ''}.`,
  };
}

function pickKey(free, rows) {
  const candidates = free.filter(c => ['text', 'number'].includes(c.shape)
    && num(c.uniqueness) >= KEY_UNIQUENESS && num(c.nonEmpty) >= KEY_FILLED * rows);
  const byHeader = candidates.find(c => KEY_HEADER.test(c.name));
  // Stable sort: on a tie the column further left wins.
  return byHeader ?? [...candidates].sort((a, b) => num(b.uniqueness) - num(a.uniqueness))[0] ?? null;
}

function pickName(free, key) {
  return free.find(c => c !== key && NAME_HEADER.test(c.name))
    ?? key
    ?? free.find(c => c.shape === 'text')
    ?? free[0];
}

/** At least half of the samples look like directory group names. */
export function looksLikeGroupNames(samples) {
  const s = (samples ?? []).filter(v => typeof v === 'string' && v.trim());
  if (s.length === 0) return false;
  return s.filter(v => GROUP_NAME.test(v.trim()) || v.includes('_')).length * 2 >= s.length;
}

function primaryEntity({ type, free, rows }) {
  const key = pickKey(free, rows);
  const name = pickName(free, key);
  const used = new Set([key, name]);
  const attrNames = new Set([NAME_ATTRIBUTE]);
  const attributes = free.filter(c => !used.has(c)).slice(0, LIMITS.attributesPerEntity)
    .map(c => ({ column: c.name, name: uniqueName(camelCase(c.name) || `column${num(c.index) + 1}`, attrNames) }));
  const entity = { type, nameColumn: name.name, ...(key ? { keyColumn: key.name } : {}), attributes };
  const notes = [key
    ? `${key.name} ${num(key.uniqueness) < 1 ? 'is nearly unique (a few values repeat)' : 'is unique on every row'}, so it is the key of ${type}${name === key ? '' : `, and ${name.name} is its name`}.`
    : `No column is unique enough to be a key, so ${type} is identified by ${name.name}.`];
  return { entity, notes, groupLike: looksLikeGroupNames(name.samples) };
}

const personRule = (entity) => ({
  entityType: entity.type, targetType: 'Principal', threshold: 50,
  signals: [
    { attribute: 'email', targetField: 'email', type: 'exact', weight: 90 },
    // Matching an e-mail address as a person's name only adds noise.
    ...(entity.nameColumn === entity.attributes[0].column ? [] : [{ attribute: NAME_ATTRIBUTE, targetField: 'displayName', type: 'name', weight: 60 }]),
  ],
});

const resourceRule = (entity) => ({
  entityType: entity.type, targetType: 'Resource', threshold: 50,
  signals: [
    { attribute: NAME_ATTRIBUTE, targetField: 'displayName', type: 'exact', weight: 80 },
    { attribute: NAME_ATTRIBUTE, targetField: 'displayName', type: 'token', weight: 50 },
  ],
});

/** Columns the heuristic can address: a non-empty name, in file order. */
export function usableColumns(columns) {
  return (Array.isArray(columns) ? columns : [])
    .filter(c => typeof c?.name === 'string' && c.name.trim())
    .map((c, i) => ({ ...c, index: Number.isFinite(c.index) ? c.index : i }));
}

/**
 * @param {object} args
 * @param {string} [args.fileName]
 * @param {object[]} args.columns   the column profile
 * @param {number} [args.rowCount]  rows in the list; the fullest column's count when absent
 * @returns {{ recipe: object, linkRules: object[], notes: string[] }} validated and normalised
 * @throws when the profile has no usable column (nothing can be proposed for an empty list)
 */
export function heuristicProposal({ fileName = '', columns, rowCount } = {}) {
  const cols = usableColumns(columns);
  if (cols.length === 0) throw new Error('The list has no named columns, so there is nothing to propose.');
  const rows = Number.isFinite(rowCount) ? rowCount : Math.max(...cols.map(c => num(c.nonEmpty)));

  // One entity slot is kept for the primary; e-mail columns past the limit stay attributes.
  const emails = cols.filter(c => c.shape === 'email').slice(0, LIMITS.entities - 1);
  const free = cols.filter(c => !emails.includes(c));
  const taken = new Set();
  // The primary claims its type first, so a person never takes the file's name.
  const primaryType = free.length ? uniqueName(typeFromFileName(fileName), taken) : null;
  const people = emails.map(c => personEntity(c, free, taken));
  const primary = primaryType ? primaryEntity({ type: primaryType, free, rows }) : null;

  const entities = [...(primary ? [primary.entity] : []), ...people.map(p => p.entity)];
  const relations = primary ? people.map(p => ({ predicate: p.predicate, from: primary.entity.type, to: p.entity.type })) : [];
  const linkRules = people.map(p => personRule(p.entity));
  const notes = [...(primary?.notes ?? []), ...people.map(p => p.note)];
  if (primary?.groupLike) {
    linkRules.unshift(resourceRule(primary.entity));
    notes.push(`The values of ${primary.entity.nameColumn} look like group names, so ${primary.entity.type} is matched to groups.`);
  }
  return finish({ version: 1, entities, relations }, linkRules, notes, cols.map(c => c.name));
}

function finish(recipe, linkRules, notes, columnNames) {
  const r = validateRecipe(recipe, columnNames);
  const l = validateLinkRules(linkRules, recipe);
  if (!r.ok || !l.ok) throw new Error(`The heuristic proposal is invalid: ${[...r.errors, ...l.errors].join(' ')}`);
  return { recipe: normalizeRecipe(recipe), linkRules: normalizeLinkRules(linkRules), notes: notes.slice(0, MAX_NOTES) };
}
