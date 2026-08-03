// Smoke test for the extracted /matrix/data router (Q1 part-3 split).
//
// With USE_SQL unset the handler returns its empty default payload without
// touching the DB, so this exercises module load (all imports resolve), route
// registration, and the early no-SQL branch — exactly the things an extraction
// can break. Full query behaviour is validated against live stacks (SK1/SK3).
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

delete process.env.USE_SQL; // force the !useSql branch (no DB access)

vi.mock('../../db/connection.js', () => ({ getPool: vi.fn(), query: vi.fn(), queryOne: vi.fn() }));
vi.mock('../../perf/sqlTimer.js', () => ({
  timedQuery: async () => ({ rows: [] }),
}));

const { default: dataRouter, buildMatrixContext } = await import('./data.js');
const app = express().use(express.json()).use(dataRouter);

// buildMatrixContext is the pure per-request setup extracted from the handler:
// it derives the subject column SELECT / join / member expressions from rowType.
describe('buildMatrixContext', () => {
  const built = {
    principalCols: [{ name: 'displayName' }, { name: 'email' }, { name: 'department' }],
    identityCols: [{ name: 'displayName' }, { name: 'jobTitle' }],
  };

  it('derives principal-mode expressions', () => {
    const ctx = buildMatrixContext({ rowType: 'principal' }, built, false, {});
    expect(ctx.subjectAlias).toBe('u');
    expect(ctx.memberIdExpr).toBe('p."principalId"');
    expect(ctx.subjectIdForFilter).toBe('p."principalId"');
    expect(ctx.subjectJoin).toContain('INNER JOIN "Principals" u');
    expect(ctx.subjectJoin).not.toContain('IdentityMembers');
    // displayName/email are excluded from the dynamic column list
    expect(ctx.dynamicSubjectCols).toBe('u."department"');
  });

  it('derives identity-mode expressions (joins through IdentityMembers)', () => {
    const ctx = buildMatrixContext({ rowType: 'identity' }, built, true, {});
    expect(ctx.subjectAlias).toBe('i');
    expect(ctx.memberIdExpr).toBe('i.id');
    expect(ctx.memberTypeExpr).toBe(`'Identity'`);
    expect(ctx.subjectJoin).toContain('IdentityMembers');
    expect(ctx.subjectJoin).toContain('INNER JOIN "Identities" i');
    expect(ctx.dynamicSubjectCols).toBe('i."jobTitle"');
    expect(ctx.includeInherited).toBe(true);
  });
});

const EMPTY_PAYLOAD = {
  data: [], rowType: 'principal', managedByPackages: [], resourceContexts: [],
  subjectCount: 0, subjectTotal: 0, resourceCount: 0, resourceTotal: 0, assignmentCount: 0,
};

describe('POST /matrix/data (extracted router)', () => {
  it('is mounted and returns the empty default payload when SQL is disabled', async () => {
    const res = await request(app).post('/matrix/data').send({ filter: { rowType: 'principal' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(EMPTY_PAYLOAD);
  });

  // The handler was decomposed into a dispatcher + one function per view mode
  // (attribute-fold, context roll-up, roll-up, flat grid). The dispatcher must
  // keep the !useSql guard AHEAD of every mode branch, so each of these shapes —
  // which would otherwise hit a different handler — still short-circuits to the
  // same empty payload (note: rowType is hard-coded 'principal' on that path,
  // proving the guard returns before the request body is inspected).
  it('short-circuits every mode to the empty payload when SQL is disabled', async () => {
    const bodies = [
      { filter: { rowType: 'principal', foldAttributes: true, sortAttributes: [{ attribute: 'department' }] } },
      { filter: { rowType: 'identity', rollupKind: 'context', rollupContextId: 'ctx-1' } },
      { filter: { rowType: 'identity', sortHierarchy: { contextId: 'ctx-1' } } },
      { filter: { rowType: 'principal', rollup: 'department' } },
    ];
    for (const body of bodies) {
      const res = await request(app).post('/matrix/data').send(body);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(EMPTY_PAYLOAD);
    }
  });
});
