// Organisation truth — apply a recipe to the rows of a list. Pure: no I/O.
//
//   applyRecipe(rows, recipe) → { entities, relations, issues }
//
// `recipe` must be normalised (contracts.js normalizeRecipe: every entity has
// a keyColumn, every attribute a name). `rows` are parse.js rows; row i of the
// array is data row i + 1.
//
// entities:  { entityType, canonicalKey, displayName, attributes, sourceLocator, row }
//   One instance per entity definition per row whose nameColumn is non-blank —
//   or several, when the keyColumn cell holds several e-mail addresses
//   separated by ; or , (one instance per address, see namesAndKeys; every
//   relation of that row then runs to each of them).
//   canonicalKey = the trimmed, lower-cased keyColumn value. Instances are
//   de-duplicated per (entityType, canonicalKey): the first row wins for the
//   name and the locator; attributes are merged, the first non-blank value per
//   attribute wins. Attribute values are trimmed strings; blanks are left out.
//   This is also the in-memory shape linking/stats.js receives.
// relations: { predicate, fromType, fromKey, toType, toKey, sourceLocator, row }
//   One per relation definition per row where both sides produced an instance
//   on that row, de-duplicated per (predicate, from, to) — first row wins. A
//   relation of an instance to itself (from and to the same type) is skipped.
// issues:    { kind, entityType, row, detail }
//   emptyKey     the row names an entity but its keyColumn is blank (no instance)
//   duplicateKey the key was seen on an earlier row with a DIFFERENT name or a
//                different non-blank attribute value. A repeat that agrees is
//                not an issue: the same owner on ten project rows is the list
//                referring to one person ten times, not a quality problem.
//   missingSide  a relation's one side is on the row and the other is not
//                (entityType = the missing side). Both missing: no issue.
//
// summarizeApplied(applied, recipe) → the per-type / per-predicate counts the
// dry-run report and the run stats share.
import { isEmailLike } from './profileColumns.js';

const SEP = '\u0000';

const cell = (row, column) => String(row?.[column] ?? '').trim();
export const entityKey = (type, key) => `${type}${SEP}${key}`;

// The analyst may expose the name under an attribute of their own naming too.
function withAlias(attributes, def, displayName) {
  const alias = def.nameAttribute && def.nameAttribute !== 'displayName' ? def.nameAttribute : null;
  return alias ? { ...attributes, [alias]: displayName } : { ...attributes };
}

// A `multi` attribute (an enrichment's "expertises: IAM, Azure") is stored as the
// list of its values, so a filter can ask for any one of them.
function readAttributes(row, def) {
  const attributes = {};
  for (const a of def.attributes) {
    const v = cell(row, a.column);
    if (v !== '') attributes[a.name] = a.multi ? splitMulti(v) : v;
  }
  return attributes;
}

// Every value of a multi-valued cell: a SharePoint lookup's names, else the parts
// between ; , | or line breaks — trimmed, blanks and repeats left out, in cell order.
export function splitMulti(value) {
  const parts = splitSharePointLookup(value) ?? value.split(/[;,|\n]/).map(p => p.trim()).filter(Boolean);
  return [...new Set(parts)];
}

const sameValue = (a, b) => (Array.isArray(a) || Array.isArray(b) ? JSON.stringify(a) === JSON.stringify(b) : a === b);

// The fields on which `incoming` contradicts `existing` (both non-blank, different).
function conflicts(existing, incoming) {
  const out = [];
  if (existing.displayName !== incoming.displayName) out.push('name');
  for (const [k, v] of Object.entries(incoming.attributes)) {
    if (existing.attributes[k] !== undefined && !sameValue(existing.attributes[k], v)) out.push(k);
  }
  return out;
}

function mergeEntity(existing, incoming, issues) {
  const diff = conflicts(existing, incoming);
  if (diff.length > 0) {
    issues.push({
      kind: 'duplicateKey', entityType: incoming.entityType, row: incoming.row,
      detail: `${incoming.entityType} "${incoming.canonicalKey}" was already on row ${existing.row}; this row differs in ${diff.join(', ')}; the first row is kept.`,
    });
  }
  for (const [k, v] of Object.entries(incoming.attributes)) {
    if (existing.attributes[k] === undefined) existing.attributes[k] = v;
  }
}

const splitList = (v) => v.split(/[;,]/).map(p => p.trim()).filter(Boolean);

// "ann@contoso.com; bob@contoso.com" → both addresses; anything else → [value].
// Only a cell whose every part is an e-mail address is split: "Smith, Ann" is
// one name, not two.
export function splitEmails(value) {
  const parts = splitList(value);
  return parts.length > 1 && parts.every(isEmailLike) ? parts : [value];
}

// A SharePoint lookup export: "Ann Example;#27;#Bob Example;#16" — names and
// their item ids alternate, separated by ";#". The ids are dropped.
const SP_LOOKUP = ';#';
export function splitSharePointLookup(value) {
  if (!value.includes(SP_LOOKUP)) return null;
  const parts = value.split(SP_LOOKUP).map(p => p.trim()).filter(p => p && !/^\d+$/.test(p));
  return parts.length > 0 ? parts : null;
}

// Every value a cell holds: SharePoint lookups split on ";#", lists of
// addresses on ";" or ","; anything else is one value.
export function splitValues(value) {
  return splitSharePointLookup(value) ?? splitEmails(value);
}

