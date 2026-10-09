// Organisation truth — apply a recipe to the rows of a list. Pure: no I/O.
//
//   applyRecipe(rows, recipe) → { entities, relations, issues }
//
// `recipe` must be normalised (contracts.js normalizeRecipe: every entity has
// a keyColumn, every attribute a name). `rows` are parse.js rows; row i of the
// array is data row i + 1.
//
// entities:  { entityType, canonicalKey, displayName, attributes, sourceLocator, row }
//   One instance per entity definition per row whose nameColumn is non-blank.
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
const SEP = '\u0000';

const cell = (row, column) => String(row?.[column] ?? '').trim();
export const entityKey = (type, key) => `${type}${SEP}${key}`;

function readAttributes(row, def) {
  const attributes = {};
  for (const a of def.attributes) {
    const v = cell(row, a.column);
    if (v !== '') attributes[a.name] = v;
  }
  return attributes;
}

// The fields on which `incoming` contradicts `existing` (both non-blank, different).
function conflicts(existing, incoming) {
  const out = [];
  if (existing.displayName !== incoming.displayName) out.push('name');
  for (const [k, v] of Object.entries(incoming.attributes)) {
    if (existing.attributes[k] !== undefined && existing.attributes[k] !== v) out.push(k);
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

function instanceFromRow(row, rowNo, def, issues) {
  const displayName = cell(row, def.nameColumn);
  if (displayName === '') return null;
  const canonicalKey = cell(row, def.keyColumn).toLowerCase();
  if (canonicalKey === '') {
    issues.push({
      kind: 'emptyKey', entityType: def.type, row: rowNo,
      detail: `${def.type} "${displayName}" has no value in key column "${def.keyColumn}" and is left out.`,
    });
    return null;
  }
  return {
    entityType: def.type, canonicalKey, displayName,
    attributes: readAttributes(row, def), sourceLocator: `row:${rowNo}`, row: rowNo,
  };
}

function addRelation(rel, onRow, rowNo, out) {
  const fromKey = onRow.get(rel.from);
  const toKey = onRow.get(rel.to);
  if (fromKey === undefined || toKey === undefined) {
    if (fromKey === toKey) return; // neither side on this row
    const missing = fromKey === undefined ? rel.from : rel.to;
    const present = fromKey === undefined ? rel.to : rel.from;
    out.issues.push({
      kind: 'missingSide', entityType: missing, row: rowNo,
      detail: `Row ${rowNo} has a ${present} but no ${missing}, so "${rel.predicate}" (${rel.from} → ${rel.to}) is not recorded for it.`,
    });
    return;
  }
  if (rel.from === rel.to) return;
  const key = [rel.predicate, rel.from, fromKey, rel.to, toKey].join(SEP);
  if (out.relationIndex.has(key)) return;
  const relation = {
    predicate: rel.predicate, fromType: rel.from, fromKey, toType: rel.to, toKey,
    sourceLocator: `row:${rowNo}`, row: rowNo,
  };
  out.relationIndex.set(key, relation);
}

export function applyRecipe(rows, recipe) {
  const entityIndex = new Map();
  const out = { relationIndex: new Map(), issues: [] };
  rows.forEach((row, i) => {
    const rowNo = i + 1;
    const onRow = new Map();
    for (const def of recipe.entities) {
      const inst = instanceFromRow(row, rowNo, def, out.issues);
      if (!inst) continue;
      onRow.set(def.type, inst.canonicalKey);
      const k = entityKey(inst.entityType, inst.canonicalKey);
      const existing = entityIndex.get(k);
      if (existing) mergeEntity(existing, inst, out.issues);
      else entityIndex.set(k, inst);
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
