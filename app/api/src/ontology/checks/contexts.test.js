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
      const ttl = `${CONTEXT_TTL}\nia:TeamContext a owl:Class ; rdfs:subClassOf ia:Context ; ia:typeValue "Team" ; ia:producedBy "manager-hierarchy" ; ia:allowedTargetType ia:EntityKind_Principal .`;
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