// The (name, key) pairs one definition yields on one row. Normally one; a key
// cell holding several values (addresses, or a SharePoint lookup) yields one
// per value. The names pair up with the keys when the name cell splits into as
// many parts — or is the same column; otherwise each key is its own name.
function namesAndKeys(def, displayName, keyValue) {
  const keys = splitValues(keyValue);
  if (keys.length === 1) return [{ displayName: splitValues(displayName)[0], canonicalKey: keys[0].toLowerCase() }];
  const names = def.nameColumn === def.keyColumn ? keys : (splitSharePointLookup(displayName) ?? splitList(displayName));
  const paired = names.length === keys.length;
  return keys.map((k, i) => ({ displayName: paired ? names[i] : k, canonicalKey: k.toLowerCase() }));
}

// The key of a row: the keyColumn cell, or for a composite key the cells of
// keyColumns joined (empty only when every one of them is empty).
function keyOf(row, def) {
  if (!def.keyColumns) return cell(row, def.keyColumn);
  const parts = def.keyColumns.map(c => cell(row, c));
  return parts.some(Boolean) ? parts.join(' | ') : '';
}

function instancesFromRow(row, rowNo, def, issues) {
  const displayName = cell(row, def.nameColumn);
  if (displayName === '') return [];
  const keyValue = keyOf(row, def);
  if (keyValue === '') {
    issues.push({
      kind: 'emptyKey', entityType: def.type, row: rowNo,
      detail: `${def.type} "${displayName}" has no value in key column "${(def.keyColumns ?? [def.keyColumn]).join(', ')}" and is left out.`,
    });
    return [];
  }
  // A composite key identifies one row; it is never a list of values to split.
  if (def.keyColumns) {
    return [{ entityType: def.type, displayName, canonicalKey: keyValue.toLowerCase(), attributes: withAlias(readAttributes(row, def), def, displayName), sourceLocator: `row:${rowNo}`, row: rowNo }];
  }
  const attributes = readAttributes(row, def);
  return namesAndKeys(def, displayName, keyValue).map(nk => ({
    entityType: def.type, ...nk,
    attributes: withAlias(attributes, def, nk.displayName), sourceLocator: `row:${rowNo}`, row: rowNo,
  }));
}

function addRelation(rel, onRow, rowNo, out) {
  const fromKeys = onRow.get(rel.from) ?? [];
  const toKeys = onRow.get(rel.to) ?? [];
  if (fromKeys.length === 0 || toKeys.length === 0) {
    if (fromKeys.length === toKeys.length) return; // neither side on this row
    const missing = fromKeys.length === 0 ? rel.from : rel.to;
    const present = fromKeys.length === 0 ? rel.to : rel.from;
    out.issues.push({
      kind: 'missingSide', entityType: missing, row: rowNo,
      detail: `Row ${rowNo} has a ${present} but no ${missing}, so "${rel.predicate}" (${rel.from} → ${rel.to}) is not recorded for it.`,
    });
    return;
  }
  if (rel.from === rel.to) return;
  for (const fromKey of fromKeys) {
    for (const toKey of toKeys) {
      const key = [rel.predicate, rel.from, fromKey, rel.to, toKey].join(SEP);
      if (out.relationIndex.has(key)) continue;
      out.relationIndex.set(key, {
        predicate: rel.predicate, fromType: rel.from, fromKey, toType: rel.to, toKey,
        sourceLocator: `row:${rowNo}`, row: rowNo,
      });
    }
  }
}

export function applyRecipe(rows, recipe) {
  const entityIndex = new Map();
  const out = { relationIndex: new Map(), issues: [] };
  rows.forEach((row, i) => {
    const rowNo = i + 1;
    const onRow = new Map();
    for (const def of recipe.entities) {
      const keys = [];
      for (const inst of instancesFromRow(row, rowNo, def, out.issues)) {
        keys.push(inst.canonicalKey);
        const k = entityKey(inst.entityType, inst.canonicalKey);
        const existing = entityIndex.get(k);
        if (existing) mergeEntity(existing, inst, out.issues);
        else entityIndex.set(k, inst);
      }
      onRow.set(def.type, keys);
    }
    for (const rel of recipe.relations) addRelation(rel, onRow, rowNo, out);
  });
  return { entities: [...entityIndex.values()], relations: [...out.relationIndex.values()], issues: out.issues };
}

const countBy = (items, field) => {
  const counts = {};
  for (const it of items) counts[it[field]] = (counts[it[field]] ?? 0) + 1;
  return counts;
};

export function summarizeApplied({ entities, relations, issues }, recipe) {
  const byType = {};
  for (const def of recipe.entities) byType[def.type] = { total: 0, duplicateKeys: 0, emptyKeys: 0 };
  for (const e of entities) byType[e.entityType].total++;
  for (const issue of issues) {
    if (issue.kind === 'duplicateKey') byType[issue.entityType].duplicateKeys++;
    else if (issue.kind === 'emptyKey') byType[issue.entityType].emptyKeys++;
  }
  const byPredicate = {};
  for (const rel of recipe.relations) byPredicate[rel.predicate] = 0;
  Object.assign(byPredicate, countBy(relations, 'predicate'));
  return { entities: byType, relations: byPredicate };
}
