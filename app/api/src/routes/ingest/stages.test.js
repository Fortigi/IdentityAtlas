// Route tests for /ingest/stages — the gates, and that a staged batch goes through
// the same defaults, validation, normalization and system boundary as a batch on
// /ingest/<entity>. The stage primitive itself is mocked (see ingest/stages.test.js).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

process.env.USE_SQL = 'true';

const m = vi.hoisted(() => ({
  hasPermission: vi.fn(() => true),
  hasSystemAccess: vi.fn(() => true),
  restricted: vi.fn(() => null),
  denial: vi.fn(async () => null),
  preserved: vi.fn(async () => null),
  append: vi.fn(async (_st, recs) => ({ rows: recs.length })),
  finalize: vi.fn(async () => ({ path: 'merge', inserted: 1, updated: 0, deleted: 2, rows: 3 })),
  finalizeMany: vi.fn(async (list) => list.map(() => ({ path: 'empty-table', inserted: 5, updated: 0, deleted: 0, rows: 5 }))),
  abort: vi.fn(async () => {}),
  syncLog: vi.fn(async () => {}),
  stages: new Map(),
}));

vi.mock('../../middleware/crawlerAuth.js', () => ({
  crawlerHasPermission: (...a) => m.hasPermission(...a),
  crawlerHasSystemAccess: (...a) => m.hasSystemAccess(...a),
}));
vi.mock('../../ingest/systemBoundary.js', () => ({
  restrictedSystemIds: (...a) => m.restricted(...a),
  writableCoreColumns: (c) => c,
  systemBoundaryDenial: (...a) => m.denial(...a),
  preservedOwnerColumns: (...a) => m.preserved(...a),
}));
vi.mock('../../ingest/engine.js', () => ({ writeSyncLog: (...a) => m.syncLog(...a) }));
vi.mock('./helpers.js', async (orig) => ({
  ...(await orig()),
  discoverCoreColumns: async () => ['resourceId', 'principalId', 'assignmentType', 'governed', 'systemId'],
}));
vi.mock('../../ingest/stages.js', async (orig) => {
  const real = await orig();
  return {
    StageError: real.StageError,
    openStage: (o) => { const st = { id: `s${m.stages.size + 1}`, rows: 0, ...o }; m.stages.set(st.id, st); return st; },
    getStage: (id, owner) => {
      const st = m.stages.get(id);
      if (!st) throw new real.StageError(404, 'not found');
      if (st.ownerId !== owner) throw new real.StageError(403, 'other crawler');
      return st;
    },
    appendToStage: (...a) => m.append(...a),
    finalizeStage: (...a) => m.finalize(...a),
    finalizeStages: (...a) => m.finalizeMany(...a),
    abortStage: (...a) => m.abort(...a),
  };
});

const { default: router } = await import('./stages.js');
const app = express().use(express.json()).use((req, _res, next) => { req.crawler = { id: 5 }; next(); }).use(router);

const open = (body = {}) => request(app).post('/ingest/stages').send({
  entity: 'resource-assignments', systemId: 7, idGeneration: 'deterministic', idPrefix: 'CSV-resource-assignments', ...body,
});
const REC = { resourceExternalId: 'E-1', principalExternalId: 'P-1', assignmentType: 'Direct' };

beforeEach(() => {
  m.stages.clear();
  for (const f of ['hasPermission', 'hasSystemAccess']) m[f].mockReset().mockReturnValue(true);
  m.restricted.mockReset().mockReturnValue(null);
  m.denial.mockReset().mockResolvedValue(null);
  m.append.mockClear(); m.finalize.mockClear(); m.abort.mockClear(); m.syncLog.mockClear();
});

describe('POST /ingest/stages', () => {
  it('opens a stage for a stageable entity and returns its id', async () => {
    const res = await open({ scope: { assignmentType: 'Direct', bogus: 1 } });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ stageId: 's1', table: 'ResourceAssignments' });
    const st = m.stages.get('s1');
    expect(st).toMatchObject({ tableName: 'ResourceAssignments', systemId: 7, ownerId: 5, conflictFilter: '"principalId" IS NOT NULL' });
    expect(st.scope).toEqual({ assignmentType: 'Direct' });          // only the entity's scope columns
  });

  it('refuses an entity that cannot be staged, and a bad systemId', async () => {
    expect((await open({ entity: 'contexts' })).status).toBe(400);
    expect((await open({ systemId: 'seven' })).status).toBe(400);
    expect((await open({ systemId: 0 })).status).toBe(400);
  });

  it('refuses without the ingest permission or access to the system', async () => {
    m.hasPermission.mockReturnValue(false);
    expect((await open()).status).toBe(403);
    m.hasPermission.mockReturnValue(true);
    m.hasSystemAccess.mockReturnValue(false);
    expect((await open()).status).toBe(403);
  });
});

