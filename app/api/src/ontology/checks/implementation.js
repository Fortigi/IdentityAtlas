// Agreement between the ontology and the implementation's own registries.
//
// Checks 2–5 of the spec, deterministically, against the constants the code
// enforces (see ../registry.js):
//   2. every core ingest entity type is a class, and every other one is
//      explicitly declared out of scope;
//   3. every relationship / assignment / principal / context value list the
//      ingest enforces is exactly the list the ontology declares — in both
//      directions, so an undocumented new relationship type fails;
//   4. relationship definitions agree with the model: endpoints, ownership,
//      polymorphic targets;
//   5. every ingest field of a core entity is a described column (or a declared
//      alias of one) with a compatible type.

import { INGEST_TO_SQL } from '../vocabulary.js';
import {
  columnsOf, isSubClassOf, relationshipTypesOf, schemeMembers, tableClasses, typedSubclasses, valueSetFor,
} from '../model.js';

const err = (code, subject, message) => ({ code, subject, message });

function setDiff(expected, actual) {
  const a = new Set(actual);
  const e = new Set(expected);
  return { missing: [...e].filter(v => !a.has(v)), extra: [...a].filter(v => !e.has(v)) };
}

// Fields are compared by enum first: a closed list in the code must be the same
// closed list in the ontology, or the two disagree about what may be stored.
function checkEnum(model, cls, entity, name, field) {
  const subject = `${entity}.${name}`;
  const declared = valueSetFor(model, cls.local, name);
  if (field.enum && declared === null) {
    return [err('value-list-not-in-ontology', subject, `the ingest accepts only [${field.enum.join(', ')}] but the ontology declares no closed list for ia:${cls.local}.${name}`)];
  }
  if (!field.enum && declared !== null) {
    return [err('value-list-not-enforced', subject, `the ontology declares a closed list [${declared.join(', ')}] but the ingest accepts any value`)];
  }
  if (!field.enum) return [];
  const { missing, extra } = setDiff(field.enum, declared);
  const out = [];
  if (missing.length) out.push(err('value-missing-from-ontology', subject, `accepted by the ingest but not defined in the ontology: ${missing.join(', ')}`));
  if (extra.length) out.push(err('value-not-in-implementation', subject, `defined in the ontology but rejected by the ingest: ${extra.join(', ')}`));
  return out;
}

function checkField(model, cls, entity, name, field) {
  if (name === cls.identifierColumn) {
    const ok = (INGEST_TO_SQL[field.type] ?? []).includes(cls.identifierSqlType);
    return ok ? [] : [err('ingest-type-mismatch', `${entity}.${name}`, `the ingest validates the identifier as ${field.type} but it is ${cls.identifierSqlType}`)];
  }
  const column = columnsOf(model, cls.local).find(p => p.local === name);
  if (column) {
    const ok = (INGEST_TO_SQL[field.type] ?? []).includes(column.sqlType);
    const typeErr = ok ? [] : [err('ingest-type-mismatch', `${entity}.${name}`, `the ingest validates it as ${field.type} but the column is ${column.sqlType}`)];
    return [...typeErr, ...checkEnum(model, cls, entity, name, field)];
  }
  const aliased = columnsOf(model, cls.local).some(p => p.ingestAliases.includes(name));
  if (aliased) return [];
  return [err('ingest-field-unmapped', `${entity}.${name}`, `the ingest accepts "${name}" for ${cls.table} but it is neither a column of ia:${cls.local} nor an ia:ingestAlias of one`)];
}

function checkEntityClass(model, registry, cls) {
  const out = [];
  for (const entity of cls.ingestEntities) {
    const schema = registry.ingest[entity];
    if (!schema) { out.push(err('unknown-ingest-entity', `ia:${cls.local}`, `ia:ingestEntity "${entity}" is not an ingest entity type`)); continue; }
    if (schema.table !== cls.table) out.push(err('ingest-table-mismatch', entity, `writes ${schema.table}, but ia:${cls.local} maps to ${cls.table}`));
    for (const [name, field] of Object.entries(schema.fields)) out.push(...checkField(model, cls, entity, name, field));
  }
  return out;
}

// Every ingest entity type is either a core class or declared out of scope.
function checkEntityCoverage(model, registry, config) {
  const claimed = new Set(tableClasses(model).flatMap(c => c.ingestEntities));
  const outOfScope = config.outOfScopeIngestEntities ?? {};
  const out = [];
  for (const entity of Object.keys(registry.ingest)) {
    if (claimed.has(entity) && entity in outOfScope) out.push(err('scope-conflict', entity, 'is both a core class and declared out of scope'));
    if (!claimed.has(entity) && !(entity in outOfScope)) {
      out.push(err('ingest-entity-unclassified', entity, `the ingest API accepts "${entity}" (table ${registry.ingest[entity].table}) but no ontology class claims it and ontology/validation.json does not declare it out of scope`));
    }
  }
  for (const entity of Object.keys(outOfScope)) {
    if (!(entity in registry.ingest)) out.push(err('stale-out-of-scope', entity, 'is declared out of scope but is no longer an ingest entity type'));
  }
  return out;
}

