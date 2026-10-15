import { describe, it, expect } from 'vitest';
import { coreClassDiagram, coreErDiagram, GENERATED_DIAGRAMS } from './mermaid.js';
import { modelOf } from './__tests__/miniOntology.js';

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
    expect(declared).toEqual(['Group', 'GroupOwnership', 'OwnershipResource', 'Principal', 'Resource', 'System', 'User']);
  });

  it('draws inheritance but not the abstract Node root', () => {
    const inherits = cd.filter(l => l.includes('<|--')).map(l => l.trim());
    expect(inherits).toEqual(['Resource <|-- Group', 'OwnershipResource <|-- GroupOwnership', 'Resource <|-- OwnershipResource', 'Principal <|-- User']);
  });

  it('draws each relationship type between its domain and range', () => {
    const rels = cd.filter(l => l.includes('-->')).map(l => l.trim());
    expect(rels).toEqual(['Resource --> Resource : Contains', 'Resource --> GroupOwnership : HasOwnership']);
  });
});

it('registers both generators by id', () => {
  expect(Object.keys(GENERATED_DIAGRAMS).sort()).toEqual(['core-classes', 'core-erd']);
});
