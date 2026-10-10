import { describe, it, expect } from 'vitest';
import { checkIntegrity } from './integrity.js';
import { MINI_TTL, edit, modelOf } from '../__tests__/miniOntology.js';

// Each case changes ONE thing in a clean fixture and asserts the exact finding(s)
// — code and subject — so a check that fired for the wrong reason, or on the
// wrong term, fails the test.
const findings = (ttl) => checkIntegrity(modelOf(ttl)).map(f => `${f.code} ${f.subject}`);

describe('checkIntegrity', () => {
  it('finds nothing in the clean fixture', () => {
    expect(checkIntegrity(modelOf())).toEqual([]);
  });

  it('requires the core ontology header and a version', () => {
    const ttl = edit(MINI_TTL, '<https://identityatlas.io/ontology> a owl:Ontology ; owl:versionInfo "0.1.0" .',
      '<https://example.org/other> a owl:Ontology .');
    expect(findings(ttl)).toEqual(['ontology-header ontology', 'ontology-header ontology']);
  });

  it('flags a term declared as two kinds', () => {
    const ttl = `${MINI_TTL}\nia:Group a owl:ObjectProperty .`;
    expect(findings(ttl)).toContain('conflicting-declaration ia:Group');
  });

  it('flags a term outside the namespace', () => {
    const ttl = `${MINI_TTL}\n<https://example.org/Thing> a owl:Class .`;
    expect(findings(ttl)).toEqual(['foreign-term https://example.org/Thing']);
  });

  it('allows declaring the kind of an external annotation property, not of an external class', () => {
    const ttl = `${MINI_TTL}\n<http://purl.org/dc/terms/title> a owl:AnnotationProperty .`;
    expect(findings(ttl)).toEqual([]);
    const both = `${MINI_TTL}\n<http://purl.org/dc/terms/title> a owl:AnnotationProperty, owl:Class .`;
    expect(findings(both)).toEqual(['conflicting-declaration http://purl.org/dc/terms/title', 'foreign-term http://purl.org/dc/terms/title']);
  });

  it('flags an ia: IRI that is used but never declared (a typo)', () => {
    const ttl = edit(MINI_TTL, 'ia:User a owl:Class ; rdfs:subClassOf ia:Principal ;', 'ia:User a owl:Class ; rdfs:subClassOf ia:Princpal ;');
    expect(findings(ttl)).toEqual(['undeclared-term ia:Princpal', 'undeclared-reference ia:User', 'orphan-type-value ia:User']);
  });

  it('flags two different values for a single-valued annotation', () => {
    const ttl = `${MINI_TTL}\nia:User ia:typeValue "Person" .`;
    expect(findings(ttl)).toEqual(['conflicting-annotation ia:User']);
  });

  it('flags two terms of the same kind that differ only in case, but not a class next to its property', () => {
    const clash = `${MINI_TTL}\nia:group a owl:Class ; rdfs:label "g" ; rdfs:comment "c" ; rdfs:isDefinedBy <https://identityatlas.io/ontology> .`;
    expect(findings(clash)).toEqual(['duplicate-identifier ia:group']);
    // ia:AssignmentType (class) and ia:assignmentType (property) coexist in the fixture already.
    expect(findings(MINI_TTL)).toEqual([]);
  });

  it('requires a label, a description and rdfs:isDefinedBy on every term', () => {
    const ttl = `${MINI_TTL}\nia:Bare a owl:Class .`;
    expect(findings(ttl)).toEqual(['missing-label ia:Bare', 'missing-description ia:Bare', 'not-defined-by-core ia:Bare']);
  });

  it('flags a reference to a declared term of the wrong kind', () => {
    const ttl = edit(MINI_TTL, 'ia:valueScheme ia:AssignmentType ;', 'ia:valueScheme ia:contains ;');
    expect(findings(ttl)).toEqual(['undeclared-reference ia:assignmentType']);
  });

  describe('column properties', () => {
    it('rejects an unknown SQL type', () => {
      const ttl = edit(MINI_TTL, 'ia:resourceType a owl:DatatypeProperty ; ia:sqlType "text"', 'ia:resourceType a owl:DatatypeProperty ; ia:sqlType "varchar"');
      expect(findings(ttl)).toEqual(['unknown-sql-type ia:resourceType']);
    });

    it('requires the range that matches the SQL type', () => {
      const ttl = edit(MINI_TTL, 'rdfs:domain ia:Resource ; rdfs:range xsd:string ; rdfs:label "resourceType"', 'rdfs:domain ia:Resource ; rdfs:range xsd:integer ; rdfs:label "resourceType"');
      expect(findings(ttl)).toEqual(['range-type-mismatch ia:resourceType']);
    });

    it('requires the label to be the column name', () => {
      const ttl = edit(MINI_TTL, 'rdfs:label "resourceType"', 'rdfs:label "Resource type"');
      expect(findings(ttl)).toEqual(['naming-convention ia:resourceType']);
    });

    it('requires every domain to map to a table', () => {
      const ttl = edit(MINI_TTL, 'rdfs:domain ia:Resource ; rdfs:range xsd:string ; rdfs:label "resourceType"', 'rdfs:domain ia:Group ; rdfs:range xsd:string ; rdfs:label "resourceType"');
      expect(findings(ttl)).toEqual(['domain-not-a-table ia:resourceType']);
    });

    it('requires a domain at all', () => {
      const ttl = edit(MINI_TTL, 'rdfs:domain ia:Resource ; rdfs:range xsd:string ; rdfs:label "resourceType"', 'rdfs:range xsd:string ; rdfs:label "resourceType"');
      expect(findings(ttl)).toEqual(['missing-domain ia:resourceType']);
    });

    it('rejects a foreign key whose type differs from its target identifier', () => {
      // systemId is integer and points at System (integer id): fine. Point it at Principal (uuid id).
      const ttl = edit(MINI_TTL, 'rdfs:range ia:System ;', 'rdfs:range ia:Principal ;');
      expect(findings(ttl)).toEqual(['fk-type-mismatch ia:systemId']);
    });

    it('rejects a foreign key into a class without an identifier', () => {
      const ttl = edit(MINI_TTL, 'rdfs:domain ia:ResourceAssignment ; rdfs:range ia:Resource ; rdfs:label "resourceId"', 'rdfs:domain ia:ResourceAssignment ; rdfs:range ia:Group ; rdfs:label "resourceId"');
      expect(findings(ttl)).toEqual(['fk-target-not-a-node ia:resourceId']);
    });
  });

  describe('relationship-type properties', () => {
    it('must be named lowerCamel of the stored value', () => {
      const ttl = edit(MINI_TTL, 'ia:typeValue "Contains" ;', 'ia:typeValue "Includes" ;');
      expect(findings(ttl)).toEqual(['naming-convention ia:contains']);
    });

    it('must carry a type value', () => {
      const ttl = edit(MINI_TTL, 'ia:contains a owl:ObjectProperty ; ia:typeValue "Contains" ;', 'ia:contains a owl:ObjectProperty ;');
      expect(findings(ttl)).toEqual(['missing-type-value ia:contains']);
    });

    it('must be stored in an edge class with a type column', () => {
      const ttl = edit(MINI_TTL, 'ia:typeValue "Contains" ; ia:storedIn ia:ResourceRelationship', 'ia:typeValue "Contains" ; ia:storedIn ia:ResourceAssignment');
      expect(findings(ttl)).toEqual(['stored-in-not-typed-edge ia:contains']);
    });

    it('needs a domain and a range', () => {
      const ttl = edit(MINI_TTL, 'rdfs:domain ia:Resource ; rdfs:range ia:Resource ; rdfs:label "contains"', 'rdfs:domain ia:Resource ; rdfs:label "contains"');
      expect(findings(ttl)).toEqual(['missing-domain ia:contains']);
    });
  });

  it('flags a property that is neither a column nor a relationship type', () => {
    const ttl = `${MINI_TTL}\nia:floating a owl:DatatypeProperty ; rdfs:label "floating" ; rdfs:comment "c" ; rdfs:isDefinedBy <https://identityatlas.io/ontology> .`;
    expect(findings(ttl)).toEqual(['unmapped-property ia:floating']);
  });

  describe('type values', () => {
    it('flags a stored value defined twice under one discriminator', () => {
      const ttl = edit(MINI_TTL, 'ia:Group a owl:Class ; rdfs:subClassOf ia:Resource ; ia:typeValue "Group"', 'ia:Group a owl:Class ; rdfs:subClassOf ia:Resource ; ia:typeValue "GroupOwnership"');
      expect(findings(ttl)).toEqual(['duplicate-type-value ia:Resource.resourceType']);
    });

    it('flags a relationship value defined twice in one edge table', () => {
      const ttl = edit(MINI_TTL, 'ia:typeValue "HasOwnership"', 'ia:typeValue "Contains"');
      expect(findings(ttl)).toEqual(['naming-convention ia:hasOwnership', 'duplicate-type-value ia:ResourceRelationship.relationshipType']);
    });

    it('flags a value-list member defined twice', () => {
      const ttl = edit(MINI_TTL, 'ia:typeValue "Eligible"', 'ia:typeValue "Direct"');
      expect(findings(ttl)).toEqual(['duplicate-type-value ia:AssignmentType', 'naming-convention ia:AssignmentType_Eligible']);
    });

    it('flags a type value on a class whose ancestors declare no discriminator', () => {
      const ttl = edit(MINI_TTL, 'ia:discriminator "principalType" .', '.');
      expect(findings(ttl)).toEqual(['orphan-type-value ia:User']);
    });
  });

  describe('value-list members', () => {
    it('need a type value', () => {
      const ttl = edit(MINI_TTL, 'ia:AssignmentType_Direct a owl:NamedIndividual, ia:AssignmentType ; ia:typeValue "Direct" ;', 'ia:AssignmentType_Direct a owl:NamedIndividual, ia:AssignmentType ;');
      expect(findings(ttl)).toEqual(['missing-type-value ia:AssignmentType_Direct']);
    });

    it('are named <List>_<value>', () => {
      const ttl = edit(MINI_TTL, 'ia:AssignmentType_Direct a', 'ia:Direct a');
      expect(findings(ttl)).toEqual(['naming-convention ia:Direct']);
    });

    it('belong to exactly one list', () => {
      const ttl = `${MINI_TTL}\nia:AssignmentType_Direct a ia:Edge .`;
      expect(findings(ttl)).toEqual(['individual-type ia:AssignmentType_Direct']);
    });

    it('may only denote a class that maps to a table', () => {
      const ttl = `${MINI_TTL}\nia:AssignmentType_Direct ia:denotesClass ia:Group .`;
      expect(findings(ttl)).toEqual(['denotes-non-table ia:AssignmentType_Direct']);
    });
  });

  describe('edge classes', () => {
    it('need a table', () => {
      const ttl = edit(MINI_TTL, 'ia:table "ResourceAssignments" ;', '');
      expect(findings(ttl)).toContain('edge-without-table ia:ResourceAssignment');
    });

    it('need both endpoints', () => {
      const ttl = edit(MINI_TTL, 'ia:sourceProperty ia:principalId ; ia:targetProperty ia:resourceId .', 'ia:sourceProperty ia:principalId .');
      expect(findings(ttl)).toEqual(['edge-endpoints ia:ResourceAssignment']);
    });

    it('take their endpoints from their own foreign keys', () => {
      const ttl = edit(MINI_TTL, 'ia:sourceProperty ia:principalId ; ia:targetProperty ia:resourceId .', 'ia:sourceProperty ia:principalId ; ia:targetProperty ia:parentResourceId .');
      expect(findings(ttl)).toEqual(['edge-endpoints ia:ResourceAssignment']);
    });
  });
});
