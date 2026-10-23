import { describe, it, expect } from 'vitest';
import { coreClassDiagram, coreErDiagram, coreOverviewDiagram, GENERATED_DIAGRAMS } from './mermaid.js';
import { MINI_TTL, edit, modelOf } from './__tests__/miniOntology.js';

describe('coreErDiagram', () => {
  const er = coreErDiagram(modelOf());

  it('draws every table, sorted, with only its structural columns', () => {
    expect(er).toBe([
      'erDiagram',
      '    Principals {',
      '        uuid id PK',
      '        string displayName',
      '        string principalType "User"',
      '        int systemId FK',
      '    }',
      '    ResourceAssignments {',
      '        string assignmentType "Direct, Eligible"',
      '        uuid principalId FK',
      '        uuid resourceId FK',
      '    }',
      '    ResourceRelationships {',
      '        uuid childResourceId FK',
      '        uuid parentResourceId FK',
      '        string relationshipType "Contains, HasOwnership"',
      '    }',
      '    Resources {',
      '        uuid id PK',
      '        string displayName',
      '        string resourceType "open vocabulary"',
      '        int systemId FK',
      '    }',
      '    Systems {',
      '        int id PK',
      '        string displayName',
      '    }',
      '',
      '    Systems |o--o{ Principals : "systemId"',
      '    Principals |o--o{ ResourceAssignments : "principalId"',
      '    Resources |o--o{ ResourceAssignments : "resourceId"',
      '    Resources |o--o{ ResourceRelationships : "childResourceId"',
      '    Resources |o--o{ ResourceRelationships : "parentResourceId"',
      '    Systems |o--o{ Resources : "systemId"',
    ].join('\n'));
  });
});

describe('coreClassDiagram', () => {
  const cd = coreClassDiagram(modelOf()).split('\n');

  it('declares the node classes and their subclasses, not edges or value lists', () => {
    const declared = cd.filter(l => l.startsWith('    class ')).map(l => l.trim().slice(6));
    expect(declared).toEqual(['ControlPermission', 'Group', 'GroupOwnership', 'Permission', 'Person', 'Principal', 'Resource', 'System', 'TechnicalRole', 'User']);
  });

  it('draws inheritance but not the abstract Node root', () => {
    const inherits = cd.filter(l => l.includes('<|--')).map(l => l.trim());
    expect(inherits).toEqual(['Permission <|-- ControlPermission', 'Resource <|-- Group', 'ControlPermission <|-- GroupOwnership', 'Resource <|-- Permission', 'Principal <|-- Person', 'Resource <|-- TechnicalRole', 'Person <|-- User']);
  });

  it('draws each relationship type between its domain and range', () => {
    const rels = cd.filter(l => l.includes('-->')).map(l => l.trim());
    expect(rels).toEqual(['Resource --> Resource : Contains', 'Resource --> GroupOwnership : HasOwnership']);
  });
});

it('registers the model generators by id', () => {
  expect(Object.keys(GENERATED_DIAGRAMS).sort()).toEqual(['core-classes', 'core-erd', 'core-overview']);
});

describe('coreOverviewDiagram', () => {
  it('draws the node tables, an arrow per edge table with its relationship types, and dotted foreign keys', () => {
    expect(coreOverviewDiagram(modelOf())).toBe([
      'flowchart LR',
      '    Principal["Principal<br/><small>Principals</small>"]:::Principal',
      '    Resource["Resource<br/><small>Resources</small>"]:::Resource',
      '    System["System<br/><small>Systems</small>"]:::System',
      '    Principal -->|"ResourceAssignments"| Resource',
      '    Resource -->|"ResourceRelationships<br/><small>Contains, HasOwnership</small>"| Resource',
      '    Principal -.->|"systemId"| System',
      '    Resource -.->|"systemId"| System',
      '    classDef Principal fill:#2563eb,stroke:#1e40af,color:#fff',
      '    classDef Resource fill:#059669,stroke:#047857,color:#fff',
      '    classDef System fill:#475569,stroke:#334155,color:#fff',
    ].join('\n'));
  });

  it('draws one arrow per pair even when an edge table names the same end twice', () => {
    const ttl = edit(MINI_TTL, 'ia:sourceProperty ia:principalId ;', 'ia:sourceProperty ia:principalId, ia:principalId ;');
    expect(coreOverviewDiagram(modelOf(ttl)).split('\n').filter(l => l.includes('ResourceAssignments'))).toHaveLength(1);
  });

  it('draws no arrow for an edge end that names an undeclared property', () => {
    const ttl = edit(MINI_TTL, 'ia:sourceProperty ia:principalId ;', 'ia:sourceProperty ia:missingId ;');
    expect(coreOverviewDiagram(modelOf(ttl))).not.toContain('ResourceAssignments');
  });

  it('leaves a node without a known colour unstyled', () => {
    const ttl = `${MINI_TTL}\nia:Thing a owl:Class ; rdfs:subClassOf ia:Node ; rdfs:label "Thing" ; ia:table "Things" .`;
    const out = coreOverviewDiagram(modelOf(ttl));
    expect(out).toContain('    Thing["Thing<br/><small>Things</small>"]:::Thing');
    expect(out).not.toContain('classDef Thing');
  });
});
