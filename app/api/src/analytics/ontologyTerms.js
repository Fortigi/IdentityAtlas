// The ONE place where analytics field ids meet the Core Ontology
// (ontology/core.ttl, docs/architecture/core-ontology.md).
//
// An analytics field id is `<Class>.<property>` (`Principal.accountEnabled`).
// Its IRI follows the core ontology's conventions:
//   * a column is a property named exactly as the column, shared by every table
//     that has it (Principals.accountEnabled → ia:accountEnabled);
//   * a foreign key is an object property named as the column, ranging over the
//     class (Principals.systemId → ia:systemId → ia:System) — so the analytics
//     "system" field, which reports the system's name, is ia:systemId;
//   * tables are singular classes (ia:Principal, ia:ResourceAssignment).
// analytics/ontologyTerms.test.js loads core.ttl through the ontology module and
// fails when any term here, or any type value the analytics queries depend on,
// is not defined there.
//
// Discovered `extendedAttributes` keys are per-install vocabulary and stay
// outside the core ontology by design, so iriFor() returns null for
// `<Class>.ext.<key>` ids.

import { IA } from '../ontology/vocabulary.js';

export const ONTOLOGY_NAMESPACE = IA;

// Analytics entity → ontology class local name.
export const CLASS_TERMS = Object.freeze({
  Principal: 'Principal',
  Identity: 'Identity',
  Resource: 'Resource',
  System: 'System',
  Assignment: 'ResourceAssignment',
});

// Core field id → ontology property local name (= the column it reads).
export const PROPERTY_TERMS = Object.freeze({
  'Principal.accountEnabled': 'accountEnabled',
  'Principal.principalType': 'principalType',
  'Principal.department': 'department',
  'Principal.companyName': 'companyName',
  'Principal.jobTitle': 'jobTitle',
  'Principal.system': 'systemId',
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
  'Resource.system': 'systemId',
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
