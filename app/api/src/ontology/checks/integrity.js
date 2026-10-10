// Integrity of the ontology on its own — no implementation involved.
//
// Covers check 6 of the spec (no duplicate or conflicting identifiers) plus the
// structural rules every other check relies on: each term is declared once,
// described, defined by the core ontology, references only declared terms, and
// follows the naming conventions that make IRIs derivable from the database.

import { ONTOLOGY_IRI, SQL_TO_XSD, localName, shortIri } from '../vocabulary.js';
import { isSubClassOf, relationshipTypesOf, schemeMembers, typedSubclasses } from '../model.js';

const err = (code, subject, message) => ({ code, subject, message });

function checkHeader(model) {
  const out = [];
  if (model.ontology.iri !== ONTOLOGY_IRI) {
    out.push(err('ontology-header', 'ontology', `expected one owl:Ontology <${ONTOLOGY_IRI}>, found ${model.ontology.iri ?? 'none'}`));
  }
  if (!model.ontology.version) out.push(err('ontology-header', 'ontology', 'the ontology has no owl:versionInfo'));
  return out;
}

// A term declared as two kinds (a class that is also a property, …) is a conflict.
function checkDeclarations(model) {
  const out = [];
  for (const [iri, kinds] of model.declarations) {
    if (kinds.size > 1) out.push(err('conflicting-declaration', shortIri(iri), `declared as ${[...kinds].sort().join(' and ')}`));
    // Declaring an external annotation property (dcterms:title) only tells OWL
    // tools its kind; defining a class or property elsewhere is not allowed.
    const foreign = localName(iri) === null && [...kinds].some(k => k !== 'annotationProperty');
    if (foreign) out.push(err('foreign-term', iri, 'the core ontology declares a term outside https://identityatlas.io/ontology#'));
  }
  for (const iri of model.mentioned) {
    if (!model.declarations.has(iri)) out.push(err('undeclared-term', shortIri(iri), 'used but never declared'));
  }
  for (const m of model.multiValued) {
    out.push(err('conflicting-annotation', shortIri(m.iri), `${shortIri(m.predicate)} has ${m.values.length} different values: ${m.values.join(' | ')}`));
  }
  return out;
}

// IRIs are case-sensitive, people are not: two classes (or two properties, or
// two individuals) that differ only in case are a trap. Across kinds the case
// difference is the OWL convention itself — class ia:AssignmentType holds the
// values of property ia:assignmentType — so that is allowed.
function checkCaseCollisions(model) {
  const seen = new Map();
  const out = [];
  for (const [iri, kinds] of model.declarations) {
    const local = localName(iri);
    if (local === null) continue;
    const key = `${[...kinds].sort().join('+')}:${local.toLowerCase()}`;
    if (seen.has(key)) out.push(err('duplicate-identifier', `ia:${local}`, `differs from ia:${seen.get(key)} only in letter case`));
    else seen.set(key, local);
  }
  return out;
}

function allTerms(model) {
  return [
    ...[...model.classes.values()],
    ...[...model.properties.values()],
    ...[...model.individuals.values()],
  ];
}

function checkDescriptions(model) {
  const out = [];
  for (const t of allTerms(model)) {
    const s = `ia:${t.local}`;
    if (!t.label) out.push(err('missing-label', s, 'has no rdfs:label'));
    if (!t.comment) out.push(err('missing-description', s, 'has no rdfs:comment'));
    if (!t.definedBy.includes(ONTOLOGY_IRI)) out.push(err('not-defined-by-core', s, `is not rdfs:isDefinedBy <${ONTOLOGY_IRI}>`));
  }
  return out;
}

// [subject, via, target, expected kind] for every reference a term makes.
const ref = (term, via, kind) => (target) => [`ia:${term.local}`, via, target, kind];
const optional = (v) => (v ? [v] : []);

