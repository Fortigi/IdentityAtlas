import { describe, it, expect } from 'vitest';
import { checkTemplates } from './templates.js';
import { checkImplementation } from './implementation.js';
import { CONTEXT_TTL, MINI_TTL, edit, miniRegistry, modelOf } from '../__tests__/miniOntology.js';

// Each case changes ONE thing in the clean fixture and asserts the exact finding(s).
const run = (ttl = MINI_TTL, registry = miniRegistry()) => checkTemplates(modelOf(ttl), registry).map(f => `${f.code} ${f.subject}`);
const DEF = 'rdfs:label "x" ; rdfs:comment "x." ; rdfs:isDefinedBy <https://identityatlas.io/ontology>';

describe('checkTemplates', () => {
  it('finds nothing in the clean fixtures, with and without a registry', () => {
    expect(checkTemplates(modelOf(), miniRegistry())).toEqual([]);
    expect(checkTemplates(modelOf(CONTEXT_TTL), miniRegistry())).toEqual([]);
    expect(checkTemplates(modelOf())).toEqual([]);
    expect(checkImplementation(modelOf(CONTEXT_TTL), miniRegistry(), {})).toEqual([]);
  });

  describe('template tree', () => {
    it('fails for a type with no template above it', () => {
      const ttl = `${MINI_TTL}\nia:Robot a owl:Class ; rdfs:subClassOf ia:Principal ; ia:typeValue "Robot" ; ${DEF} .`;
      expect(run(ttl)).toEqual(['template-missing ia:Robot']);
    });

    it('fails for a type under two templates', () => {
      const ttl = edit(MINI_TTL, 'ia:ControlPermission a owl:Class ; rdfs:subClassOf ia:Permission ;', 'ia:ControlPermission a owl:Class ; rdfs:subClassOf ia:Permission ; ia:template true ;');
      const out = checkTemplates(modelOf(ttl), miniRegistry());
      expect(out.map(f => `${f.code} ${f.subject}`)).toEqual(['template-ambiguous ia:GroupOwnership']);
      expect(out[0].message).toBe('type "GroupOwnership" is under 2 templates: ia:ControlPermission, ia:Permission');
    });

    it('accepts a type that is its own template', () => {
      // Group carries ia:template itself in the fixture.
      expect(run()).toEqual([]);
    });

    it('rejects a template outside the three kinds of node', () => {
      const ttl = `${MINI_TTL}\nia:Odd a owl:Class ; rdfs:subClassOf ia:System ; ia:template true ; ${DEF} .`;
      expect(run(ttl)).toEqual(['template-misplaced ia:Odd']);
    });
  });

  describe('expandsAccess ↔ the engine', () => {
    it('fails when the engine expands a type the ontology does not mark', () => {
      const registry = miniRegistry();
      registry.access.expands = ['Group', 'GroupOwnership'];
      const out = checkTemplates(modelOf(), registry);
      expect(out.map(f => `${f.code} ${f.subject}`)).toEqual(['expands-access-mismatch Resource:GroupOwnership']);
      expect(out[0].message).toContain('GROUP_RESOURCE_TYPES');
    });

    it('fails when the ontology marks a type true that the engine does not expand', () => {
      const ttl = edit(MINI_TTL, 'ia:template true ; ia:expandsAccess true ;', 'ia:template true ;') + '\nia:TechnicalRole ia:expandsAccess true .';
      // Group lost its mark (engine expands it: missing) and TechnicalRole has no types, so only Group is reported.
      expect(run(ttl)).toEqual(['expands-access-mismatch Resource:Group']);
    });

    it('fails when ownership types lose their false, or a non-ownership type gets it', () => {
      const lost = edit(MINI_TTL, 'ia:ControlPermission a owl:Class ; rdfs:subClassOf ia:Permission ; ia:expandsAccess false ;', 'ia:ControlPermission a owl:Class ; rdfs:subClassOf ia:Permission ;');
      expect(run(lost)).toEqual(['expands-access-mismatch Resource:GroupOwnership']);
      const extra = `${MINI_TTL}\nia:AppRole a owl:Class ; rdfs:subClassOf ia:TechnicalRole ; ia:typeValue "AppRole" ; ia:expandsAccess false ; ${DEF} .`;
      expect(run(extra)).toEqual(['expands-access-mismatch Resource:AppRole']);
    });

    it('is inherited from the nearest ancestor', () => {
      const ttl = `${MINI_TTL}\nia:AppOwnership a owl:Class ; rdfs:subClassOf ia:ControlPermission ; ia:typeValue "AppOwnership" ; ${DEF} .\nia:hasOwnership rdfs:range ia:AppOwnership .`;
      const registry = miniRegistry();
      registry.ownership.resourceTypes = ['GroupOwnership', 'AppOwnership'];
      registry.access.never = ['GroupOwnership', 'AppOwnership'];
      // Inherits false from ControlPermission: nothing to report about expandsAccess.
      expect(run(ttl, registry).filter(f => f.startsWith('expands-access'))).toEqual([]);
    });

    it('skips the comparison when the registry has no lists', () => {
      expect(run(MINI_TTL, {})).toEqual([]);
    });
  });

  describe('control permissions are linked to what they control', () => {
    it('fails when a control permission is the range of no ownership relationship', () => {
      const ttl = `${MINI_TTL}\nia:AppOwnership a owl:Class ; rdfs:subClassOf ia:ControlPermission ; ia:typeValue "AppOwnership" ; ${DEF} .`;
      const out = checkTemplates(modelOf(ttl), {});
      expect(out.map(f => `${f.code} ${f.subject}`)).toEqual(['control-permission-link ia:AppOwnership']);
      expect(out[0].message).toContain('is the range of none');
    });

    it('ignores relationships that may reach any resource (Contains)', () => {
      // contains has range ia:Resource in the fixture: it must not count as a link to GroupOwnership.
      expect(run()).toEqual([]);
    });
  });

  describe('accountability defaults', () => {
    const list = `ia:Accountability a owl:Class ; ${DEF} .\nia:Accountability_Personal a owl:NamedIndividual, ia:Accountability ; ia:typeValue "Personal" ; ${DEF} .`;

    it('accepts a default on a principal type that names an Accountability value', () => {
      expect(run(`${MINI_TTL}\n${list}\nia:User ia:accountabilityDefault ia:Accountability_Personal .`)).toEqual([]);
    });

    it('rejects a default on a non-principal or an untyped class', () => {
      expect(run(`${MINI_TTL}\n${list}\nia:Group ia:accountabilityDefault ia:Accountability_Personal .`)).toEqual(['accountability-default-misplaced ia:Group']);
      expect(run(`${MINI_TTL}\n${list}\nia:Person ia:accountabilityDefault ia:Accountability_Personal .`)).toEqual(['accountability-default-misplaced ia:Person']);
    });

    it('rejects a default that is not an Accountability value', () => {
      expect(run(`${MINI_TTL}\n${list}\nia:User ia:accountabilityDefault ia:AssignmentType_Direct .`)).toEqual(['accountability-default-invalid ia:User']);
    });
  });

  describe('holding stays closed', () => {
    it('fails for a second edge table from an account to a resource', () => {
      const ttl = `${MINI_TTL}
ia:Grant a owl:Class ; rdfs:subClassOf ia:Edge ; ${DEF} ; ia:table "Grants" ; ia:sourceProperty ia:grantPrincipalId ; ia:targetProperty ia:grantResourceId .
ia:grantPrincipalId a owl:ObjectProperty ; ia:sqlType "uuid" ; rdfs:domain ia:Grant ; rdfs:range ia:Principal ; ${DEF} .
ia:grantResourceId a owl:ObjectProperty ; ia:sqlType "uuid" ; rdfs:domain ia:Grant ; rdfs:range ia:Resource ; ${DEF} .`;
      const out = checkTemplates(modelOf(ttl), {});
      expect(out.map(f => `${f.code} ${f.subject}`)).toEqual(['holding-bypass ia:Grant']);
      expect(out[0].message).toContain('Direct, Indirect, Eligible');
    });

    it('allows an edge from a person to an account, and from a resource to a resource', () => {
      // IdentityMembers-like and ResourceRelationships-like edges are fine.
      const ttl = `${MINI_TTL}
ia:Link a owl:Class ; rdfs:subClassOf ia:Edge ; ${DEF} ; ia:table "Links" ; ia:sourceProperty ia:fromId ; ia:targetProperty ia:toId .
ia:fromId a owl:ObjectProperty ; ia:sqlType "uuid" ; rdfs:domain ia:Link ; rdfs:range ia:Principal ; ${DEF} .
ia:toId a owl:ObjectProperty ; ia:sqlType "uuid" ; rdfs:domain ia:Link ; rdfs:range ia:Principal ; ${DEF} .`;
      expect(run(ttl)).toEqual([]);
    });
  });
});
