// Parse the core ontology (Turtle) and flatten it into a plain model the checks,
// the Mermaid generator and the reference-doc generator all read.
//
// Parsing is N3.js (rdfjs, MIT) — a maintained, dependency-light RDF library —
// so a syntax error is reported by a real Turtle parser, not a regex.

import { Parser, Store } from 'n3';
import { DECLARATION_KINDS, IA, OWL, RDFS, TYPE, localName } from './vocabulary.js';

const P = {
  label: `${RDFS}label`,
  comment: `${RDFS}comment`,
  definedBy: `${RDFS}isDefinedBy`,
  subClassOf: `${RDFS}subClassOf`,
  domain: `${RDFS}domain`,
  range: `${RDFS}range`,
  unionOf: `${OWL}unionOf`,
  deprecated: `${OWL}deprecated`,
  versionInfo: `${OWL}versionInfo`,
};
const ia = (name) => `${IA}${name}`;

// Annotations that must carry at most one value per term. Two different values
// (two labels, two typeValues) is a conflicting definition — check 6.
export const SINGLE_VALUED = [
  P.label, P.comment, ia('typeValue'), ia('sqlType'), ia('table'), ia('identifierColumn'),
  ia('identifierSqlType'), ia('discriminator'), ia('typeColumn'), ia('storedIn'), ia('valueScheme'), ia('denotesClass'), ia('status'),
];

/**
 * Parse Turtle text. Returns { store } or { errors } — never throws, so the
 * CLI and the tests report a syntax error as an ordinary check failure.
 */
export function parseOntology(text, source = 'ontology') {
  try {
    const quads = new Parser({ format: 'text/turtle' }).parse(text);
    return { store: new Store(quads) };
  } catch (err) {
    return { errors: [{ code: 'syntax', subject: source, message: `Turtle syntax error: ${err.message}` }] };
  }
}

function values(store, s, p) {
  return store.getObjects(s, p, null).map(o => o.value);
}

// A domain / range is either one named class or an owl:unionOf list of them.
function resolveClassSet(store, lists, term) {
  if (term.termType === 'NamedNode') return [term.value];
  const union = store.getObjects(term, P.unionOf, null)[0];
  const items = union ? lists[union.value] : null;
  return items ? items.map(t => t.value) : [`_:${term.value}`];
}

function classSets(store, lists, s, p) {
  return store.getObjects(s, p, null).flatMap(o => resolveClassSet(store, lists, o));
}

const locals = (iris) => iris.map(i => localName(i) ?? i);
const first = (store, s, p) => values(store, s, p)[0];
const flag = (store, s, p) => values(store, s, p).includes('true');

function declarations(store) {
  const decl = new Map();
  for (const q of store.getQuads(null, TYPE, null, null)) {
    const kind = DECLARATION_KINDS[q.object.value];
    if (!kind || q.subject.termType !== 'NamedNode') continue;
    if (!decl.has(q.subject.value)) decl.set(q.subject.value, new Set());
    decl.get(q.subject.value).add(kind);
  }
  return decl;
}

function buildClass(store, iri) {
  return {
    iri, local: localName(iri),
    superClasses: locals(values(store, iri, P.subClassOf)),
    table: first(store, iri, ia('table')),
    identifierColumn: first(store, iri, ia('identifierColumn')),
    identifierSqlType: first(store, iri, ia('identifierSqlType')),
    ingestEntities: values(store, iri, ia('ingestEntity')),
    discriminator: first(store, iri, ia('discriminator')),
    openVocabulary: flag(store, iri, ia('openVocabulary')),
    typeColumn: first(store, iri, ia('typeColumn')),
    sourceProperties: locals(values(store, iri, ia('sourceProperty'))),
    targetProperties: locals(values(store, iri, ia('targetProperty'))),
    typeValue: first(store, iri, ia('typeValue')),
  };
}

function buildProperty(store, lists, iri, kind) {
  const ranges = classSets(store, lists, iri, P.range);
  return {
    iri, local: localName(iri), kind,
    domains: locals(classSets(store, lists, iri, P.domain)),
    ranges,
    rangeClasses: kind === 'object' ? locals(ranges) : [],
    sqlType: first(store, iri, ia('sqlType')),
    ingestAliases: values(store, iri, ia('ingestAlias')),
    typeValue: first(store, iri, ia('typeValue')),
    storedIn: localName(first(store, iri, ia('storedIn')) ?? '') ?? undefined,
    valueScheme: localName(first(store, iri, ia('valueScheme')) ?? '') ?? undefined,
  };
}

function buildIndividual(store, iri) {
  const types = store.getObjects(iri, TYPE, null).map(o => o.value).filter(v => !DECLARATION_KINDS[v]);
  return {
    iri, local: localName(iri),
    types: locals(types),
    typeValue: first(store, iri, ia('typeValue')),
    denotesClass: localName(first(store, iri, ia('denotesClass')) ?? '') ?? undefined,
  };
}

