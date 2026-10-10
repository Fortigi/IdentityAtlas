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
// The analyst's model, which this follows: a list is ONE entity per row with every
// column as an attribute; the organisation truth is linked to the system truth through
// those attributes. Nothing in the list becomes an invented second entity.
//
// Decisions, in order:
//   1. The entity: its type comes from the file name ("Projects.xlsx" → Project), else
//      Item. Its key is chosen among the text and number columns that are ≥ 80% unique
//      and ≥ 90% filled — a real list has a few duplicate keys, which the quality step
//      shows: first the one whose header says it is a key (code/id/nummer/number/key/
//      name/naam/titel/title), else the most unique. A header with name/naam/title/titel/
//      omschrijving/description is its name. Every other column is an attribute.
//   2. Link rules, one per attribute that looks like it names something in a system:
//      - an e-mail column: → Principal via that attribute (email exact 90, prefix 80),
//        plus a name signal (60) on its sibling name column when the list has one
//        ("OwnerEmail" ↔ "OwnerName" / "Owner");
//      - a text column headed by a role word (eigenaar, owner, manager, …), a full-name
//        header (volledige naam, full name, medewerker, …), or one that lists several
//        people per cell (a SharePoint "A;#27;#B;#16" lookup, or a team-like header with
//        ";"): → Principal via that attribute (displayName exact 80, name 60), plus an
//        employee-number signal (95) when the list has such a column;
//      - the entity itself: → Resource via its name (displayName exact 80, token 50) —
//        a row of a list is often a group, site or application; the quality step shows
//        whether that finds anything.
//      A cell listing several people links each of them (the engine splits the value).

import { validateLinkRules, validateRecipe, normalizeLinkRules, normalizeRecipe, NAME_ATTRIBUTE, LIMITS } from '../contracts.js';
import { camelCase, squash, typeFromFileName, uniqueName, words } from './names.js';

export const MAX_NOTES = 8;
const KEY_UNIQUENESS = 0.8;
const KEY_HEADER = /code|id|nummer|number|key|name|naam|titel|title/i;
const KEY_FILLED = 0.9;
const NAME_HEADER = /name|naam|title|titel|omschrijving|description/i;
const ROLE_WORDS = new Set(['owner', 'manager', 'eigenaar', 'beheerder', 'contact', 'contactpersoon', 'verantwoordelijke', 'sponsor', 'lead']);
const EMAIL_WORDS = new Set(['e', 'email', 'mail', 'emailadres', 'mailadres', 'address', 'adres', 'upn']);
const PERSON_NAME_WORDS = ['name', 'naam', 'fullname', 'displayname', 'volledigenaam'];
// Columns that hold a person's name without saying which role ("Volledige naam", "Medewerker").
const FULL_NAME_HEADER = /volledige\s*naam|full\s*name|naam\s*medewerker|^medewerker$|employee\s*name|^persoon$|^person$|^werknemer$/i;
// Columns that hold an employee / personnel number: the strongest person signal there is.
const EMPLOYEE_ID_HEADER = /^(persoons?|personeels?|medewerker|employee|staff|werknemer)\s*-?\s*(nummer|number|nr|id)$|^employee\s*id$|^personnel\s*(number|nr|id)$/i;
// Columns that list several people: a SharePoint multi-lookup ("A;#27;#B;#16") or a header that says so.
const MULTI_PERSON_WORDS = new Set(['team', 'teamleden', 'leden', 'members', 'deelnemers', 'participants', 'medewerkers', 'teammembers']);
const SP_LOOKUP = /;#/;
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

function isRole(header) {
  const last = words(header).pop();
  return !!last && ROLE_WORDS.has(last.toLowerCase());
}

