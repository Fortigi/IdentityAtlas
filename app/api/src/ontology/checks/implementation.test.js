import { describe, it, expect } from 'vitest';
import { checkImplementation } from './implementation.js';
import { MINI_TTL, edit, miniRegistry, modelOf } from '../__tests__/miniOntology.js';

const run = ({ ttl = MINI_TTL, registry = miniRegistry(), config = {} } = {}) =>
  checkImplementation(modelOf(ttl), registry, config).map(f => `${f.code} ${f.subject}`);

describe('checkImplementation', () => {
  it('finds nothing when the fixture ontology and registry agree', () => {
    expect(checkImplementation(modelOf(), miniRegistry(), {})).toEqual([]);
  });

  describe('closed value lists (both directions)', () => {
    // The spec's required demonstration, at unit level: a relationship type the
    // ingest starts accepting without an ontology definition fails.
    it('fails when the ingest accepts a relationship type the ontology does not define', () => {
      const registry = miniRegistry();
      registry.ingest['resource-relationships'].fields.relationshipType.enum.push('Mirrors');
      const out = checkImplementation(modelOf(), registry, {});
      expect(out).toEqual([{
        code: 'value-missing-from-ontology',
        subject: 'resource-relationships.relationshipType',
        message: 'accepted by the ingest but not defined in the ontology: Mirrors',
      }]);
    });

    it('fails when the ontology defines a relationship type the ingest rejects', () => {
      const registry = miniRegistry();
      registry.ingest['resource-relationships'].fields.relationshipType.enum = ['Contains'];
      expect(run({ registry })).toEqual(['value-not-in-implementation resource-relationships.relationshipType']);
    });

    it('checks a closed discriminator (principal types) the same way', () => {
      const registry = miniRegistry();
      registry.ingest.principals.fields.principalType.enum.push('Robot');
      expect(run({ registry })).toEqual(['value-missing-from-ontology principals.principalType']);
    });

    it('checks a value scheme (assignment types) the same way', () => {
      const registry = miniRegistry();
      registry.ingest['resource-assignments'].fields.assignmentType.enum = ['Direct', 'Eligible', 'Owner'];
      expect(run({ registry })).toEqual(['value-missing-from-ontology resource-assignments.assignmentType']);
    });

    it('fails when the ingest closes a list the ontology leaves open', () => {
      const registry = miniRegistry();
      registry.ingest.resources.fields.resourceType.enum = ['Group'];
      expect(run({ registry })).toEqual(['value-list-not-in-ontology resources.resourceType']);
    });

    it('fails when the ontology claims a closed list the ingest does not enforce', () => {
      const registry = miniRegistry();
      delete registry.ingest['resource-assignments'].fields.assignmentType.enum;
      expect(run({ registry })).toEqual(['value-list-not-enforced resource-assignments.assignmentType']);
    });

    it('treats an open discriminator as no closed list', () => {
      // resourceType is open in the fixture and the ingest has no enum: no finding.
      // Closing the vocabulary in the ontology makes the absent ingest enum a finding.
      const ttl = edit(MINI_TTL, 'ia:openVocabulary true .', '.');
      expect(run({ ttl })).toEqual(['value-list-not-enforced resources.resourceType']);
    });
  });

  describe('ingest fields', () => {
    it('fails on an ingest field that is neither a column nor an alias', () => {
      const registry = miniRegistry();
      registry.ingest.principals.fields.contextId = { type: 'uuid' };
      expect(run({ registry })).toEqual(['ingest-field-unmapped principals.contextId']);
    });

    it('accepts a field declared as an ingest alias of a column — of THIS class only', () => {
      const registry = miniRegistry();
      // principalExternalId is an alias on ia:principalId, whose domain is ResourceAssignment only.
      registry.ingest.resources.fields.principalExternalId = { type: 'string' };
      expect(run({ registry })).toEqual(['ingest-field-unmapped resources.principalExternalId']);
    });

    it('fails on a type the column cannot hold', () => {
      const registry = miniRegistry();
      registry.ingest['resource-assignments'].fields.resourceId = { type: 'string' };
      expect(run({ registry })).toEqual(['ingest-type-mismatch resource-assignments.resourceId']);
    });

    it('checks the identifier field against the identifier type', () => {
      const registry = miniRegistry();
      registry.ingest.principals.fields.id = { type: 'number' };
      expect(run({ registry })).toEqual(['ingest-type-mismatch principals.id']);
    });

    it('fails when an entity named by the ontology is not an ingest entity', () => {
      const registry = miniRegistry();
      delete registry.ingest.systems;
      expect(run({ registry })).toEqual(['unknown-ingest-entity ia:System']);
    });

    it('fails when the entity writes a different table than the class maps to', () => {
      const registry = miniRegistry();
      registry.ingest.systems.table = 'Sources';
      expect(run({ registry })).toEqual(['ingest-table-mismatch systems']);
    });
  });

  describe('entity coverage', () => {
    it('fails on an ingest entity type no class claims and nothing declares out of scope', () => {
      const registry = miniRegistry();
      registry.ingest['principal-activity'] = { table: 'PrincipalActivity', fields: {} };
      expect(run({ registry })).toEqual(['ingest-entity-unclassified principal-activity']);
      expect(run({ registry, config: { outOfScopeIngestEntities: { 'principal-activity': 'satellite' } } })).toEqual([]);
    });

    it('fails on an out-of-scope entry that no longer exists', () => {
      expect(run({ config: { outOfScopeIngestEntities: { gone: 'old' } } })).toEqual(['stale-out-of-scope gone']);
    });

    it('fails when an entity is both a class and out of scope', () => {
      expect(run({ config: { outOfScopeIngestEntities: { systems: 'x' } } })).toEqual(['scope-conflict systems']);
    });
  });

  describe('type lists the code branches on', () => {
    it('fails on a resource type a code list names but the ontology lacks', () => {
      const registry = miniRegistry();
      registry.resourceTypeLists['test GROUPS'] = ['Group', 'Team'];
      expect(run({ registry })).toEqual(['registry-type-undefined Resource:Team']);
    });

    it('fails on a principal type a code list names but the ontology lacks', () => {
      const registry = miniRegistry();
      registry.principalTypeLists['test HUMANS'] = ['Robot'];
      expect(run({ registry })).toEqual(['registry-type-undefined Principal:Robot']);
    });
  });

  describe('ownership', () => {
    it('fails when lib/ownershipTypes lists a type the ontology does not class as ownership', () => {
      const registry = miniRegistry();
      registry.ownership.resourceTypes = ['GroupOwnership', 'Group'];
      expect(run({ registry })).toEqual(['ownership-type-missing Resource:Group']);
    });

    it('fails when the ontology has an ownership type the code list misses', () => {
      const registry = miniRegistry();
      registry.ownership.resourceTypes = [];
      expect(run({ registry })).toEqual(['ownership-type-extra Resource:GroupOwnership']);
    });

    it('fails when an ownership relationship does not point at ownership resources', () => {
      const ttl = edit(MINI_TTL, 'rdfs:domain ia:Resource ; rdfs:range ia:GroupOwnership ;', 'rdfs:domain ia:Resource ; rdfs:range ia:Group ;');
      expect(run({ ttl })).toEqual(['ownership-relationship-range ResourceRelationship:HasOwnership']);
    });

    it('fails when a relationship points at ownership resources but the code list misses it', () => {
      const registry = miniRegistry();
      registry.ownership.relationshipTypes = [];
      expect(run({ registry })).toEqual(['ownership-relationship-unlisted ResourceRelationship:HasOwnership']);
    });
  });

  describe('relationship endpoints', () => {
    it('fails when a relationship type connects classes its edge table cannot', () => {
      // ResourceRelationships links Resource → Resource; a Principal source does not fit.
      const ttl = edit(MINI_TTL, 'rdfs:domain ia:Resource ; rdfs:range ia:Resource ; rdfs:label "contains"', 'rdfs:domain ia:Principal ; rdfs:range ia:Resource ; rdfs:label "contains"');
      expect(run({ ttl })).toEqual(['relationship-endpoint-mismatch ia:contains']);
    });

    it('accepts a subclass on either end', () => {
      const ttl = edit(MINI_TTL, 'rdfs:domain ia:Resource ; rdfs:range ia:Resource ; rdfs:label "contains"', 'rdfs:domain ia:Group ; rdfs:range ia:GroupOwnership ; rdfs:label "contains"');
      // contains now also points at ownership resources only, so the ownership list must name it.
      expect(run({ ttl })).toEqual(['ownership-relationship-unlisted ResourceRelationship:Contains']);
    });
  });

  describe('polymorphic targets', () => {
    const poly = edit(MINI_TTL, 'rdfs:domain ia:ResourceAssignment ; rdfs:range ia:Resource ; rdfs:label "resourceId"',
      'rdfs:domain ia:ResourceAssignment ; rdfs:range [ a owl:Class ; owl:unionOf ( ia:Resource ia:Principal ) ] ; rdfs:label "resourceId"');
    const kinds = `
ia:Kind a owl:Class ; rdfs:label "Kind" ; rdfs:comment "c" ; rdfs:isDefinedBy <https://identityatlas.io/ontology> .
ia:Kind_Resource a owl:NamedIndividual, ia:Kind ; ia:typeValue "Resource" ; ia:denotesClass ia:Resource ; rdfs:label "r" ; rdfs:comment "c" ; rdfs:isDefinedBy <https://identityatlas.io/ontology> .
ia:Kind_Principal a owl:NamedIndividual, ia:Kind ; ia:typeValue "Principal" ; ia:denotesClass ia:Principal ; rdfs:label "p" ; rdfs:comment "c" ; rdfs:isDefinedBy <https://identityatlas.io/ontology> .
ia:kind a owl:DatatypeProperty ; ia:sqlType "text" ; ia:valueScheme ia:Kind ; rdfs:domain ia:ResourceAssignment ; rdfs:range xsd:string ; rdfs:label "kind" ; rdfs:comment "c" ; rdfs:isDefinedBy <https://identityatlas.io/ontology> .`;

    it('fails when a polymorphic target has no kind column', () => {
      expect(run({ ttl: poly })).toEqual(['polymorphic-target-mismatch ia:resourceId']);
    });

    it('passes when the kind column names exactly the target classes', () => {
      expect(run({ ttl: poly + kinds })).toEqual([]);
    });

    it('fails when the kind column names a class the target cannot hold', () => {
      const extra = kinds.replace('ia:Kind_Principal a', 'ia:Kind_System a owl:NamedIndividual, ia:Kind ; ia:typeValue "System" ; ia:denotesClass ia:System ; rdfs:label "s" ; rdfs:comment "c" ; rdfs:isDefinedBy <https://identityatlas.io/ontology> .\nia:Kind_Principal a');
      expect(run({ ttl: poly + extra })).toEqual(['polymorphic-target-mismatch ia:resourceId']);
    });
  });
});
