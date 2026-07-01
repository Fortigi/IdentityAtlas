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
  timedRequest: () => ({ input() { return this; }, query: async () => ({ recordset: [] }) }),
}));

const { default: dataRouter } = await import('./data.js');
const app = express().use(express.json()).use(dataRouter);

const EMPTY_PAYLOAD = {
  data: [], rowType: 'principal', managedByPackages: [],
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
