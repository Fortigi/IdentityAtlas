import { describe, it, expect } from 'vitest';
import { checkExample, exampleDiagram, readInstances } from './example.js';
import { parseOntology } from './model.js';
import { CONTEXT_TTL, EXAMPLE_TTL, edit, modelOf } from './__tests__/miniOntology.js';

const model = modelOf(CONTEXT_TTL);
const instancesOf = (ttl) => {
  const parsed = parseOntology(ttl);
  if (parsed.errors) throw new Error(parsed.errors[0].message);
  return readInstances(parsed.store);
};
// Each case changes ONE thing in the clean example and asserts the exact finding(s).
const findings = (ttl) => checkExample(model, instancesOf(ttl)).map(f => `${f.code} ${f.subject}`);

describe('readInstances', () => {
  it('collects types and values per named resource, references and literals apart', () => {
    const inst = instancesOf(EXAMPLE_TTL).get('https://identityatlas.io/example#acct');
    expect(inst.id).toBe('acct');
    expect(inst.types).toEqual(['User']);
    expect(inst.values.get('displayName')).toEqual([{ literal: 'acct' }]);
    expect(inst.values.get('systemId')).toEqual([{ iri: 'https://identityatlas.io/example#src' }]);
  });

  it('ignores blank-node subjects and keeps a foreign predicate under its full IRI', () => {
    const inst = instancesOf(`${EXAMPLE_TTL}\n[] ia:displayName "anon" .\nex:src <http://example.org/p> "x" .`);
    expect([...inst.keys()].every(k => k.startsWith('https://identityatlas.io/example#'))).toBe(true);
    expect(inst.get('https://identityatlas.io/example#src').values.has('http://example.org/p')).toBe(true);
  });
});

describe('checkExample', () => {
  it('finds nothing in the clean example', () => {
    expect(checkExample(model, instancesOf(EXAMPLE_TTL))).toEqual([]);
  });

  it('reports an empty example under its source name', () => {
    expect(checkExample(model, new Map(), 'ontology/examples/x.ttl')).toEqual([
      { code: 'example-empty', subject: 'ontology/examples/x.ttl', message: 'the example has no resources' },
    ]);
  });

  describe('types', () => {
    it('needs exactly one type', () => {
      expect(findings(`${EXAMPLE_TTL}
ex:two a ia:System, ia:User .`)).toEqual(['example-type example:two']);
      expect(findings(`${EXAMPLE_TTL}\nex:loose ia:displayName "no type" .`)).toEqual(['example-type example:loose']);
    });

    it('needs a core class', () => {
      expect(findings(`${EXAMPLE_TTL}
ex:typo a ia:Sistem .`)).toEqual(['example-type example:typo']);
    });

    it('rejects the structural superclasses and non-node classes', () => {
      expect(findings(`${EXAMPLE_TTL}
ex:abstract a ia:Node .`)).toEqual(['example-type example:abstract']);
      expect(findings(`${EXAMPLE_TTL}
ex:list a ia:EntityKind .`)).toEqual(['example-type example:list']);
    });
  });

  describe('properties', () => {
    it('rejects a property the ontology does not define', () => {
      const out = checkExample(model, instancesOf(edit(EXAMPLE_TTL, 'ia:displayName "Src"', 'ia:displayNaam "Src"')));
      expect(out.map(f => `${f.code} ${f.subject}`)).toEqual(['example-property example:src']);
      expect(out[0].message).toBe('displayNaam is not a core property');
    });

    it('rejects a property whose domain does not admit the class', () => {
      expect(findings(edit(EXAMPLE_TTL, 'ex:acct a ia:User ; ia:displayName "acct" ;', 'ex:acct a ia:User ; ia:displayName "acct" ; ia:assignmentType "Direct" ;')))
        .toEqual(['example-domain example:acct']);
    });

    it('accepts a property declared on a superclass (User is a Principal)', () => {
      expect(findings(EXAMPLE_TTL)).toEqual([]);
    });
  });

  describe('references', () => {
    it('rejects a reference to a resource that is not in the example', () => {
      expect(findings(edit(EXAMPLE_TTL, 'ia:principalId ex:acct', 'ia:principalId ex:ghost'))).toEqual(['example-dangling example:a1']);
    });

    it('rejects a reference to the wrong class, and says which', () => {
      const out = checkExample(model, instancesOf(edit(EXAMPLE_TTL, 'ia:principalId ex:acct', 'ia:principalId ex:grp')));
      expect(out.map(f => `${f.code} ${f.subject}`)).toEqual(['example-range example:a1']);
      expect(out[0].message).toBe('ia:principalId expects ia:Principal, grp is ia:Group');
    });

    it('checks a relationship-type shortcut against its range', () => {
      expect(findings(edit(EXAMPLE_TTL, 'ia:hasOwnership ex:own', 'ia:hasOwnership ex:grp'))).toEqual(['example-range example:grp']);
    });

    it('rejects a literal where a reference belongs, and a reference where a value belongs', () => {
      expect(findings(edit(EXAMPLE_TTL, 'ia:principalId ex:acct', 'ia:principalId "acct"'))).toEqual(['example-range example:a1']);
      expect(findings(edit(EXAMPLE_TTL, 'ia:hasOwnership ex:own', 'ia:hasOwnership "own"'))).toEqual(['example-range example:grp']);
      expect(findings(edit(EXAMPLE_TTL, 'ia:displayName "Src"', 'ia:displayName ex:acct'))).toEqual(['example-range example:src']);
    });
  });

  describe('values', () => {
    it('rejects a value outside a closed list', () => {
      const out = checkExample(model, instancesOf(edit(EXAMPLE_TTL, 'ia:assignmentType "Direct"', 'ia:assignmentType "Owner"')));
      expect(out.map(f => f.message)).toEqual(['ia:assignmentType "Owner" is not one of Direct, Eligible']);
    });

    it('rejects a targetType the context type does not allow', () => {
      const out = checkExample(model, instancesOf(edit(EXAMPLE_TTL, 'ex:root a ia:ManagerHierarchyContext ; ia:targetType "Principal"', 'ex:root a ia:ManagerHierarchyContext ; ia:targetType "Resource"')));
      expect(out.map(f => `${f.code} ${f.subject}`)).toEqual(['example-target-type example:root']);
      expect(out[0].message).toBe('a ManagerHierarchy context groups Principal, not Resource');
    });
  });

  it('requires an edge row to name both of its ends', () => {
    expect(findings(edit(EXAMPLE_TTL, 'ia:principalId ex:acct ; ', ''))).toEqual(['example-edge-ends example:a1']);
  });
});