describe('POST /ingest/stages/:id/rows', () => {
  it('applies the batch path defaults, normalizes ids, and appends', async () => {
    await open();
    const res = await request(app).post('/ingest/stages/s1/rows').send({ records: [REC, REC] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ rows: 2 });
    const staged = m.append.mock.calls[0][1];
    expect(staged[0].governed).toBe(false);                            // applyIngestDefaults
    expect(staged[0].resourceId).toMatch(/^[0-9a-f-]{36}$/);           // deterministic id from the external id
    expect(staged[0].systemId).toBe(7);
  });

  it('rejects records that fail validation, before anything is staged', async () => {
    await open();
    const res = await request(app).post('/ingest/stages/s1/rows').send({ records: [{ assignmentType: 'Direct' }] });
    expect(res.status).toBe(400);
    expect(m.append).not.toHaveBeenCalled();
    expect((await request(app).post('/ingest/stages/s1/rows').send({ records: 'no' })).status).toBe(400);
  });

  it('runs the per-system boundary for a restricted key, and stages nothing it denies', async () => {
    m.restricted.mockReturnValue([7]);
    await open();
    m.denial.mockResolvedValue('outside this crawler\'s systems');
    const res = await request(app).post('/ingest/stages/s1/rows').send({ records: [REC] });
    expect(res.status).toBe(403);
    expect(m.denial.mock.calls[0][0]).toMatchObject({ tableName: 'ResourceAssignments', syncMode: 'full', allowed: [7] });
    expect(m.append).not.toHaveBeenCalled();
  });

  it('another crawler cannot write to the stage; an unknown stage is 404', async () => {
    await open();
    m.stages.get('s1').ownerId = 99;
    expect((await request(app).post('/ingest/stages/s1/rows').send({ records: [REC] })).status).toBe(403);
    expect((await request(app).post('/ingest/stages/nope/rows').send({ records: [REC] })).status).toBe(404);
  });
});

describe('finalize and abort', () => {
  it('finalize passes deleteMissing only when it is literally true, and logs the path it took', async () => {
    await open();
    const res = await request(app).post('/ingest/stages/s1/finalize').send({ deleteMissing: 'yes' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ path: 'merge', inserted: 1, deleted: 2 });
    expect(m.finalize.mock.calls[0][1]).toEqual({ deleteMissing: false });
    expect(m.syncLog.mock.calls[0][1]).toBe('API-stage-resource-assignments-merge');
  });

  it('a failed finalize answers 500 and logs the failure', async () => {
    await open();
    m.finalize.mockRejectedValueOnce(new Error('disk full'));
    const res = await request(app).post('/ingest/stages/s1/finalize').send({ deleteMissing: true });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/disk full/);
    expect(m.syncLog.mock.calls[0][8]).toBe('disk full');
  });

  it('finalizes the stages of a run together and logs each', async () => {
    await open();
    await open({ systemId: 8 });
    const res = await request(app).post('/ingest/stages/finalize').send({ stageIds: ['s1', 's2'], deleteMissing: true });
    expect(res.status).toBe(200);
    expect(res.body.results.map(r => [r.stageId, r.path])).toEqual([['s1', 'empty-table'], ['s2', 'empty-table']]);
    expect(m.finalizeMany.mock.calls[0][0].map(s => s.id)).toEqual(['s1', 's2']);
    expect(m.finalizeMany.mock.calls[0][1]).toEqual({ deleteMissing: true });
    expect(m.syncLog).toHaveBeenCalledTimes(2);
  });

  it('grouped finalize refuses a bad list and a stage of another crawler', async () => {
    expect((await request(app).post('/ingest/stages/finalize').send({ stageIds: [] })).status).toBe(400);
    expect((await request(app).post('/ingest/stages/finalize').send({})).status).toBe(400);
    await open();
    m.stages.get('s1').ownerId = 99;
    expect((await request(app).post('/ingest/stages/finalize').send({ stageIds: ['s1'] })).status).toBe(403);
    expect(m.finalizeMany).not.toHaveBeenCalled();
  });

  it('abort drops the stage', async () => {
    await open();
    expect((await request(app).delete('/ingest/stages/s1')).status).toBe(204);
    expect(m.abort).toHaveBeenCalledTimes(1);
  });
});