/** A text column whose header ends in a role word ("Eigenaar", "Project owner") holds people by name. */
export function isRoleColumn(column) {
  return column.shape === 'text' && isRole(column.name);
}
/** A text column whose header says it holds a person's full name. */
export function isFullNameColumn(column) {
  return column.shape === 'text' && FULL_NAME_HEADER.test(column.name.trim());
}
/** A column whose header says it holds an employee / personnel number. */
export function isEmployeeIdColumn(column) {
  return ['text', 'number'].includes(column.shape) && EMPLOYEE_ID_HEADER.test(column.name.trim());
}
/** A text column that lists several people per row (SharePoint lookup values, or a team-like header with ";"). */
export function isMultiPersonColumn(column) {
  if (column.shape !== 'text') return false;
  const samples = (column.samples ?? []).filter(v => typeof v === 'string');
  if (samples.some(v => SP_LOOKUP.test(v))) return true;
  return MULTI_PERSON_WORDS.has(squash(column.name)) && samples.some(v => v.includes(';'));
}
const isPersonColumn = (c) => isRoleColumn(c) || isFullNameColumn(c) || isMultiPersonColumn(c);

/** At least half of the samples look like directory group names. */
export function looksLikeGroupNames(samples) {
  const s = (samples ?? []).filter(v => typeof v === 'string' && v.trim());
  if (s.length === 0) return false;
  return s.filter(v => GROUP_NAME.test(v.trim()) || v.includes('_')).length * 2 >= s.length;
}

/** Columns the heuristic can address: a non-empty name, in file order. */
export function usableColumns(columns) {
  return (Array.isArray(columns) ? columns : [])
    .filter(c => typeof c?.name === 'string' && c.name.trim())
    .map((c, i) => ({ ...c, index: Number.isFinite(c.index) ? c.index : i }));
}

function pickKey(cols, rows) {
  const candidates = cols.filter(c => ['text', 'number'].includes(c.shape)
    && num(c.uniqueness) >= KEY_UNIQUENESS && num(c.nonEmpty) >= KEY_FILLED * rows);
  const byHeader = candidates.find(c => KEY_HEADER.test(c.name));
  // Stable sort: on a tie the column further left wins.
  return byHeader ?? [...candidates].sort((a, b) => num(b.uniqueness) - num(a.uniqueness))[0] ?? null;
}

// The data probes (probe.js), when the proposal had the rows: share of a
// column's values that are accounts / resources / entities of another list.
const PROBE_SHARE = 0.5;
const probeOf = (probes, c) => probes?.[c.name] ?? { people: 0, resources: 0, orgEntities: 0, orgEntityTypes: [] };
const holdsPeople = (probes, c) => probeOf(probes, c).people >= PROBE_SHARE;
const namesOrgEntities = (probes, c) => probeOf(probes, c).orgEntities >= PROBE_SHARE;

function pickName(cols, key, probes) {
  return cols.find(c => c !== key && NAME_HEADER.test(c.name) && !isPersonColumn(c) && c.shape !== 'email')
    ?? key
    // a fact list without a key (a timesheet): name a row after what it is about
    ?? cols.find(c => c.shape === 'text' && namesOrgEntities(probes, c))
    ?? cols.find(c => c.shape === 'text' && holdsPeople(probes, c))
    ?? cols.find(c => c.shape === 'text')
    ?? cols[0];
}

// The entity: name, key, every other column as an attribute. Returns the
// definition plus a Map column → attribute name (the name column maps to
// displayName) so the rules can refer to columns by attribute.
function entityOf({ type, cols, rows, probes, compositeKey }) {
  const key = pickKey(cols, rows);
  const name = pickName(cols, key, probes);
  const used = new Set([key, name]);
  const attrNames = new Set([NAME_ATTRIBUTE]);
  const byColumn = new Map([[name.name, NAME_ATTRIBUTE]]);
  const attributes = [];
  for (const c of cols) {
    if (used.has(c)) continue;
    if (attributes.length >= LIMITS.attributesPerEntity) break;
    const attr = uniqueName(camelCase(c.name) || `column${num(c.index) + 1}`, attrNames);
    attributes.push({ column: c.name, name: attr });
    byColumn.set(c.name, attr);
  }
  const composite = !key && Array.isArray(compositeKey) && compositeKey.length >= 2 ? compositeKey : null;
  const entity = {
    type, nameColumn: name.name, ...(key ? { keyColumn: key.name } : {}), ...(composite ? { keyColumns: composite } : {}), attributes,
  };
  return { entity, byColumn, note: keyNote(type, key, name, composite), groupLike: looksLikeGroupNames(name.samples), name };
}