function common(store, iri) {
  return {
    label: first(store, iri, P.label),
    comment: first(store, iri, P.comment),
    definedBy: values(store, iri, P.definedBy),
    deprecated: flag(store, iri, P.deprecated),
    status: first(store, iri, ia('status')),
  };
}

const BUILDERS = {
  class: (store, lists, iri) => ['classes', buildClass(store, iri)],
  objectProperty: (store, lists, iri) => ['properties', buildProperty(store, lists, iri, 'object')],
  datatypeProperty: (store, lists, iri) => ['properties', buildProperty(store, lists, iri, 'datatype')],
  individual: (store, lists, iri) => ['individuals', buildIndividual(store, iri)],
};

// Every ia: IRI used anywhere — as subject, predicate or object. One that is
// used but never declared is a typo or a missing definition.
function mentionedIris(store) {
  const out = new Set();
  for (const q of store.getQuads(null, null, null, null)) {
    for (const t of [q.subject, q.predicate, q.object]) {
      if (t.termType === 'NamedNode' && t.value.startsWith(IA)) out.add(t.value);
    }
  }
  return out;
}

function multiValuedAnnotations(store) {
  const out = [];
  for (const s of store.getSubjects(null, null, null).filter(t => t.termType === 'NamedNode')) {
    for (const p of SINGLE_VALUED) {
      const vs = [...new Set(values(store, s, p))];
      if (vs.length > 1) out.push({ iri: s.value, predicate: p, values: vs });
    }
  }
  return out;
}

function addTerm(model, store, lists, iri, kinds) {
  if (kinds.has('annotationProperty')) model.annotationProperties.add(localName(iri));
  for (const kind of kinds) {
    const build = BUILDERS[kind];
    if (!build) continue;
    const [bucket, term] = build(store, lists, iri);
    model[bucket].set(term.local, { ...common(store, iri), ...term });
  }
}

/** Flatten a parsed store into { classes, properties, individuals, … } keyed by local name. */
export function buildModel(store) {
  const lists = store.extractLists();
  const onto = store.getSubjects(TYPE, `${OWL}Ontology`, null)[0];
  const model = {
    ontology: onto ? { iri: onto.value, version: first(store, onto, P.versionInfo) ?? null } : { iri: null, version: null },
    declarations: declarations(store),
    classes: new Map(), properties: new Map(), individuals: new Map(),
    annotationProperties: new Set(),
    multiValued: multiValuedAnnotations(store),
    mentioned: mentionedIris(store),
  };
  for (const [iri, kinds] of model.declarations) {
    // A term outside the namespace is reported by the integrity check; it is
    // not part of the core model, so it is not flattened into it.
    if (localName(iri) !== null) addTerm(model, store, lists, iri, kinds);
  }
  return model;
}

/** True when class `a` is `b` or a (transitive) subclass of it. */
export function isSubClassOf(model, a, b, seen = new Set()) {
  if (a === b) return true;
  if (seen.has(a)) return false;
  seen.add(a);
  const cls = model.classes.get(a);
  return !!cls && cls.superClasses.some(s => isSubClassOf(model, s, b, seen));
}

/** Classes that map to a table (the node and edge tables). */
export function tableClasses(model) {
  return [...model.classes.values()].filter(c => c.table);
}

/** Column properties (those with an ia:sqlType) whose domain includes `cls`. */
export function columnsOf(model, cls) {
  return [...model.properties.values()].filter(p => p.sqlType && p.domains.includes(cls));
}

/** Properties that are relationship types stored in the given edge class. */
export function relationshipTypesOf(model, edgeClass) {
  return [...model.properties.values()].filter(p => p.storedIn === edgeClass);
}

/** Named individuals of a value-scheme class. */
export function schemeMembers(model, scheme) {
  return [...model.individuals.values()].filter(i => i.types.includes(scheme));
}

/** Direct and indirect subclasses of `cls` that carry an ia:typeValue. */
export function typedSubclasses(model, cls) {
  return [...model.classes.values()].filter(c => c.typeValue && c.local !== cls && isSubClassOf(model, c.local, cls));
}

/**
 * The closed list of values a column may hold on a given class, or null when
 * the ontology declares none (free text, or an open vocabulary).
 *   - the edge class's type column  → typeValues of its relationship properties
 *   - a closed discriminator         → typeValues of the typed subclasses
 *   - a property with a valueScheme  → typeValues of the scheme's individuals
 */
export function valueSetFor(model, cls, column) {
  const c = model.classes.get(cls);
  if (c?.typeColumn === column) return relationshipTypesOf(model, cls).map(p => p.typeValue);
  if (c?.discriminator === column) return c.openVocabulary ? null : typedSubclasses(model, cls).map(s => s.typeValue);
  const prop = model.properties.get(column);
  if (prop?.valueScheme && prop.domains.includes(cls)) return schemeMembers(model, prop.valueScheme).map(i => i.typeValue);
  return null;
}
