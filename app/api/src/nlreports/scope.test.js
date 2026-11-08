// The row scope's own rules: which predicate each table gets, that every table
// the catalog reads has one, and that an unknown table fails closed. Whether the
// predicates SELECT the right rows is proven against PostgreSQL, next to the
// REST tiers they share (contract-tests/authzSecurity.integration.test.js).

import { describe, it, expect } from 'vitest';
import { scopePredicate, createRowScope, SCOPED_TABLES } from './scope.js';
import { OPENABLE_SQL } from '../auth/ownerAccess/tiers.js';
import { ENTITIES } from './catalog.js';

const REF = '$1::uuid[]';

describe('SCOPED_TABLES', () => {
  it('covers every table the report catalog reads a record from — a new entity cannot run unscoped by accident', () => {
    const tables = new Set(Object.values(ENTITIES).map(e => e.table));
    for (const table of tables) expect(SCOPED_TABLES).toContain(table);
  });

  it('covers every table a relation reaches', () => {
    for (const entity of Object.values(ENTITIES)) {
      for (const rel of Object.values(entity.relations)) expect(SCOPED_TABLES).toContain(ENTITIES[rel.target].table);
    }
  });
});

describe('scopePredicate', () => {
  it('uses the REST tier predicate of the matching kind, on the row\'s own id', () => {
    expect(scopePredicate('Principals', 't0', REF)).toBe(OPENABLE_SQL.principal('t0."id"', REF));
    expect(scopePredicate('Identities', 't1', REF)).toBe(OPENABLE_SQL.identity('t1."id"', REF));
    expect(scopePredicate('Resources', 't2', REF)).toBe(OPENABLE_SQL.resource('t2."id"', REF));
    expect(scopePredicate('Contexts', 't3', REF)).toBe('t3."id" = ANY($1::uuid[])');
  });

  it('lets a change through when either its account or its resource opens', () => {
    expect(scopePredicate('AssignmentChanges', 't0', REF)).toBe(
      `(${OPENABLE_SQL.principal('t0."principalId"', REF)} OR ${OPENABLE_SQL.resource('t0."resourceId"', REF)})`,
    );
  });

  it('refuses a table it has no rule for, instead of leaving it unscoped', () => {
    expect(() => scopePredicate('Systems', 't0', REF)).toThrow(/no row scope is defined for table Systems/);
    expect(() => scopePredicate('__proto__', 't0', REF)).toThrow(/no row scope/);
  });
});

describe('OPENABLE_SQL', () => {
  it('opens a person or account through team OR holder, a resource through team OR held', () => {
    const p = OPENABLE_SQL.principal('x.id', REF);
    expect(p).toContain(`cm."memberId" = x.id AND cm."memberType" = 'Principal'`);
    expect(p).toContain(`a."principalId" = x.id`);
    const r = OPENABLE_SQL.resource('x.id', REF);
    expect(r).toContain(`cm."memberId" = x.id AND cm."memberType" = 'Resource'`);
    expect(r).toContain(`a."resourceId" = x.id AND a."deletedAt" IS NULL`);
  });

  it('puts the id and the scope expressions exactly where given — no values, only expressions', () => {
    const sql = OPENABLE_SQL.identity('t9."id"', '$7::uuid[]');
    expect(sql).toContain('t9."id"');
    expect(sql).toContain('ANY($7::uuid[])');
    expect(sql).not.toContain('$1');
    expect(sql).not.toContain('x.id');
  });
});

describe('createRowScope', () => {
  it('lower-cases, de-duplicates and sorts the context ids, and names its basis', () => {
    const s = createRowScope(new Set(['B0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000002']));
    expect(s.contextIds).toEqual(['a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000002']);
    expect(s.basis).toBe('context-owner');
    expect(Object.isFrozen(s)).toBe(true);
  });

  it('is an empty scope — which reads nothing — when given no ids', () => {
    expect(createRowScope(undefined).contextIds).toEqual([]);
  });
});