function keyNote(type, key, name, composite) {
  if (key) return `${key.name} ${num(key.uniqueness) < 1 ? 'is nearly unique (a few values repeat)' : 'is unique on every row'}, so it is the key of ${type}${name === key ? '' : `, and ${name.name} is its name`}.`;
  if (composite) return `No single column is unique, but ${composite.join(' + ')} together are, so every row is one ${type}, named after ${name.name}.`;
  return `No column is unique enough to be a key, so ${type} is identified by ${name.name}.`;
}

const signal = (attribute, targetField, type, weight) => ({ attribute, targetField, type, weight });

/** The employee-id column nearest to `col`, when the list has one. */
function employeeIdColumnFor(col, cols) {
  const ids = cols.filter(isEmployeeIdColumn);
  ids.sort((a, b) => Math.abs(num(a.index) - num(col.index)) - Math.abs(num(b.index) - num(col.index)));
  return ids[0] ?? null;
}

function emailRule(type, col, cols, byColumn) {
  const via = byColumn.get(col.name);
  const nameCol = personNameColumn(col, emailPrefix(col.name), cols.filter(c => c !== col && !isEmployeeIdColumn(c)));
  const signals = [signal(via, 'email', 'exact', 90), signal(via, 'email', 'prefix', 80)];
  if (nameCol) signals.push(signal(byColumn.get(nameCol.name), NAME_ATTRIBUTE, 'name', 60));
  return {
    rule: { entityType: type, targetType: 'Principal', via, threshold: 50, signals },
    note: `${col.name} looks like an e-mail address, so ${type} is linked through it to accounts${nameCol ? `, with ${nameCol.name} as the name` : ''}.`,
  };
}

function personRule(type, col, cols, byColumn) {
  const via = byColumn.get(col.name);
  const idCol = employeeIdColumnFor(col, cols);
  const signals = [
    ...(idCol ? [signal(byColumn.get(idCol.name), 'employeeId', 'exact', 95)] : []),
    signal(via, NAME_ATTRIBUTE, 'exact', 80),
    signal(via, NAME_ATTRIBUTE, 'name', 60),
  ];
  const multi = isMultiPersonColumn(col);
  const why = multi ? 'lists several people per row' : isRole(col.name) ? 'names a role' : 'holds a person\'s name';
  return {
    rule: { entityType: type, targetType: 'Principal', via, threshold: 50, signals },
    note: `${col.name} ${why}, so ${type} is linked through it to accounts by ${idCol ? `employee number (${idCol.name}) and ` : ''}name${multi ? '; each name in the cell is linked' : ''}.`,
  };
}

function resourceRule(type, entity, groupLike) {
  return {
    rule: {
      entityType: type, targetType: 'Resource', via: NAME_ATTRIBUTE, threshold: 50,
      signals: [signal(NAME_ATTRIBUTE, NAME_ATTRIBUTE, 'exact', 80), signal(NAME_ATTRIBUTE, NAME_ATTRIBUTE, 'token', 50)],
    },
    note: groupLike
      ? `The values of ${entity.nameColumn} look like group names, so ${type} is matched to groups.`
      : `${type} is also matched to resources by name (${entity.nameColumn}); the quality step shows whether that finds anything.`,
  };
}

function orgEntityRule(type, col, via, probes) {
  const p = probeOf(probes, col);
  const other = p.orgEntityTypes[0];
  return {
    rule: {
      entityType: type, targetType: 'OrgEntity', via, threshold: 60,
      ...(other ? { targetEntityType: other } : {}),
      signals: [signal(via, NAME_ATTRIBUTE, 'fuzzy', 100)],
    },
    note: `${Math.round(p.orgEntities * 100)} % of the values of ${col.name} match ${other ? `a ${other}` : 'an entity'} from another list, so ${type} is linked through it to that list (fuzzy on the name).`,
  };
}

