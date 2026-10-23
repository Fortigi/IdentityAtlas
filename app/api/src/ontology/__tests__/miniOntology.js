// A small, CLEAN ontology + matching registry for the ontology unit tests.
//
// Every check returns no findings for this pair (asserted in the tests), so a
// test that changes ONE thing and sees ONE finding proves that thing — not some
// unrelated noise — is what the check reacts to.

import { buildModel, parseOntology } from '../model.js';

const DEF = 'rdfs:isDefinedBy <https://identityatlas.io/ontology>';
const d = (label, comment) => `rdfs:label "${label}" ; rdfs:comment "${comment}" ; ${DEF}`;

export const MINI_TTL = `
@prefix ia: <https://identityatlas.io/ontology#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<https://identityatlas.io/ontology> a owl:Ontology ; owl:versionInfo "0.1.0" .

ia:table a owl:AnnotationProperty . ia:identifierColumn a owl:AnnotationProperty .
ia:identifierSqlType a owl:AnnotationProperty . ia:ingestEntity a owl:AnnotationProperty .
ia:discriminator a owl:AnnotationProperty . ia:openVocabulary a owl:AnnotationProperty .
ia:typeColumn a owl:AnnotationProperty . ia:sourceProperty a owl:AnnotationProperty .
ia:targetProperty a owl:AnnotationProperty . ia:sqlType a owl:AnnotationProperty .
ia:ingestAlias a owl:AnnotationProperty . ia:typeValue a owl:AnnotationProperty .
ia:storedIn a owl:AnnotationProperty . ia:valueScheme a owl:AnnotationProperty .
ia:denotesClass a owl:AnnotationProperty . ia:status a owl:AnnotationProperty .

ia:Node a owl:Class ; ${d('Node', 'A node table.')} .
ia:Edge a owl:Class ; ${d('Edge', 'An edge table.')} .

ia:System a owl:Class ; rdfs:subClassOf ia:Node ; ${d('System', 'A source.')} ;
    ia:table "Systems" ; ia:identifierColumn "id" ; ia:identifierSqlType "integer" ; ia:ingestEntity "systems" .
ia:Principal a owl:Class ; rdfs:subClassOf ia:Node ; ${d('Principal', 'An account.')} ;
    ia:table "Principals" ; ia:identifierColumn "id" ; ia:identifierSqlType "uuid" ; ia:ingestEntity "principals" ;
    ia:discriminator "principalType" .
ia:Resource a owl:Class ; rdfs:subClassOf ia:Node ; ${d('Resource', 'A grant.')} ;
    ia:table "Resources" ; ia:identifierColumn "id" ; ia:identifierSqlType "uuid" ; ia:ingestEntity "resources" ;
    ia:discriminator "resourceType" ; ia:openVocabulary true .
ia:User a owl:Class ; rdfs:subClassOf ia:Person ; ia:typeValue "User" ; ${d('User', 'A person account.')} .
ia:Group a owl:Class ; rdfs:subClassOf ia:Resource ; ia:typeValue "Group" ; ia:template true ; ia:expandsAccess true ; ${d('Group', 'A group.')} .
ia:template a owl:AnnotationProperty . ia:expandsAccess a owl:AnnotationProperty . ia:accountabilityDefault a owl:AnnotationProperty .
ia:Person a owl:Class ; rdfs:subClassOf ia:Principal ; ia:template true ; ${d('Person', 'A human uses it.')} .
ia:TechnicalRole a owl:Class ; rdfs:subClassOf ia:Resource ; ia:template true ; ${d('Technical role', 'A bundle of rights.')} .
ia:Permission a owl:Class ; rdfs:subClassOf ia:Resource ; ia:template true ; ${d('Permission', 'One right.')} .
ia:ControlPermission a owl:Class ; rdfs:subClassOf ia:Permission ; ia:expandsAccess false ; ${d('Control permission', 'A right over another object.')} .
ia:GroupOwnership a owl:Class ; rdfs:subClassOf ia:ControlPermission ; ia:typeValue "GroupOwnership" ; ${d('Group ownership', 'Owners of a group.')} .

ia:ResourceRelationship a owl:Class ; rdfs:subClassOf ia:Edge ; ${d('Resource relationship', 'Parent to child.')} ;
    ia:table "ResourceRelationships" ; ia:ingestEntity "resource-relationships" ; ia:typeColumn "relationshipType" ;
    ia:sourceProperty ia:parentResourceId ; ia:targetProperty ia:childResourceId .
ia:ResourceAssignment a owl:Class ; rdfs:subClassOf ia:Edge ; ${d('Resource assignment', 'Who holds what.')} ;
    ia:table "ResourceAssignments" ; ia:ingestEntity "resource-assignments" ;
    ia:sourceProperty ia:principalId ; ia:targetProperty ia:resourceId .

ia:AssignmentType a owl:Class ; ${d('Assignment type', 'How it is held.')} .
ia:AssignmentType_Direct a owl:NamedIndividual, ia:AssignmentType ; ia:typeValue "Direct" ; ${d('Direct', 'Held directly.')} .
ia:AssignmentType_Eligible a owl:NamedIndividual, ia:AssignmentType ; ia:typeValue "Eligible" ; ${d('Eligible', 'Can be activated.')} .

ia:contains a owl:ObjectProperty ; ia:typeValue "Contains" ; ia:storedIn ia:ResourceRelationship ;
    rdfs:domain ia:Resource ; rdfs:range ia:Resource ; ${d('contains', 'Child is part of parent.')} .
ia:hasOwnership a owl:ObjectProperty ; ia:typeValue "HasOwnership" ; ia:storedIn ia:ResourceRelationship ;
    rdfs:domain ia:Resource ; rdfs:range ia:GroupOwnership ; ${d('has ownership', 'Owned to ownership.')} .

ia:displayName a owl:DatatypeProperty ; ia:sqlType "text" ;
    rdfs:domain [ a owl:Class ; owl:unionOf ( ia:System ia:Principal ia:Resource ) ] ; rdfs:range xsd:string ; ${d('displayName', 'Name.')} .
ia:systemId a owl:ObjectProperty ; ia:sqlType "integer" ;
    rdfs:domain [ a owl:Class ; owl:unionOf ( ia:Principal ia:Resource ) ] ; rdfs:range ia:System ; ${d('systemId', 'The source.')} .
ia:principalType a owl:DatatypeProperty ; ia:sqlType "text" ; rdfs:domain ia:Principal ; rdfs:range xsd:string ; ${d('principalType', 'Kind.')} .
ia:resourceType a owl:DatatypeProperty ; ia:sqlType "text" ; rdfs:domain ia:Resource ; rdfs:range xsd:string ; ${d('resourceType', 'Kind.')} .
ia:parentResourceId a owl:ObjectProperty ; ia:sqlType "uuid" ; rdfs:domain ia:ResourceRelationship ; rdfs:range ia:Resource ; ${d('parentResourceId', 'Parent.')} .
ia:childResourceId a owl:ObjectProperty ; ia:sqlType "uuid" ; rdfs:domain ia:ResourceRelationship ; rdfs:range ia:Resource ; ${d('childResourceId', 'Child.')} .
ia:relationshipType a owl:DatatypeProperty ; ia:sqlType "text" ; rdfs:domain ia:ResourceRelationship ; rdfs:range xsd:string ; ${d('relationshipType', 'Type.')} .
ia:principalId a owl:ObjectProperty ; ia:sqlType "uuid" ; ia:ingestAlias "principalExternalId" ;
    rdfs:domain ia:ResourceAssignment ; rdfs:range ia:Principal ; ${d('principalId', 'Holder.')} .
ia:resourceId a owl:ObjectProperty ; ia:sqlType "uuid" ; rdfs:domain ia:ResourceAssignment ; rdfs:range ia:Resource ; ${d('resourceId', 'Held.')} .
ia:assignmentType a owl:DatatypeProperty ; ia:sqlType "text" ; ia:valueScheme ia:AssignmentType ;
    rdfs:domain ia:ResourceAssignment ; rdfs:range xsd:string ; ${d('assignmentType', 'How.')} .
`;

