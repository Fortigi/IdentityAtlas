import { describe, it, expect } from 'vitest';
import { checkContextTypes } from './contexts.js';
import { checkImplementation } from './implementation.js';
import { checkIntegrity } from './integrity.js';
import { CONTEXT_TTL, contextRegistry, edit, miniRegistry, modelOf } from '../__tests__/miniOntology.js';

// Each case changes ONE thing in the clean context fixture and asserts the exact
// finding(s), so a check that fires for the wrong reason fails the test.
const run = ({ ttl = CONTEXT_TTL, registry = contextRegistry() } = {}) =>
  checkContextTypes(modelOf(ttl), registry).map(f => `${f.code} ${f.subject}`);

const plugin = (registry) => registry.contexts.plugins[0];

describe('checkContextTypes', () => {
  it('finds nothing when the fixture ontology and registry agree — through every check', () => {
    expect(checkContextTypes(modelOf(CONTEXT_TTL), contextRegistry())).toEqual([]);
    expect(checkImplementation(modelOf(CONTEXT_TTL), contextRegistry(), {})).toEqual([]);
    expect(checkIntegrity(modelOf(CONTEXT_TTL))).toEqual([]);
  });

  it('skips the check when the registry has no context half', () => {
    expect(checkContextTypes(modelOf(CONTEXT_TTL), miniRegistry())).toEqual([]);
  });

  describe('plugin → ontology', () => {
    // The required demonstration at unit level: a plugin starts emitting a
    // context type the ontology does not define.
    it('fails when a plugin declares a context type the ontology lacks', () => {
      const registry = contextRegistry();
      plugin(registry).contextTypes.push('ManagerHierarchyRoot');
      const out = checkContextTypes(modelOf(CONTEXT_TTL), registry);
      expect(out).toEqual([{
        code: 'context-type-undefined',
        subject: 'Context:ManagerHierarchyRoot',
        message: 'plugin manager-hierarchy emits "ManagerHierarchyRoot", which is not a subclass of ia:Context in the ontology',
      }]);
    });

    it('fails when a plugin declares no contextTypes at all', () => {
      const registry = contextRegistry();
      delete plugin(registry).contextTypes;
      // ManagerHierarchy is still compared against in the code, so only the plugin
      // finding and the now-stale producer appear.
      expect(run({ registry })).toEqual([
        'plugin-context-types-undeclared plugin:manager-hierarchy',
        'context-producer-stale ia:ManagerHierarchyContext',
      ]);
    });

    it('treats an empty contextTypes list as undeclared', () => {
      const registry = contextRegistry();
      plugin(registry).contextTypes = [];
      expect(run({ registry })).toContain('plugin-context-types-undeclared plugin:manager-hierarchy');
    });

    it('fails when the ontology does not name the plugin that emits the type', () => {
      const registry = contextRegistry();
      registry.contexts.plugins.push({ name: 'manager-hierarchy-v2', targetType: 'Principal', contextTypes: ['ManagerHierarchy'] });
      expect(run({ registry })).toEqual(['context-producer-undeclared ia:ManagerHierarchyContext']);
    });

    it('fails when the plugin targetType is not an allowed target of the type', () => {
      const registry = contextRegistry();
      plugin(registry).targetType = 'Resource';
      const out = checkContextTypes(modelOf(CONTEXT_TTL), registry);
      expect(out.map(f => `${f.code} ${f.subject}`)).toEqual(['context-target-type-mismatch ia:ManagerHierarchyContext']);
      expect(out[0].message).toBe('plugin manager-hierarchy emits it with targetType Resource, but ia:allowedTargetType admits only Principal');
    });

    it('names "nothing" when a type admits no target type', () => {
      const ttl = edit(CONTEXT_TTL, 'ia:producedBy "manager-hierarchy" ; ia:allowedTargetType ia:EntityKind_Principal ;', 'ia:producedBy "manager-hierarchy" ;');
      const out = checkContextTypes(modelOf(ttl), contextRegistry());
      expect(out.map(f => f.message)).toEqual(['plugin manager-hierarchy emits it with targetType Principal, but ia:allowedTargetType admits only nothing']);
    });
  });

  describe('ontology → plugin', () => {
    it('fails when ia:producedBy names a plugin that is not registered', () => {
      const ttl = edit(CONTEXT_TTL, 'ia:typeValue "Tag" ;', 'ia:typeValue "Tag" ; ia:producedBy "tagger" ;');
      expect(run({ ttl })).toEqual(['context-producer-unknown ia:TagContext']);
    });

    it('fails when the named plugin no longer declares the type (a renamed type)', () => {
      const registry = contextRegistry();
      plugin(registry).contextTypes = ['Team'];
      const ttl = `${CONTEXT_TTL}\nia:TeamContext a owl:Class ; rdfs:subClassOf ia:OrganizationalUnit ; ia:typeValue "Team" ; ia:producedBy "manager-hierarchy" ; ia:allowedTargetType ia:EntityKind_Principal .`;
      expect(run({ ttl, registry })).toEqual(['context-producer-stale ia:ManagerHierarchyContext']);
    });
  });

  describe('code comparisons', () => {
    it('fails when the code compares against an undefined context type, and says where', () => {
      const registry = contextRegistry();
      registry.contexts.branchedOn.set('OrgUnit', ['app/ui/src/X.jsx:4', 'routes/y.js:7']);
      const out = checkContextTypes(modelOf(CONTEXT_TTL), registry);
      expect(out).toEqual([{
        code: 'context-type-undefined',
        subject: 'Context:OrgUnit',
        message: 'the code compares against "OrgUnit" (app/ui/src/X.jsx:4, routes/y.js:7) but it is not a subclass of ia:Context in the ontology',
      }]);
    });

    it('fails for a defined type that nothing produces and nothing compares against', () => {
      const registry = contextRegistry();
      registry.contexts.branchedOn.delete('Tag');
      expect(run({ registry })).toEqual(['context-type-unused ia:TagContext']);
    });

    it('accepts a produced type that no code compares against', () => {
      const registry = contextRegistry();
      registry.contexts.branchedOn.delete('ManagerHierarchy');
      expect(run({ registry })).toEqual([]);
    });
  });
});