function refs(model) {
  const classes = [...model.classes.values()].flatMap(c => [
    ...c.superClasses.map(ref(c, 'rdfs:subClassOf', 'class')),
    ...[...c.sourceProperties, ...c.targetProperties].map(ref(c, 'ia:source/targetProperty', 'property')),
  ]);
  const properties = [...model.properties.values()].flatMap(p => [
    ...p.domains.map(ref(p, 'rdfs:domain', 'class')),
    ...p.rangeClasses.map(ref(p, 'rdfs:range', 'class')),
    ...optional(p.storedIn).map(ref(p, 'ia:storedIn', 'class')),
    ...optional(p.valueScheme).map(ref(p, 'ia:valueScheme', 'class')),
  ]);
  const individuals = [...model.individuals.values()].flatMap(i => [
    ...i.types.map(ref(i, 'rdf:type', 'class')),
    ...optional(i.denotesClass).map(ref(i, 'ia:denotesClass', 'class')),
  ]);
  return [...classes, ...properties, ...individuals];
}

function checkReferences(model) {
  const bucket = { class: model.classes, property: model.properties };
  return refs(model)
    .filter(([, , target, kind]) => !bucket[kind].has(target))
    .map(([s, via, target, kind]) => err('undeclared-reference', s, `${via} ${target} is not a declared ${kind}`));
}

function checkColumnProperty(model, p) {
  const s = `ia:${p.local}`;
  const out = [];
  if (!(p.sqlType in SQL_TO_XSD)) return [err('unknown-sql-type', s, `ia:sqlType "${p.sqlType}" is not a type the model maps`)];
  if (p.label !== p.local) out.push(err('naming-convention', s, `a column property's rdfs:label must be the column name "${p.local}"`));
  if (p.domains.length === 0) out.push(err('missing-domain', s, 'a column property needs rdfs:domain (the classes whose table has it)'));
  for (const d of p.domains) {
    if (!model.classes.get(d)?.table) out.push(err('domain-not-a-table', s, `domain ia:${d} does not map to a table`));
  }
  if (p.kind === 'datatype' && (p.ranges.length !== 1 || p.ranges[0] !== SQL_TO_XSD[p.sqlType])) {
    out.push(err('range-type-mismatch', s, `ia:sqlType "${p.sqlType}" needs rdfs:range ${shortIri(SQL_TO_XSD[p.sqlType])}, found ${p.ranges.map(shortIri).join(', ') || 'none'}`));
  }
  return out;
}

// A foreign key must point at classes whose identifier has the same SQL type.
function checkForeignKey(model, p) {
  const out = [];
  for (const r of p.rangeClasses) {
    const target = model.classes.get(r);
    if (!target?.identifierColumn) out.push(err('fk-target-not-a-node', `ia:${p.local}`, `range ia:${r} has no ia:identifierColumn`));
    else if (target.identifierSqlType !== p.sqlType) {
      out.push(err('fk-type-mismatch', `ia:${p.local}`, `a ${p.sqlType} column cannot reference ia:${r}, whose identifier is ${target.identifierSqlType}`));
    }
  }
  return out;
}

const lowerCamel = (s) => s.charAt(0).toLowerCase() + s.slice(1);

function checkRelationshipProperty(model, p) {
  const s = `ia:${p.local}`;
  const out = [];
  const edge = model.classes.get(p.storedIn);
  if (!edge?.typeColumn) out.push(err('stored-in-not-typed-edge', s, `ia:storedIn ia:${p.storedIn} is not an edge class with ia:typeColumn`));
  if (!p.typeValue) out.push(err('missing-type-value', s, 'a relationship type needs ia:typeValue (the stored string)'));
  else if (p.local !== lowerCamel(p.typeValue)) out.push(err('naming-convention', s, `relationship type "${p.typeValue}" must be named ia:${lowerCamel(p.typeValue)}`));
  if (p.domains.length === 0 || p.rangeClasses.length === 0) out.push(err('missing-domain', s, 'a relationship type needs rdfs:domain and rdfs:range'));
  return out;
}