/** The registry the mini ontology agrees with. A fresh object every call. */
export function miniRegistry() {
  const s = (extra = {}) => ({ type: 'string', ...extra });
  return {
    ingest: {
      systems: { table: 'Systems', fields: { displayName: s() } },
      principals: { table: 'Principals', fields: { id: { type: 'uuid' }, displayName: s(), principalType: s({ enum: ['User'] }) } },
      resources: { table: 'Resources', fields: { id: { type: 'uuid' }, displayName: s(), resourceType: s() } },
      'resource-relationships': {
        table: 'ResourceRelationships',
        fields: { parentResourceId: { type: 'uuid' }, childResourceId: { type: 'uuid' }, relationshipType: s({ enum: ['Contains', 'HasOwnership'] }) },
      },
      'resource-assignments': {
        table: 'ResourceAssignments',
        fields: { principalId: { type: 'uuid' }, principalExternalId: s(), resourceId: { type: 'uuid' }, assignmentType: s({ enum: ['Direct', 'Eligible'] }) },
      },
    },
    resourceTypeLists: { 'test GROUPS': ['Group'] },
    principalTypeLists: { 'test HUMANS': ['User'] },
    ownership: { resourceTypes: ['GroupOwnership'], relationshipTypes: ['HasOwnership'] },
    access: { expands: ['Group'], never: ['GroupOwnership'] },
  };
}

