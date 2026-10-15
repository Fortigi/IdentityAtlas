import { describe, it, expect } from 'vitest';
import {
  columnsOf, isSubClassOf, parseOntology, relationshipTypesOf, schemeMembers, tableClasses, typedSubclasses, valueSetFor,
} from './model.js';
import { MINI_TTL, edit, modelOf } from './__tests__/miniOntology.js';

describe('parseOntology', () => {
  it('reports a Turtle syntax error as a finding instead of throwing', () => {
    const r = parseOntology('@prefix ia: <https://identityatlas.io/ontology#> .\nia:A a ia:B', 'x.ttl');
    expect(r.store).toBeUndefined();
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ code: 'syntax', subject: 'x.ttl' });
    expect(r.errors[0].message).toMatch(/^Turtle syntax error: /);
  });

  it('returns a store for valid Turtle', () => {
    const r = parseOntology(MINI_TTL);
    expect(r.errors).toBeUndefined();
    expect(r.store.size).toBeGreaterThan(100);
  });
});

describe('buildModel', () => {
  const model = modelOf();

  it('reads the ontology header', () => {
    expect(model.ontology).toEqual({ iri: 'https://identityatlas.io/ontology', version: '0.1.0' });
  });

  it('flattens a class with its mapping annotations', () => {
    expect(model.classes.get('Resource')).toMatchObject({
      table: 'Resources', identifierColumn: 'id', identifierSqlType: 'uuid', ingestEntities: ['resources'],
      discriminator: 'resourceType', openVocabulary: true, superClasses: ['Node'],
    });
    expect(model.classes.get('Principal').openVocabulary).toBe(false);
    expect(model.classes.get('ResourceAssignment')).toMatchObject({ sourceProperties: ['principalId'], targetProperties: ['resourceId'] });
  });

  it('resolves an owl:unionOf domain into its member classes, in order', () => {
    expect(model.properties.get('displayName').domains).toEqual(['System', 'Principal', 'Resource']);
  });

  it('separates object and datatype properties and keeps the range', () => {
    expect(model.properties.get('systemId')).toMatchObject({ kind: 'object', sqlType: 'integer', rangeClasses: ['System'] });
    expect(model.properties.get('resourceType')).toMatchObject({ kind: 'datatype', rangeClasses: [], ranges: ['http://www.w3.org/2001/XMLSchema#string'] });
  });

  it('reads relationship-type and value-scheme annotations as local names', () => {
    expect(model.properties.get('contains')).toMatchObject({ typeValue: 'Contains', storedIn: 'ResourceRelationship', sqlType: undefined });
    expect(model.properties.get('assignmentType').valueScheme).toBe('AssignmentType');
    expect(model.properties.get('principalId').ingestAliases).toEqual(['principalExternalId']);
  });

  it('reads individuals without their owl:NamedIndividual declaration as a type', () => {
    expect(model.individuals.get('AssignmentType_Direct')).toMatchObject({ types: ['AssignmentType'], typeValue: 'Direct' });
  });

  it('records every ia: IRI that is used, declared or not', () => {
    const m = modelOf(`${MINI_TTL}\nia:User rdfs:seeAlso ia:Nowhere .`);
    expect(m.mentioned.has('https://identityatlas.io/ontology#Nowhere')).toBe(true);
    expect(m.declarations.has('https://identityatlas.io/ontology#Nowhere')).toBe(false);
  });

  it('records conflicting values of a single-valued annotation', () => {
    const m = modelOf(`${MINI_TTL}\nia:Group rdfs:label "Team" .`);
    expect(m.multiValued).toEqual([{ iri: 'https://identityatlas.io/ontology#Group', predicate: 'http://www.w3.org/2000/01/rdf-schema#label', values: ['Group', 'Team'] }]);
  });
});

describe('model helpers', () => {
  const model = modelOf();

  it('isSubClassOf follows the hierarchy transitively and stops on a cycle', () => {
    expect(isSubClassOf(model, 'GroupOwnership', 'Resource')).toBe(true);
    expect(isSubClassOf(model, 'Group', 'OwnershipResource')).toBe(false);
    expect(isSubClassOf(model, 'Resource', 'Resource')).toBe(true);
    const cyclic = modelOf(`${MINI_TTL}\nia:Node rdfs:subClassOf ia:Group .`);
    expect(isSubClassOf(cyclic, 'Group', 'Principal')).toBe(false);
  });

  it('lists table classes, columns, relationship types, scheme members and typed subclasses', () => {
    expect(tableClasses(model).map(c => c.local).sort()).toEqual(['Principal', 'Resource', 'ResourceAssignment', 'ResourceRelationship', 'System']);
    expect(columnsOf(model, 'Principal').map(p => p.local).sort()).toEqual(['displayName', 'principalType', 'systemId']);
    expect(relationshipTypesOf(model, 'ResourceRelationship').map(p => p.typeValue)).toEqual(['Contains', 'HasOwnership']);
    expect(schemeMembers(model, 'AssignmentType').map(i => i.typeValue)).toEqual(['Direct', 'Eligible']);
    expect(typedSubclasses(model, 'Resource').map(c => c.typeValue)).toEqual(['Group', 'GroupOwnership']);
  });

  describe('valueSetFor', () => {
    it('returns the relationship types for an edge type column', () => {
      expect(valueSetFor(model, 'ResourceRelationship', 'relationshipType')).toEqual(['Contains', 'HasOwnership']);
    });

    it('returns the subclass values for a closed discriminator and null for an open one', () => {
      expect(valueSetFor(model, 'Principal', 'principalType')).toEqual(['User']);
      expect(valueSetFor(model, 'Resource', 'resourceType')).toBeNull();
    });

    it('returns a value scheme only on a class in the property domain', () => {
      expect(valueSetFor(model, 'ResourceAssignment', 'assignmentType')).toEqual(['Direct', 'Eligible']);
      expect(valueSetFor(model, 'Principal', 'assignmentType')).toBeNull();
    });

    it('returns null for a free-text column', () => {
      expect(valueSetFor(model, 'Principal', 'displayName')).toBeNull();
    });

    it('prefers the type column over a value scheme on the same column', () => {
      const ttl = edit(MINI_TTL, 'ia:relationshipType a owl:DatatypeProperty ; ia:sqlType "text" ;', 'ia:relationshipType a owl:DatatypeProperty ; ia:sqlType "text" ; ia:valueScheme ia:AssignmentType ;');
      expect(valueSetFor(modelOf(ttl), 'ResourceRelationship', 'relationshipType')).toEqual(['Contains', 'HasOwnership']);
    });
  });
});
