// The ONE place where analytics field ids meet the Core Ontology.
//
// An analytics field id is `<Class>.<property>` (`Principal.accountEnabled`).
// Its IRI is the ontology namespace + the property's local name. The local
// names below are PROVISIONAL: the Core Ontology (Feature 1, branch
// feature/core-ontology) had not landed when this was written. When it does,
// this table is validated against — or generated from — its Turtle file, and
// nothing else in analytics/ needs to change.
//
// Discovered `extendedAttributes` keys are per-install vocabulary and have no
// core IRI (the RDF/OWL note proposes a per-install namespace for them), so
// iriFor() returns null for `<Class>.ext.<key>` ids.

export const ONTOLOGY_NAMESPACE = 'https://identityatlas.io/ontology#';

// Analytics entity → ontology class local name.
export const CLASS_TERMS = Object.freeze({
  Principal: 'Principal',
  Identity: 'Identity',
  Resource: 'Resource',
  System: 'System',
  Assignment: 'Assignment',
});

// Core field id → ontology property local name.
export const PROPERTY_TERMS = Object.freeze({
  'Principal.accountEnabled': 'accountEnabled',
  'Principal.principalType': 'principalType',
  'Principal.department': 'department',
  'Principal.companyName': 'companyName',
  'Principal.jobTitle': 'jobTitle',
  'Principal.system': 'system',
  'Principal.displayName': 'displayName',
  'Principal.email': 'email',
  'Principal.employeeId': 'employeeId',
  'Identity.department': 'department',
  'Identity.companyName': 'companyName',
  'Identity.jobTitle': 'jobTitle',
  'Identity.country': 'country',
  'Identity.city': 'city',
  'Identity.officeLocation': 'officeLocation',
  'Identity.displayName': 'displayName',
  'Identity.email': 'email',
  'Identity.analystNotes': 'analystNotes',
  'Resource.resourceType': 'resourceType',
  'Resource.system': 'system',
  'Resource.displayName': 'displayName',
  'Resource.description': 'description',
});

/** Full IRI of a core field, or null for a discovered/unknown one. */
export function iriFor(fieldId) {
  return Object.hasOwn(PROPERTY_TERMS, fieldId) ? ONTOLOGY_NAMESPACE + PROPERTY_TERMS[fieldId] : null;
}

/** Full IRI of an analytics entity's class, or null. */
export function classIriFor(entity) {
  return Object.hasOwn(CLASS_TERMS, entity) ? ONTOLOGY_NAMESPACE + CLASS_TERMS[entity] : null;
}
