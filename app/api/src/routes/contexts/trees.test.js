// Unit tests for routes/contexts/trees.js — the Adjust tree endpoints. The
// adjustment service and views are mocked (their SQL is exercised against
// PostgreSQL in contract-tests/treeAdjustments.contract.test.js); this checks the
// HTTP layer: key and id validation, status codes, transactions and errors.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../../test-utils/routeTestKit.js';

vi.mock('../../middleware/auth.js', () => ({ requirePermission: () => (_req, _res, next) => next() }));
vi.mock('../../db/connection.js');
vi.mock('../../contexts/adjustments/view.js', () => ({ treeView: vi.fn(), adjustmentsView: vi.fn(), resolveTree: vi.fn() }));
vi.mock('../../contexts/adjustments/attention.js', () => ({ attentionView: vi.fn(), splitOptions: vi.fn() }));
vi.mock('../../contexts/adjustments/service.js', () => ({
  createAdjustment: vi.fn(), undoAdjustment: vi.fn(), redoAdjustment: vi.fn(), followAdjustment: vi.fn(),
}));
import * as db from '../../db/connection.js';
import { treeView, adjustmentsView, resolveTree } from '../../contexts/adjustments/view.js';
import { attentionView, splitOptions } from '../../contexts/adjustments/attention.js';
import { createAdjustment, undoAdjustment, redoAdjustment, followAdjustment } from '../../contexts/adjustments/service.js';
import { AdjustmentInvalid } from '../../contexts/adjustments/ops.js';
process.env.USE_SQL = 'true';
process.env.FEATURE_ORG_KNOWLEDGE = 'true'; // Adjust tree is organisation knowledge

const { default: router } = await import('./trees.js');
const app = mountRouter(router);

const KEY = 'sync~7~OrganizationalUnit';
const ENC = encodeURIComponent(KEY);
const ADJ = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UNIT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CLIENT = { name: 'tx-client' };

beforeEach(() => {
  vi.clearAllMocks();
  db.tx.mockImplementation(async (fn) => fn(CLIENT));
});

describe('while organisation knowledge is off', () => {
  it('every /context-trees route answers 404 and reads nothing', async () => {
    process.env.FEATURE_ORG_KNOWLEDGE = 'false';
    try {
      for (const path of ['/api/context-trees/resolve?contextId=x', '/api/context-trees/ctx~1', '/api/context-trees/ctx~1/adjustments']) {
        const res = await request(app).get(path);
        expect(res.status, path).toBe(404);
        expect(res.body).toEqual({ error: 'This feature is not enabled' });
      }
      expect((await request(app).post('/api/context-trees/ctx~1/adjustments').send({})).status).toBe(404);
      expect(resolveTree).not.toHaveBeenCalled();
      expect(treeView).not.toHaveBeenCalled();
      expect(createAdjustment).not.toHaveBeenCalled();
    } finally {
      process.env.FEATURE_ORG_KNOWLEDGE = 'true';
    }
  });
});

