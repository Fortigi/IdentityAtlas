// IRIs and fixed mappings the ontology tooling shares.
//
// The ontology itself lives in /ontology/core.ttl (repo root). These constants
// are the vocabulary the validator reads it with — not a second copy of the
// model: nothing here names a table, a column or a type value.

export const IA = 'https://identityatlas.io/ontology#';
export const ONTOLOGY_IRI = 'https://identityatlas.io/ontology';

export const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
export const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
export const OWL = 'http://www.w3.org/2002/07/owl#';
export const XSD = 'http://www.w3.org/2001/XMLSchema#';

export const TYPE = `${RDF}type`;

// The kinds of declaration a term can carry. A term declared as two of these
// is a conflict (check 6), so the set is closed here.
export const DECLARATION_KINDS = {
  [`${OWL}Class`]: 'class',
  [`${OWL}ObjectProperty`]: 'objectProperty',
  [`${OWL}DatatypeProperty`]: 'datatypeProperty',
  [`${OWL}AnnotationProperty`]: 'annotationProperty',
  [`${OWL}NamedIndividual`]: 'individual',
};

// PostgreSQL data_type (as information_schema reports it) → the XSD / RDF
// datatype a column of that type must declare as rdfs:range. A uuid that is NOT
// a foreign key into a core table is an opaque string.
export const SQL_TO_XSD = {
  'text': `${XSD}string`,
  'uuid': `${XSD}string`,
  'integer': `${XSD}integer`,
  'boolean': `${XSD}boolean`,
  'jsonb': `${RDF}JSON`,
  'timestamp with time zone': `${XSD}dateTime`,
  'bytea': `${XSD}base64Binary`,
};

// Ingest field types (validation.js SCHEMAS) → the SQL types they can land in.
// A dateTime arrives as an ISO string; a photo arrives base64-encoded.
export const INGEST_TO_SQL = {
  string: ['text', 'timestamp with time zone'],
  uuid: ['uuid'],
  boolean: ['boolean'],
  json: ['jsonb'],
  number: ['integer'],
  base64: ['bytea'],
};

/** Local name of an ia: IRI, or null for an IRI outside the namespace. */
export function localName(iri) {
  return typeof iri === 'string' && iri.startsWith(IA) ? iri.slice(IA.length) : null;
}

/** Shorten any IRI for messages: ia:Foo, xsd:string, or the IRI itself. */
export function shortIri(iri) {
  const prefixes = [['ia:', IA], ['xsd:', XSD], ['rdf:', RDF], ['rdfs:', RDFS], ['owl:', OWL]];
  for (const [p, ns] of prefixes) if (iri.startsWith(ns)) return p + iri.slice(ns.length);
  return iri;
}