function checkProperties(model) {
  const out = [];
  for (const p of model.properties.values()) {
    if (p.sqlType) {
      out.push(...checkColumnProperty(model, p));
      if (p.kind === 'object') out.push(...checkForeignKey(model, p));
    } else if (p.storedIn) {
      out.push(...checkRelationshipProperty(model, p));
    } else {
      out.push(err('unmapped-property', `ia:${p.local}`, 'is neither a column (ia:sqlType) nor a relationship type (ia:storedIn)'));
    }
  }
  return out;
}

function duplicates(values) {
  const seen = new Set();
  return values.filter(v => (seen.has(v) ? true : (seen.add(v), false)));
}

function checkTypeValues(model) {
  const out = [];
  const groups = [];
  for (const c of model.classes.values()) {
    if (c.discriminator) groups.push([`ia:${c.local}.${c.discriminator}`, typedSubclasses(model, c.local).map(x => x.typeValue)]);
    if (c.typeColumn) groups.push([`ia:${c.local}.${c.typeColumn}`, relationshipTypesOf(model, c.local).map(x => x.typeValue)]);
  }
  const schemes = new Set([...model.properties.values()].map(p => p.valueScheme).filter(Boolean));
  for (const s of schemes) groups.push([`ia:${s}`, schemeMembers(model, s).map(i => i.typeValue)]);
  for (const [subject, values] of groups) {
    for (const d of duplicates(values)) out.push(err('duplicate-type-value', subject, `the stored value "${d}" is defined twice`));
  }
  for (const c of model.classes.values()) {
    const rooted = c.typeValue && [...model.classes.values()].some(r => r.discriminator && r.local !== c.local && isSubClassOf(model, c.local, r.local));
    if (c.typeValue && !rooted) out.push(err('orphan-type-value', `ia:${c.local}`, 'has ia:typeValue but no superclass declares an ia:discriminator'));
  }
  return out;
}

function checkIndividuals(model) {
  const out = [];
  for (const i of model.individuals.values()) {
    const s = `ia:${i.local}`;
    if (!i.typeValue) { out.push(err('missing-type-value', s, 'a value-list member needs ia:typeValue')); continue; }
    const scheme = i.types[0];
    if (i.types.length !== 1) out.push(err('individual-type', s, 'must be a member of exactly one value list'));
    else if (i.local !== `${scheme}_${i.typeValue}`) out.push(err('naming-convention', s, `must be named ia:${scheme}_${i.typeValue}`));
    if (i.denotesClass && !model.classes.get(i.denotesClass)?.table) out.push(err('denotes-non-table', s, `ia:denotesClass ia:${i.denotesClass} does not map to a table`));
  }
  return out;
}

function checkEdges(model) {
  const out = [];
  for (const c of model.classes.values()) {
    if (!isSubClassOf(model, c.local, 'Edge') || c.local === 'Edge') continue;
    const s = `ia:${c.local}`;
    if (!c.table) out.push(err('edge-without-table', s, 'an edge class must map to a table'));
    if (c.sourceProperties.length === 0 || c.targetProperties.length === 0) out.push(err('edge-endpoints', s, 'needs ia:sourceProperty and ia:targetProperty'));
    for (const e of [...c.sourceProperties, ...c.targetProperties]) {
      const p = model.properties.get(e);
      if (p && !(p.kind === 'object' && p.domains.includes(c.local))) out.push(err('edge-endpoints', s, `endpoint ia:${e} must be a foreign key of this table`));
    }
  }
  return out;
}

/** All structural checks. Returns a list of { code, subject, message }. */
export function checkIntegrity(model) {
  return [
    ...checkHeader(model),
    ...checkDeclarations(model),
    ...checkCaseCollisions(model),
    ...checkDescriptions(model),
    ...checkReferences(model),
    ...checkProperties(model),
    ...checkTypeValues(model),
    ...checkIndividuals(model),
    ...checkEdges(model),
  ];
}