describe('reads', () => {
  it('resolves a context to its tree, and refuses a bad or unknown id', async () => {
    resolveTree.mockResolvedValueOnce({ treeKey: KEY, canAdjust: true });
    const ok = await request(app).get('/api/context-trees/resolve').query({ contextId: UNIT.toUpperCase() });
    expect(ok.status).toBe(200);
    expect(resolveTree).toHaveBeenCalledWith(db, UNIT);
    expect((await request(app).get('/api/context-trees/resolve').query({ contextId: 'x' })).status).toBe(400);
    resolveTree.mockResolvedValueOnce(null);
    expect((await request(app).get('/api/context-trees/resolve').query({ contextId: UNIT })).status).toBe(404);
  });

  it('serves the tree, the log and the attention list, 404 for an unknown tree', async () => {
    treeView.mockResolvedValueOnce({ treeKey: KEY, units: [] });
    expect((await request(app).get(`/api/context-trees/${ENC}`)).body).toEqual({ treeKey: KEY, units: [] });
    expect(treeView).toHaveBeenCalledWith(db, KEY);
    adjustmentsView.mockResolvedValueOnce([{ id: ADJ }]);
    expect((await request(app).get(`/api/context-trees/${ENC}/adjustments`)).body).toEqual({ data: [{ id: ADJ }] });
    attentionView.mockResolvedValueOnce([]);
    expect((await request(app).get(`/api/context-trees/${ENC}/attention`)).body).toEqual({ data: [] });
    treeView.mockResolvedValueOnce(null);
    expect((await request(app).get(`/api/context-trees/${ENC}`)).status).toBe(404);
    adjustmentsView.mockResolvedValueOnce(null);
    expect((await request(app).get(`/api/context-trees/${ENC}/adjustments`)).status).toBe(404);
  });

  it('refuses a malformed tree key before touching the database', async () => {
    const res = await request(app).get('/api/context-trees/not-a-key');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid tree key');
    expect(treeView).not.toHaveBeenCalled();
  });

  it('serves split options for a unit id only', async () => {
    splitOptions.mockResolvedValueOnce({ attributes: [] });
    expect((await request(app).get(`/api/context-trees/${ENC}/units/${UNIT}/split-options`)).body).toEqual({ attributes: [] });
    expect(splitOptions).toHaveBeenCalledWith(db, KEY, UNIT);
    expect((await request(app).get(`/api/context-trees/${ENC}/units/nope/split-options`)).status).toBe(404);
  });

  it('answers 500 without leaking the error', async () => {
    treeView.mockRejectedValueOnce(new Error('relation "x" does not exist'));
    const res = await request(app).get(`/api/context-trees/${ENC}`);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to load the tree');
  });
});

describe('writes', () => {
  it('adds an adjustment in one transaction, as the signed-in user, answering it as the log shows it', async () => {
    createAdjustment.mockResolvedValueOnce({ id: ADJ, op: 'moveUnit' });
    adjustmentsView.mockResolvedValueOnce([{ id: 'other' }, { id: ADJ, description: 'Move A under B' }]);
    const res = await request(app).post(`/api/context-trees/${ENC}/adjustments`).send({ op: 'moveUnit' });
    expect(res.status).toBe(201);
    expect(res.body.adjustment).toEqual({ id: ADJ, description: 'Move A under B' });
    expect(createAdjustment).toHaveBeenCalledWith(CLIENT, KEY, { op: 'moveUnit' }, 'unknown');
  });

  it('passes on the validation status and message', async () => {
    createAdjustment.mockRejectedValueOnce(new AdjustmentInvalid('The unit is already there'));
    const bad = await request(app).post(`/api/context-trees/${ENC}/adjustments`).send({ op: 'moveUnit' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('The unit is already there');
    createAdjustment.mockRejectedValueOnce(new AdjustmentInvalid('Tree not found', 404));
    expect((await request(app).post(`/api/context-trees/${ENC}/adjustments`).send({})).status).toBe(404);
  });

  it('routes undo, redo and follow to their service call', async () => {
    for (const fn of [undoAdjustment, redoAdjustment, followAdjustment]) fn.mockResolvedValueOnce({ id: ADJ });
    adjustmentsView.mockResolvedValue([]);
    expect((await request(app).delete(`/api/context-trees/${ENC}/adjustments/${ADJ}`)).status).toBe(200);
    expect((await request(app).post(`/api/context-trees/${ENC}/adjustments/${ADJ}/redo`)).status).toBe(200);
    expect((await request(app).post(`/api/context-trees/${ENC}/adjustments/${ADJ}/follow`)).body).toEqual({ adjustment: { id: ADJ } });
    expect(undoAdjustment).toHaveBeenCalledWith(CLIENT, KEY, ADJ);
    expect(redoAdjustment).toHaveBeenCalledWith(CLIENT, KEY, ADJ);
    expect(followAdjustment).toHaveBeenCalledWith(CLIENT, KEY, ADJ);
    expect((await request(app).delete(`/api/context-trees/${ENC}/adjustments/not-a-uuid`)).status).toBe(400);
  });
});
