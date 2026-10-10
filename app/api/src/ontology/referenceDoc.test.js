import { describe, it, expect } from 'vitest';
import { renderReference } from './referenceDoc.js';
import { coreClassDiagram } from './mermaid.js';
import { MINI_TTL, modelOf } from './__tests__/miniOntology.js';

describe('renderReference', () => {
  const md = renderReference(modelOf());
  const lines = md.split('\n');

  it('starts with the title and the generated-page notice, ends with one newline', () => {
    expect(lines[0]).toBe('# Core Model Reference');
    expect(lines[2]).toBe('!!! info "Generated page"');
    expect(md.endsWith('|\n')).toBe(true);
  });

  it('embeds the class diagram inside a generated region', () => {
    const begin = lines.indexOf('<!-- BEGIN GENERATED: ontology core-classes -->');
    const end = lines.indexOf('<!-- END GENERATED: ontology core-classes -->');
    expect(begin).toBeGreaterThan(0);
    expect(lines.slice(begin + 1, end).join('\n')).toBe(['```mermaid', coreClassDiagram(modelOf()), '```'].join('\n'));
  });

  it('puts node tables before edge tables, each sorted by table name', () => {
    const headings = lines.filter(l => /^##+ /.test(l));
    expect(headings).toEqual([
      '## Type hierarchy and relationship types',
      '## Node tables', '### Principals', '### Resources', '### Systems',
      '## Edge tables', '### ResourceAssignments', '### ResourceRelationships',
      '## Value lists', '### Assignment type',
    ]);
  });

  it('lists a closed discriminator as exact values and an open one as an open vocabulary', () => {
    expect(md).toContain('`principalType` accepts exactly these values:');
    expect(md).toContain('`resourceType` is an open vocabulary — any value is accepted.');
    // An ownership subclass names its intermediate parent.
    expect(md).toContain('| `GroupOwnership` | `ia:GroupOwnership` | (ia:OwnershipResource) Owners of a group. |');
  });

  it('renders a column row with its references, values and ingest aliases', () => {
    expect(md).toContain('| `principalId` | `ia:principalId` | uuid | → Principals | Holder. Ingest alias: `principalExternalId`. |');
    expect(md).toContain('| `assignmentType` | `ia:assignmentType` | text | `Direct`, `Eligible` | How. |');
    expect(md).toContain('| `resourceType` | `ia:resourceType` | text | open vocabulary | Kind. |');
  });

  it('lists the relationship types of an edge table with their endpoints', () => {
    expect(md).toContain('| `HasOwnership` | `ia:hasOwnership` | ia:Resource → ia:GroupOwnership | Owned to ownership. |');
  });

  it('marks retired and unused columns', () => {
    const ttl = `${MINI_TTL}\nia:displayName <http://www.w3.org/2002/07/owl#deprecated> true ; ia:status "unused" .`;
    expect(renderReference(modelOf(ttl))).toContain('| **Retired.** **Unused.** Name. |');
  });

  it('escapes a pipe inside a description so the table survives', () => {
    const ttl = MINI_TTL.replace('rdfs:comment "Kind." ; rdfs:isDefinedBy <https://identityatlas.io/ontology> .\nia:resourceType', 'rdfs:comment "A | B." ; rdfs:isDefinedBy <https://identityatlas.io/ontology> .\nia:resourceType');
    expect(renderReference(modelOf(ttl))).toContain('A \\| B.');
  });

  it('says which columns use each value list', () => {
    expect(md).toContain('`ia:AssignmentType` — How it is held. Used by `ResourceAssignments.assignmentType`.');
  });
});
