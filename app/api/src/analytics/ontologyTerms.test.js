// The analytics catalog against the committed core ontology (ontology/core.ttl),
// loaded through the ontology module — not against a hand-written copy of it.
//
// Every core analytics field must name a property the ontology defines, on a
// class in that property's domain, and every type value the analytics queries
// branch on must be a value the ontology declares for that column. A term that
// does not resolve fails here, with the field it came from.
import { describe, it, expect } from 'vitest';
import { loadOntology } from '../ontology/cli.js';
import { typedSubclasses, valueSetFor, schemeMembers } from '../ontology/model.js';
import { CORE_FIELDS } from './fields.js';
import { CLASS_TERMS, PROPERTY_TERMS, ONTOLOGY_NAMESPACE, iriFor, classIriFor } from './ontologyTerms.js';
import { TYPE_VALUE_DEPENDENCIES } from './sqlParts.js';

const loaded = loadOntology();
const model = loaded.model;

/** Why a field id does not resolve to a defined property on its class, or null when it does. */
function unresolvedField(m, fieldId, terms = PROPERTY_TERMS) {
  const entity = fieldId.split('.')[0];
  const cls = CLASS_TERMS[entity];
  const local = terms[fieldId];
  if (!local) return `${fieldId}: no ontology term mapped`;
  if (!m.classes.has(cls)) return `${fieldId}: class ia:${cls} is not defined`;
  const prop = m.properties.get(local);
  if (!prop) return `${fieldId}: property ia:${local} is not defined`;
  if (!prop.domains.includes(cls)) return `${fieldId}: ia:${local} is defined, but not on ia:${cls} (domain ${prop.domains.join(', ')})`;
  return null;
}

/** The IRI that defines `value` as a value of `column` on `cls`, or null. */
function definingIri(m, cls, column, value) {
  const sub = typedSubclasses(m, cls).find(s => s.typeValue === value);
  if (sub) return sub.iri;
  const prop = m.properties.get(column);
  const member = prop?.valueScheme ? schemeMembers(m, prop.valueScheme).find(i => i.typeValue === value) : null;
  if (member) return member.iri;
  return (valueSetFor(m, cls, column) ?? []).includes(value) ? `${ONTOLOGY_NAMESPACE}${cls}` : null;
}

// Type values the analytics code depends on that the core ontology does NOT
// declare. Each is a real model inconsistency, reported upstream rather than
// papered over here. A ratchet: when the ontology gains the value, the
// "still undefined" test fails and the entry must be removed.
const KNOWN_UNDEFINED = new Map([
  ['Principal.principalType=#microsoft.graph.group',
    'lib/principalTypes.js GROUP_PRINCIPAL_TYPE: every account count excludes principals of this type, but the '
    + 'ontology closes ia:Principal\'s principalType list to the ingest PRINCIPAL_TYPES, which do not include it. '
    + 'Either such rows cannot exist (and the exclusion is dead code) or the closed list is incomplete.'],
]);

describe('analytics catalog vs ontology/core.ttl', () => {
  it('loads the core ontology through the ontology module', () => {
    expect(loaded.errors).toBeUndefined();
    expect(model.ontology.iri).toBe('https://identityatlas.io/ontology');
  });

  it('maps every entity to a defined class and every core field to a defined property on that class', () => {
    for (const cls of Object.values(CLASS_TERMS)) expect(model.classes.has(cls), `ia:${cls}`).toBe(true);
    expect(Object.keys(PROPERTY_TERMS).sort()).toEqual(Object.keys(CORE_FIELDS).sort());
    const problems = Object.keys(CORE_FIELDS).map(id => unresolvedField(model, id)).filter(Boolean);
    expect(problems).toEqual([]);
    // The IRI the API publishes is exactly the defined property's IRI.
    for (const id of Object.keys(CORE_FIELDS)) {
      expect(iriFor(id)).toBe(model.properties.get(PROPERTY_TERMS[id]).iri);
    }
  });

  it('follows the core conventions: a column is its own property, a foreign key ranges over its class', () => {
    expect(iriFor('Principal.accountEnabled')).toBe('https://identityatlas.io/ontology#accountEnabled');
    expect(model.properties.get(PROPERTY_TERMS['Principal.system'])).toMatchObject({ kind: 'object', rangeClasses: ['System'] });
    expect(classIriFor('Assignment')).toBe('https://identityatlas.io/ontology#ResourceAssignment');
    expect(iriFor('Principal.ext.employeeCategory')).toBeNull();     // extended attributes stay outside the core
  });

  it('refuses terms that do not resolve - unmapped, undefined property, wrong class, undefined class', () => {
    // Discriminating negatives: each is a plausible mapping mistake, run through the same check.
    expect(unresolvedField(model, 'Principal.salary')).toBe('Principal.salary: no ontology term mapped');
    expect(unresolvedField(model, 'Principal.salary', { 'Principal.salary': 'salary' }))
      .toBe('Principal.salary: property ia:salary is not defined');
    // ia:accountEnabled exists, but Identities has no such column (Principals and IdentityMembers do).
    expect(unresolvedField(model, 'Identity.accountEnabled', { 'Identity.accountEnabled': 'accountEnabled' }))
      .toMatch(/^Identity\.accountEnabled: ia:accountEnabled is defined, but not on ia:Identity/);
    const noIdentity = { ...model, classes: new Map([...model.classes].filter(([k]) => k !== 'Identity')) };
    expect(unresolvedField(noIdentity, 'Identity.department')).toBe('Identity.department: class ia:Identity is not defined');
  });
  it('defines every type value the analytics queries branch on, except the listed known gaps', () => {
    const undefinedValues = [];
    for (const dep of TYPE_VALUE_DEPENDENCIES) {
      const key = `${dep.entity}.${dep.column}=${dep.value}`;
      const iri = definingIri(model, CLASS_TERMS[dep.entity], dep.column, dep.value);
      if (!iri && !KNOWN_UNDEFINED.has(key)) undefinedValues.push(`${key} (${dep.usedBy})`);
    }
    expect(undefinedValues).toEqual([]);
    expect(definingIri(model, 'Resource', 'resourceType', 'BusinessRole')).toBe('https://identityatlas.io/ontology#BusinessRole');
  });

  it('still finds each known gap undefined - remove the entry once the ontology declares it', () => {
    for (const key of KNOWN_UNDEFINED.keys()) {
      const [lhs, value] = key.split('=');
      const [entity, column] = lhs.split('.');
      expect(definingIri(model, CLASS_TERMS[entity], column, value), key).toBeNull();
      expect(TYPE_VALUE_DEPENDENCIES.some(d => `${d.entity}.${d.column}=${d.value}` === key), `${key} is still a dependency`).toBe(true);
    }
  });

  it('resolves closed value lists through the ontology: a defined value passes, a made-up one does not', () => {
    expect(definingIri(model, 'Principal', 'principalType', 'User')).toBe('https://identityatlas.io/ontology#User');
    expect(definingIri(model, 'Principal', 'principalType', 'Robot')).toBeNull();
    expect(definingIri(model, 'Resource', 'resourceType', 'NotAType')).toBeNull();
  });
});