/** Parse + build; throws on a syntax error so a broken fixture is loud. */
export function modelOf(ttl = MINI_TTL) {
  const parsed = parseOntology(ttl);
  if (parsed.errors) throw new Error(parsed.errors[0].message);
  return buildModel(parsed.store);
}

/** Replace exactly one occurrence, failing loudly if the fixture changed. */
export function edit(ttl, from, to) {
  if (!ttl.includes(from)) throw new Error(`fixture does not contain: ${from}`);
  return ttl.replace(from, to);
}

// Context types on top of the mini ontology: one plugin-produced type and one
// the code only compares against. Kept apart from MINI_TTL so the other checks'
// fixtures stay minimal; contextRegistry() is the registry half that agrees.
export const CONTEXT_TTL = `${MINI_TTL}
ia:producedBy a owl:AnnotationProperty . ia:allowedTargetType a owl:AnnotationProperty .
ia:Context a owl:Class ; rdfs:subClassOf ia:Node ; ${d('Context', 'A grouping.')} ;
    ia:table "Contexts" ; ia:identifierColumn "id" ; ia:identifierSqlType "uuid" ; ia:discriminator "contextType" ; ia:openVocabulary true .
ia:EntityKind a owl:Class ; ${d('Entity kind', 'What a context groups.')} .
ia:EntityKind_Principal a owl:NamedIndividual, ia:EntityKind ; ia:typeValue "Principal" ; ${d('Principal', 'Accounts.')} .
ia:EntityKind_Resource a owl:NamedIndividual, ia:EntityKind ; ia:typeValue "Resource" ; ${d('Resource', 'Resources.')} .
ia:OrganizationalUnit a owl:Class ; rdfs:subClassOf ia:Context ; ia:template true ; ${d('Organizational unit', 'Org structure.')} .
ia:ManagerHierarchyContext a owl:Class ; rdfs:subClassOf ia:OrganizationalUnit ; ia:typeValue "ManagerHierarchy" ;
    ia:producedBy "manager-hierarchy" ; ia:allowedTargetType ia:EntityKind_Principal ; ${d('Manager node', 'A team.')} .
ia:TagContext a owl:Class ; rdfs:subClassOf ia:Context ; ia:typeValue "Tag" ; ia:template true ;
    ia:allowedTargetType ia:EntityKind_Principal, ia:EntityKind_Resource ; ${d('Tag', 'A label.')} .
ia:targetType a owl:DatatypeProperty ; ia:sqlType "text" ; ia:valueScheme ia:EntityKind ;
    rdfs:domain ia:Context ; rdfs:range xsd:string ; ${d('targetType', 'What it groups.')} .
ia:parentContextId a owl:ObjectProperty ; ia:sqlType "uuid" ; rdfs:domain ia:Context ; rdfs:range ia:Context ; ${d('parentContextId', 'Parent.')} .
`;

/** Example instance data that is valid against CONTEXT_TTL; examplesOf() parses it. */
export const EXAMPLE_TTL = `
@prefix ia: <https://identityatlas.io/ontology#> .
@prefix ex: <https://identityatlas.io/example#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
ex:src a ia:System ; ia:displayName "Src" .
ex:acct a ia:User ; ia:displayName "acct" ; ia:systemId ex:src .
ex:grp a ia:Group ; ia:displayName "Grp" ; ia:systemId ex:src ; ia:hasOwnership ex:own .
ex:own a ia:GroupOwnership ; ia:displayName "Owners of Grp" ; rdfs:label "a label is fine" .
ex:a1 a ia:ResourceAssignment ; ia:principalId ex:acct ; ia:resourceId ex:grp ; ia:assignmentType "Direct" .
ex:root a ia:ManagerHierarchyContext ; ia:targetType "Principal" .
ex:team a ia:ManagerHierarchyContext ; ia:targetType "Principal" ; ia:parentContextId ex:root .
`;

/** miniRegistry() plus the context half that agrees with CONTEXT_TTL. */
export function contextRegistry() {
  return {
    ...miniRegistry(),
    contexts: {
      plugins: [{ name: 'manager-hierarchy', targetType: 'Principal', contextTypes: ['ManagerHierarchy'], contextCategory: 'OrganizationalUnit' }],
      branchedOn: new Map([['Tag', ['routes/tags.js:1']], ['ManagerHierarchy', ['routes/orgChart.js:9']]]),
    },
  };
}