describe('checkIntegrity — context-type annotations', () => {
  const findings = (ttl) => checkIntegrity(modelOf(ttl)).map(f => `${f.code} ${f.subject}`);

  it('requires every typed context class to name what it groups', () => {
    const ttl = edit(CONTEXT_TTL, '    ia:allowedTargetType ia:EntityKind_Principal, ia:EntityKind_Resource ;', '   ');
    expect(findings(ttl)).toEqual(['context-target-type-missing ia:TagContext']);
  });

  it('requires ia:allowedTargetType to be an ia:EntityKind value', () => {
    const ttl = edit(CONTEXT_TTL, 'ia:allowedTargetType ia:EntityKind_Principal, ia:EntityKind_Resource ;', 'ia:allowedTargetType ia:EntityKind_Principal, ia:AssignmentType_Direct ;');
    expect(findings(ttl)).toEqual(['context-target-type-invalid ia:TagContext']);
  });

  it('rejects the context annotations on a class that is not a context', () => {
    const ttl = edit(CONTEXT_TTL, 'ia:Group a owl:Class ; rdfs:subClassOf ia:Resource ;', 'ia:Group a owl:Class ; rdfs:subClassOf ia:Resource ; ia:producedBy "x" ;');
    expect(findings(ttl)).toEqual(['context-annotation-misplaced ia:Group']);
    const onContextItself = edit(CONTEXT_TTL, 'ia:discriminator "contextType" ;', 'ia:discriminator "contextType" ; ia:allowedTargetType ia:EntityKind_Principal ;');
    expect(findings(onContextItself)).toEqual(['context-annotation-misplaced ia:Context']);
  });

  it('does not require a target type on an untyped context subclass (a grouping superclass)', () => {
    const ttl = `${CONTEXT_TTL}\nia:TreeContext a owl:Class ; rdfs:subClassOf ia:Context ; rdfs:label "Tree" ; rdfs:comment "Any tree." ; rdfs:isDefinedBy <https://identityatlas.io/ontology> .`;
    expect(findings(ttl)).toEqual([]);
  });
});

