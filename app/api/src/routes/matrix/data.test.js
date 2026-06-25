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

describe('POST /matrix/data (extracted router)', () => {
  it('is mounted and returns the empty default payload when SQL is disabled', async () => {
    const res = await request(app).post('/matrix/data').send({ filter: { rowType: 'principal' } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ data: [], rowType: 'principal', managedByPackages: [] });
    expect(res.body.subjectCount).toBe(0);
  });
});