function selfPersonRule(type, entity, probes, name) {
  return {
    rule: {
      entityType: type, targetType: 'Principal', via: NAME_ATTRIBUTE, threshold: 50,
      signals: [signal(NAME_ATTRIBUTE, NAME_ATTRIBUTE, 'exact', 80), signal(NAME_ATTRIBUTE, NAME_ATTRIBUTE, 'name', 60)],
    },
    note: `${Math.round(probeOf(probes, name).people * 100)} % of the values of ${entity.nameColumn} are accounts, so every ${type} is a person, linked to their account by name.`,
  };
}

// The rules for the entity itself: a person list links each row to its own
// account; a list naming another list's entities links to them; otherwise the
// row is matched to resources by name.
function selfRules(type, built, probes) {
  const { entity, groupLike, name } = built;
  const out = [];
  if (holdsPeople(probes, name)) out.push(selfPersonRule(type, entity, probes, name));
  if (namesOrgEntities(probes, name)) out.push(orgEntityRule(type, name, NAME_ATTRIBUTE, probes));
  if (out.length === 0 || probeOf(probes, name).resources >= PROBE_SHARE / 2) out.unshift(resourceRule(type, entity, groupLike));
  return out;
}

// The rules an entity's columns suggest: the entity itself (selfRules), then one
// per column that names people (by header, or because the probe found its values
// among the accounts) or another list's entities. A column an e-mail rule uses as
// its name is not a rule of its own.
function rulesFor(type, cols, built, probes) {
  const { byColumn } = built;
  const out = selfRules(type, built, probes);
  const nameOf = (c) => byColumn.get(c.name);
  const isAttr = (c) => nameOf(c) && nameOf(c) !== NAME_ATTRIBUTE;
  const claimed = new Set();
  for (const c of cols.filter(c => c.shape === 'email' && isAttr(c))) {
    const r = emailRule(type, c, cols, byColumn);
    for (const s of r.rule.signals) if (s.attribute !== r.rule.via) claimed.add(s.attribute);
    out.push(r);
  }
  const personish = (c) => isPersonColumn(c) || (c.shape === 'text' && holdsPeople(probes, c));
  for (const c of cols.filter(c => personish(c) && isAttr(c) && !claimed.has(nameOf(c)))) out.push(personRule(type, c, cols, byColumn));
  for (const c of cols.filter(c => c.shape === 'text' && isAttr(c) && !personish(c) && namesOrgEntities(probes, c))) {
    out.push(orgEntityRule(type, c, nameOf(c), probes));
  }
  return out;
}

/**
 * @param {object} args
 * @param {string} [args.fileName]
 * @param {object[]} args.columns   the column profile
 * @param {number} [args.rowCount]  rows in the list; the fullest column's count when absent
 * @param {object} [args.probes]    probe.js probeColumns result, when the rows were available
 * @param {string[]} [args.compositeKey] probe.js findCompositeKey result
 * @returns {{ recipe: object, linkRules: object[], notes: string[] }} validated and normalised
 * @throws when the profile has no usable column (nothing can be proposed for an empty list)
 */
export function heuristicProposal({ fileName = '', columns, rowCount, probes = null, compositeKey = null } = {}) {
  const cols = usableColumns(columns);
  if (cols.length === 0) throw new Error('The list has no named columns, so there is nothing to propose.');
  const rows = Number.isFinite(rowCount) ? rowCount : Math.max(...cols.map(c => num(c.nonEmpty)));
  const type = uniqueName(typeFromFileName(fileName), new Set());
  const built = entityOf({ type, cols, rows, probes, compositeKey });
  const rules = rulesFor(type, cols, built, probes);
  return finish(
    { version: 1, entities: [built.entity], relations: [] },
    rules.map(r => r.rule),
    [built.note, ...rules.map(r => r.note)],
    cols.map(c => c.name),
  );
}

function finish(recipe, linkRules, notes, columnNames) {
  const r = validateRecipe(recipe, columnNames);
  const l = validateLinkRules(linkRules, recipe);
  if (!r.ok || !l.ok) throw new Error(`The heuristic proposal is invalid: ${[...r.errors, ...l.errors].join(' ')}`);
  return { recipe: normalizeRecipe(recipe), linkRules: normalizeLinkRules(linkRules), notes: notes.slice(0, MAX_NOTES) };
}
