// Route tests for saved investigations: the gate (an analyst only), the path
// checks, who is passed on as the actor, the statuses each outcome maps to and
// 503 without SQL. What is saved is investigations.test.js' and the contract test's.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouterAs } from '../../../test-utils/routeTestKit.js';

vi.mock('../../middleware/auth.js', () => ({
  requirePermission: (...required) => (req, res, next) => (required.some(p => req.user?.permissions?.includes(p)) ? next() : res.status(403).json({ error: 'Insufficient permissions' })),
}));
vi.mock('../../db/connection.js');
vi.mock('../../contexts/workbench/investigations.js', () => ({
  listInvestigations: vi.fn(), getInvestigation: vi.fn(), createInvestigation: vi.fn(),
  saveInvestigation: vi.fn(), deleteInvestigation: vi.fn(), deleteProposal: vi.fn(),
}));
vi.mock('../../contexts/workbench/proposedMatrix.js', async (orig) => ({ ...(await orig()), listAllInvestigations: vi.fn(), proposedMatrixRows: vi.fn() }));
process.env.USE_SQL = 'true';

const { default: router } = await import('./workbenchInvestigations.js');
const store = await import('../../contexts/workbench/investigations.js');
const { InvestigationError } = await import('../../contexts/workbench/investigationDraft.js');

const CTX = 'dddddddd-0000-4000-8000-000000000001';
const INV = 'eeeeeeee-0000-4000-8000-000000000002';
const PID = 'ffffffff-0000-4000-8000-000000000003';
const analyst = { email: 'ann@example.test', permissions: ['data.write.contexts'] };
const reader = { email: 'reader@example.test', permissions: ['data.read'] };
let caller = analyst;
const app = mountRouterAs(router, () => caller);
const lens = await import('../../contexts/workbench/proposedMatrix.js');
const ALL = [...Object.values(store), lens.listAllInvestigations, lens.proposedMatrixRows];

const ROUTES = [
  ['get', `/api/contexts/${CTX}/workbench/investigations`],
  ['post', `/api/contexts/${CTX}/workbench/investigations`],
  ['get', `/api/workbench/investigations/${INV}`],
  ['put', `/api/workbench/investigations/${INV}`],
  ['delete', `/api/workbench/investigations/${INV}`],
  ['delete', `/api/workbench/investigations/${INV}/proposals/${PID}`],
  ['get', '/api/workbench/investigations'],
  ['post', '/api/workbench/proposals/matrix'],
];

beforeEach(() => {
  caller = analyst;
  for (const f of ALL) vi.mocked(f).mockReset();
});

describe('the gate', () => {
  it.each(ROUTES)('%s %s is 403 for a reader and reaches nothing', async (method, path) => {
    caller = reader;
    expect((await request(app)[method](path).send({})).status).toBe(403);
    for (const f of ALL) expect(f).not.toHaveBeenCalled();
  });

  it.each([
    ['get', '/api/contexts/nope/workbench/investigations'],
    ['put', '/api/workbench/investigations/nope'],
    ['delete', `/api/workbench/investigations/${INV}/proposals/nope`],
  ])('%s %s is 400 for an id that is not one', async (method, path) => {
    const res = await request(app)[method](path).send({});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid ID format' });
    for (const f of ALL) expect(f).not.toHaveBeenCalled();
  });
});

describe('the routes', () => {
  it('lists the unit’s investigations under data', async () => {
    vi.mocked(store.listInvestigations).mockResolvedValueOnce([{ id: INV }]);
    const res = await request(app).get(`/api/contexts/${CTX}/workbench/investigations`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [{ id: INV }] });
    expect(store.listInvestigations).toHaveBeenCalledWith(expect.anything(), CTX);
  });

  it('creates with the body and the caller as the actor: 201', async () => {
    vi.mocked(store.createInvestigation).mockResolvedValueOnce({ id: INV });
    const res = await request(app).post(`/api/contexts/${CTX}/workbench/investigations`).send({ name: 'Motor' });
    expect(res.status).toBe(201);
    expect(store.createInvestigation).toHaveBeenCalledWith(expect.anything(), CTX, { name: 'Motor' }, 'ann@example.test');
  });

  it('opens one, and saves over it with the caller as the actor: 200', async () => {
    vi.mocked(store.getInvestigation).mockResolvedValueOnce({ id: INV, marks: [] });
    expect((await request(app).get(`/api/workbench/investigations/${INV}`)).body).toEqual({ id: INV, marks: [] });
    vi.mocked(store.saveInvestigation).mockResolvedValueOnce({ id: INV });
    const res = await request(app).put(`/api/workbench/investigations/${INV}`).send({ marks: [] });
    expect(res.status).toBe(200);
    expect(store.saveInvestigation).toHaveBeenCalledWith(expect.anything(), INV, { marks: [] }, 'ann@example.test');
  });

  it('deletes an investigation and one proposed role: 204', async () => {
    expect((await request(app).delete(`/api/workbench/investigations/${INV}`)).status).toBe(204);
    expect(store.deleteInvestigation).toHaveBeenCalledWith(expect.anything(), INV);
    expect((await request(app).delete(`/api/workbench/investigations/${INV}/proposals/${PID}`)).status).toBe(204);
    expect(store.deleteProposal).toHaveBeenCalledWith(expect.anything(), INV, PID);
  });
});

describe('errors', () => {
  it.each([[400], [404], [409]])('passes an investigation error’s %i and message on', async (status) => {
    vi.mocked(store.saveInvestigation).mockRejectedValueOnce(new InvestigationError(status, `said ${status}`));
    const res = await request(app).put(`/api/workbench/investigations/${INV}`).send({});
    expect(res.status).toBe(status);
    expect(res.body).toEqual({ error: `said ${status}` });
  });

  it('hides anything else behind a 500 naming the action', async () => {
    vi.mocked(store.deleteProposal).mockRejectedValueOnce(new Error('connection reset'));
    const res = await request(app).delete(`/api/workbench/investigations/${INV}/proposals/${PID}`);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Deleting the proposed role failed' });
  });

  it('is 503 for every route without the SQL backend', async () => {
    vi.resetModules();
    process.env.USE_SQL = 'false';
    const { default: noSql } = await import('./workbenchInvestigations.js');
    process.env.USE_SQL = 'true';
    const plain = mountRouterAs(noSql, () => analyst);
    for (const [method, path] of ROUTES) {
      expect((await request(plain)[method](path).send({})).status).toBe(503);
    }
  });
});

describe('the Proposed lens', () => {
  it('lists every saved investigation with proposed roles', async () => {
    vi.mocked(lens.listAllInvestigations).mockResolvedValueOnce([{ id: INV, unitName: 'Property Claims' }]);
    const res = await request(app).get('/api/workbench/investigations');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [{ id: INV, unitName: 'Property Claims' }] });
  });

  it('reads the matrix rows of the accounts asked for, and answers a bad request with its status', async () => {
    vi.mocked(lens.proposedMatrixRows).mockResolvedValueOnce({ data: [], managedByPackages: [] });
    const ok = await request(app).post('/api/workbench/proposals/matrix').send({ principalIds: [CTX] });
    expect(ok.body).toEqual({ data: [], managedByPackages: [] });
    expect(vi.mocked(lens.proposedMatrixRows).mock.calls[0][1]).toEqual({ principalIds: [CTX] });
    vi.mocked(lens.proposedMatrixRows).mockRejectedValueOnce(new lens.ProposedMatrixError(400, 'principalIds must be a list.'));
    const bad = await request(app).post('/api/workbench/proposals/matrix').send({});
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: 'principalIds must be a list.' });
  });
});
