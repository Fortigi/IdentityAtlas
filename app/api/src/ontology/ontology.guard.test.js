// Guard: the committed core ontology agrees with the code, and the generated
// docs are current. This is the same check `npm run ontology:check` runs; it is
// also a test so the API Vitest job — which feeds `CI Passed` — fails on drift
// even if someone drops the explicit CI step.

import { describe, it, expect } from 'vitest';
import { runCheck, loadConfig } from './cli.js';
import { loadRegistry } from './registry.js';
import { RELATIONSHIP_TYPES, PRINCIPAL_TYPES, ASSIGNMENT_TYPES } from '../ingest/validation.js';
import { OWNERSHIP_RESOURCE_TYPES } from '../lib/ownershipTypes.js';

describe('core ontology (repository)', () => {
  const result = runCheck();

  it('has no findings', () => {
    const lines = result.errors.map(e => `${e.code} ${e.subject}: ${e.message}`);
    expect(lines, `run "npm run ontology:check" in app/api for details:\n${lines.join('\n')}`).toEqual([]);
  });

  it('accepts exactly the known gaps listed in ontology/validation.json', () => {
    const listed = loadConfig().knownGaps.filter(g => (g.scope ?? 'static') === 'static').map(g => `${g.code} ${g.subject}`).sort();
    expect(result.accepted.map(a => `${a.code} ${a.subject}`).sort()).toEqual(listed);
  });

  it('reads the registries from the code, not from a copy', () => {
    const r = loadRegistry();
    expect(r.ingest['resource-relationships'].fields.relationshipType.enum).toBe(RELATIONSHIP_TYPES);
    expect(r.ingest.principals.fields.principalType.enum).toBe(PRINCIPAL_TYPES);
    expect(r.ingest['resource-assignments'].fields.assignmentType.enum).toBe(ASSIGNMENT_TYPES);
    expect(r.ownership.resourceTypes).toBe(OWNERSHIP_RESOURCE_TYPES);
  });

  it('classifies every erDiagram / classDiagram in the docs', () => {
    const data = result.inventory.filter(d => d.kind === 'erDiagram' || d.kind === 'classDiagram');
    expect(data.filter(d => d.classification === 'unclassified')).toEqual([]);
    // The two generated diagrams this feature promises.
    expect(data.filter(d => d.classification === 'generated').map(d => d.path).sort())
      .toEqual(['docs/concepts/data-model.md', 'docs/reference/core-model.md']);
  });

  it('fails for a relationship type the ingest accepts but the ontology lacks', () => {
    const registry = loadRegistry();
    const rr = registry.ingest['resource-relationships'];
    registry.ingest['resource-relationships'] = {
      ...rr, fields: { ...rr.fields, relationshipType: { ...rr.fields.relationshipType, enum: [...RELATIONSHIP_TYPES, 'Mirrors'] } },
    };
    expect(runCheck({ registry }).errors.map(e => `${e.code} ${e.subject}`))
      .toEqual(['value-missing-from-ontology resource-relationships.relationshipType']);
  });
});
