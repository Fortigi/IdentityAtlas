import { describe, it, expect } from 'vitest';
import { SOFT_DELETE_TABLES } from './engine.js';

// Locks which entity tables soft-delete (stamp deletedAt) vs hard-delete. The
// engine and the ingest route both branch on this set, so a regression here would
// silently change deletion semantics for an entire entity type.
describe('SOFT_DELETE_TABLES', () => {
  it('soft-deletes principals, resources, and assignments', () => {
    expect(SOFT_DELETE_TABLES.has('Principals')).toBe(true);
    expect(SOFT_DELETE_TABLES.has('Resources')).toBe(true);
    expect(SOFT_DELETE_TABLES.has('ResourceAssignments')).toBe(true);
  });

  it('leaves every other table hard-deleting', () => {
    for (const t of ['Systems', 'ResourceRelationships', 'Contexts', 'ContextMembers', 'Identities', 'IdentityMembers']) {
      expect(SOFT_DELETE_TABLES.has(t)).toBe(false);
    }
  });
});