function checkTypeLists(model, lists, rootClass) {
  const known = new Set(typedSubclasses(model, rootClass).map(c => c.typeValue));
  const out = [];
  for (const [source, values] of Object.entries(lists)) {
    for (const v of values) {
      if (!known.has(v)) out.push(err('registry-type-undefined', `${rootClass}:${v}`, `${source} names "${v}", which is not a subclass of ia:${rootClass} in the ontology`));
    }
  }
  return out;
}

function checkOwnership(model, registry) {
  const out = [];
  const declared = typedSubclasses(model, 'OwnershipResource').map(c => c.typeValue);
  const { missing, extra } = setDiff(registry.ownership.resourceTypes, declared);
  for (const v of missing) out.push(err('ownership-type-missing', `Resource:${v}`, `lib/ownershipTypes.js lists "${v}" but it is not a subclass of ia:OwnershipResource`));
  for (const v of extra) out.push(err('ownership-type-extra', `Resource:${v}`, `ia:OwnershipResource has "${v}" but lib/ownershipTypes.js does not list it, so consumers would count it as access`));

  const ownershipRels = relationshipTypesOf(model, 'ResourceRelationship')
    .filter(p => p.rangeClasses.length > 0 && p.rangeClasses.every(r => isSubClassOf(model, r, 'OwnershipResource')))
    .map(p => p.typeValue);
  const rel = setDiff(registry.ownership.relationshipTypes, ownershipRels);
  for (const v of rel.missing) out.push(err('ownership-relationship-range', `ResourceRelationship:${v}`, `lib/ownershipTypes.js treats "${v}" as an ownership link but its range is not an ownership resource`));
  for (const v of rel.extra) out.push(err('ownership-relationship-unlisted', `ResourceRelationship:${v}`, `"${v}" points at ownership resources but lib/ownershipTypes.js does not list it`));
  return out;
}

const fitsAny = (model, cls, candidates) => candidates.some(c => isSubClassOf(model, cls, c));

// A relationship type stored in an edge table must connect what that table connects.
function checkRelationshipEndpoints(model) {
  const out = [];
  for (const edge of tableClasses(model).filter(c => c.typeColumn)) {
    const sources = edge.sourceProperties.flatMap(p => model.properties.get(p)?.rangeClasses ?? []);
    const targets = edge.targetProperties.flatMap(p => model.properties.get(p)?.rangeClasses ?? []);
    for (const rel of relationshipTypesOf(model, edge.local)) {
      const badFrom = rel.domains.filter(d => !fitsAny(model, d, sources));
      const badTo = rel.rangeClasses.filter(r => !fitsAny(model, r, targets));
      if (badFrom.length || badTo.length) {
        out.push(err('relationship-endpoint-mismatch', `ia:${rel.local}`, `${edge.table} links ${sources.join('|')} → ${targets.join('|')}, but "${rel.typeValue}" is declared ${rel.domains.join('|')} → ${rel.rangeClasses.join('|')}`));
      }
    }
  }
  return out;
}

// A polymorphic target (ContextMembers.memberId) is only interpretable through
// the column that names its kind; the two must list the same classes.
function checkPolymorphicTargets(model) {
  const out = [];
  for (const edge of tableClasses(model)) {
    for (const t of edge.targetProperties.map(p => model.properties.get(p)).filter(p => p?.rangeClasses.length > 1)) {
      const kindColumns = columnsOf(model, edge.local).filter(p => p.valueScheme && schemeMembers(model, p.valueScheme).every(i => i.denotesClass));
      const denoted = kindColumns.length === 1 ? schemeMembers(model, kindColumns[0].valueScheme).map(i => i.denotesClass) : [];
      const { missing, extra } = setDiff(t.rangeClasses, denoted);
      if (kindColumns.length !== 1 || missing.length || extra.length) {
        out.push(err('polymorphic-target-mismatch', `ia:${t.local}`, `targets ${t.rangeClasses.join('|')} but the kind column of ${edge.table} names ${denoted.join('|') || 'nothing'}`));
      }
    }
  }
  return out;
}

/** All implementation-agreement checks. */
export function checkImplementation(model, registry, config = {}) {
  return [
    ...tableClasses(model).flatMap(c => checkEntityClass(model, registry, c)),
    ...checkEntityCoverage(model, registry, config),
    ...checkTypeLists(model, registry.resourceTypeLists, 'Resource'),
    ...checkTypeLists(model, registry.principalTypeLists, 'Principal'),
    ...checkOwnership(model, registry),
    ...checkRelationshipEndpoints(model),
    ...checkPolymorphicTargets(model),
  ];
}