describe('exampleDiagram', () => {
  it('boxes a system around its members, turns edge rows into arrows and draws references', () => {
    expect(exampleDiagram(model, instancesOf(EXAMPLE_TTL))).toBe([
      'flowchart LR',
      '    own["Owners of Grp<br/><small>Group ownership</small>"]:::Resource',
      '    root["root<br/><small>Manager node</small>"]:::Context',
      '    subgraph src["Src · System"]',
      '      acct["acct<br/><small>User</small>"]:::Principal',
      '      grp["Grp<br/><small>Group</small>"]:::Resource',
      '    end',
      '    team["team<br/><small>Manager node</small>"]:::Context',
      '    acct -->|"Direct"| grp',
      '    grp ==>|"HasOwnership"| own',
      '    team -.->|"parentContextId"| root',
      '    classDef Identity fill:#7c3aed,stroke:#5b21b6,color:#fff',
      '    classDef Principal fill:#2563eb,stroke:#1e40af,color:#fff',
      '    classDef Resource fill:#059669,stroke:#047857,color:#fff',
      '    classDef Context fill:#d97706,stroke:#b45309,color:#fff',
      '    classDef System fill:#475569,stroke:#334155,color:#fff',
    ].join('\n'));
  });

  it('labels a governed assignment, escapes quotes, and keeps a system without members as a node', () => {
    const ttl = edit(edit(EXAMPLE_TTL, 'ia:assignmentType "Direct" .', 'ia:assignmentType "Direct" ; ia:governed true .'), 'ia:displayName "Grp"', 'ia:displayName "Say \\"hi\\""')
      + '\nex:other a ia:System ; ia:displayName "Other" .\nex:acct2 a ia:User ; ia:systemId ex:nowhere .';
    const out = exampleDiagram(model, instancesOf(ttl));
    expect(out).toContain('    acct -->|"Direct, governed"| grp');
    expect(out).toContain('grp["Say #quot;hi#quot;<br/><small>Group</small>"]:::Resource');
    expect(out).toContain('    other["Other<br/><small>System</small>"]:::System');
    // A system reference that is not in the example is neither boxed nor drawn.
    expect(out).toContain('    acct2["acct2<br/><small>User</small>"]:::Principal');
    expect(out).not.toContain('nowhere');
  });

  it('names a system box after its id when the system has no displayName', () => {
    const out = exampleDiagram(model, instancesOf(edit(EXAMPLE_TTL, 'ex:src a ia:System ; ia:displayName "Src" .', 'ex:src a ia:System .')));
    expect(out).toContain('    subgraph src["src · System"]');
  });

  it('names an edge row without an assignment type after its class', () => {
    const ttl = `${CONTEXT_TTL}
ia:Membership a owl:Class ; rdfs:subClassOf ia:Edge ; rdfs:label "Team membership" ; rdfs:comment "x." ; rdfs:isDefinedBy <https://identityatlas.io/ontology> ;
    ia:table "M" ; ia:sourceProperty ia:fromId ; ia:targetProperty ia:toId .
ia:fromId a owl:ObjectProperty ; ia:sqlType "uuid" ; rdfs:domain ia:Membership ; rdfs:range ia:Context .
ia:toId a owl:ObjectProperty ; ia:sqlType "uuid" ; rdfs:domain ia:Membership ; rdfs:range ia:Principal .`;
    const ex = `${EXAMPLE_TTL}\nex:m a ia:Membership ; ia:fromId ex:team ; ia:toId ex:acct .`;
    expect(exampleDiagram(modelOf(ttl), instancesOf(ex))).toContain('    team -->|"team membership"| acct');
  });
});