describe('checkContextTypes — the template value list and plugin templates', () => {
  const scheme = `
ia:denotesTemplate a owl:AnnotationProperty .
ia:ContextCategory a owl:Class ; rdfs:label "Context category" ; rdfs:comment "x." ; rdfs:isDefinedBy <https://identityatlas.io/ontology> .
ia:ContextCategory_OrganizationalUnit a owl:NamedIndividual, ia:ContextCategory ; ia:typeValue "OrganizationalUnit" ; ia:denotesTemplate ia:OrganizationalUnit ; rdfs:label "OU" ; rdfs:comment "x." ; rdfs:isDefinedBy <https://identityatlas.io/ontology> .
ia:ContextCategory_Tag a owl:NamedIndividual, ia:ContextCategory ; ia:typeValue "Tag" ; ia:denotesTemplate ia:TagContext ; rdfs:label "Tag" ; rdfs:comment "x." ; rdfs:isDefinedBy <https://identityatlas.io/ontology> .`;
  const WITH = `${CONTEXT_TTL}${scheme}`;

  it('accepts a value list that names every template under ia:Context exactly once', () => {
    expect(run({ ttl: WITH })).toEqual([]);
  });

  it('is silent when the ontology declares no value list yet', () => {
    expect(run({ ttl: CONTEXT_TTL })).toEqual([]);
  });

  it('fails for a value that names no template, a template no value names, and a template named twice', () => {
    const noTemplate = edit(WITH, 'ia:denotesTemplate ia:TagContext ;', 'ia:denotesTemplate ia:ManagerHierarchyContext ;');
    expect(run({ ttl: noTemplate })).toEqual(['context-category-template ia:ContextCategory_Tag', 'context-category-template ia:TagContext']);
    const missing = edit(WITH, 'ia:denotesTemplate ia:TagContext ;', '');
    expect(run({ ttl: missing })).toEqual(['context-category-template ia:ContextCategory_Tag', 'context-category-template ia:TagContext']);
    const twice = edit(WITH, 'ia:denotesTemplate ia:TagContext ;', 'ia:denotesTemplate ia:OrganizationalUnit ;');
    expect(run({ ttl: twice })).toEqual(['context-category-template ia:TagContext', 'context-category-template ia:OrganizationalUnit']);
  });

  it('resolves a plugin template through the value list, and through the class name without one', () => {
    expect(run({ ttl: WITH })).toEqual([]);
    const registry = contextRegistry();
    plugin(registry).contextCategory = 'Nowhere';
    expect(run({ ttl: WITH, registry })).toEqual(['plugin-category-undefined plugin:manager-hierarchy']);
  });

  it('fails when a plugin emits a type that is not under its template', () => {
    const registry = contextRegistry();
    plugin(registry).contextCategory = 'Tag';
    const out = checkContextTypes(modelOf(WITH), registry);
    expect(out.map(f => `${f.code} ${f.subject}`)).toEqual(['plugin-category-mismatch plugin:manager-hierarchy']);
    expect(out[0].message).toBe('emits "ManagerHierarchy" (ia:ManagerHierarchyContext), which is not under its template ia:TagContext');
  });

  it('ignores a plugin that declares no template', () => {
    const registry = contextRegistry();
    delete plugin(registry).contextCategory;
    expect(run({ ttl: WITH, registry })).toEqual([]);
  });
});
