// Route tests for the workbench and knowledge endpoints: the gate (an analyst
// only), the parsing, the errors each module throws, and 503 without SQL. What
// the modules compute is their own tests'.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouterAs } from '../../../test-utils/routeTestKit.js';

vi.mock('../../middleware/auth.js', () => ({
  requirePermission: (...required) => (req, res, next) => (required.some(p => req.user?.permissions?.includes(p)) ? next() : res.status(403).json({ error: 'Insufficient permissions' })),
}));
vi.mock('../../db/connection.js');
vi.mock('../../contexts/workbench/load.js', async (orig) => ({ ...(await orig()), loadWorkbench: vi.fn() }));
vi.mock('../../contexts/orgKnowledge/manual.js', async (orig) => ({ ...(await orig()), addKnowledgeLink: vi.fn(), peopleWithObject: vi.fn() }));
vi.mock('../../contexts/orgKnowledge/objects.js', async (orig) => ({ ...(await orig()), listObjects: vi.fn() }));
process.env.USE_SQL = 'true';

const { default: router } = await import('./workbench.js');
const { loadWorkbench, WorkbenchError } = await import('../../contexts/workbench/load.js');
const { addKnowledgeLink, peopleWithObject, KnowledgeError } = await import('../../contexts/orgKnowledge/manual.js');
const { listObjects } = await import('../../contexts/orgKnowledge/objects.js');
const db = await import('../../db/connection.js');

const CTX = 'dddddddd-0000-4000-8000-000000000001';
const OBJ = 'oooooooo-0000-4000-8000-000000000001'.replace(/o/g, 'a');
const analyst = { email: 'ann@example.test', permissions: ['data.write.contexts'] };
const reader = { email: 'reader@example.test', permissions: ['data.read'] };
let caller = analyst;
const app = mountRouterAs(router, () => caller);

beforeEach(() => {
  caller = analyst;
  for (const f of [loadWorkbench, addKnowledgeLink, peopleWithObject, listObjects]) vi.mocked(f).mockReset();
});

describe('the gate', () => {
  it.each([
    ['get', `/api/contexts/${CTX}/workbench`],
    ['post', `/api/contexts/${CTX}/knowledge`],
    ['get', '/api/org-knowledge/objects'],
    ['get', `/api/org-knowledge/objects/${OBJ}/people`],
  ])('%s %s is 403 for a reader and reaches nothing', async (method, path) => {
    caller = reader;
    expect((await request(app)[method](path).send({})).status).toBe(403);
    for (const f of [loadWorkbench, addKnowledgeLink, peopleWithObject, listObjects]) expect(f).not.toHaveBeenCalled();
  });
});

describe('GET /contexts/:id/workbench', () => {
  it('loads the unit with its sub-units unless asked not to', async () => {
    vi.mocked(loadWorkbench).mockResolvedValue({ unit: { id: CTX } });
    const res = await request(app).get(`/api/contexts/${CTX}/workbench`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ unit: { id: CTX } });
    expect(loadWorkbench).toHaveBeenCalledWith(db, CTX, { includeChildren: true });
    await request(app).get(`/api/contexts/${CTX}/workbench?includeChildren=false`);
    expect(loadWorkbench).toHaveBeenLastCalledWith(db, CTX, { includeChildren: false });
  });

  it('answers a malformed id with 400 without reading', async () => {
    expect((await request(app).get('/api/contexts/not-a-uuid/workbench')).status).toBe(400);
    expect(loadWorkbench).not.toHaveBeenCalled();
  });

  it('passes on the module’s refusal, and hides any other failure behind a generic 500', async () => {
    vi.mocked(loadWorkbench).mockRejectedValueOnce(new WorkbenchError(400, 'The authorization workbench opens on an organizational unit.'));
    const refused = await request(app).get(`/api/contexts/${CTX}/workbench`);
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe('The authorization workbench opens on an organizational unit.');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(loadWorkbench).mockRejectedValueOnce(new Error('relation does not exist'));
    const failed = await request(app).get(`/api/contexts/${CTX}/workbench`);
    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({ error: 'Loading the workbench failed' });
  });
});

describe('POST /contexts/:id/knowledge', () => {
  it('adds the link as the signed-in analyst and answers 201 with the claim', async () => {
    vi.mocked(addKnowledgeLink).mockResolvedValue({ id: 'c1', claimKind: 'duty' });
    const body = { kind: 'duty', value: 'Works council member', identityId: CTX };
    const res = await request(app).post(`/api/contexts/${CTX}/knowledge`).send(body);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: 'c1', claimKind: 'duty' });
    expect(addKnowledgeLink).toHaveBeenCalledWith(db, CTX, body, 'ann@example.test');
  });

  it('answers the module’s refusal with its status', async () => {
    vi.mocked(addKnowledgeLink).mockRejectedValueOnce(new KnowledgeError(404, 'Identity not found'));
    const res = await request(app).post(`/api/contexts/${CTX}/knowledge`).send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Identity not found');
  });
});

describe('GET /org-knowledge/objects', () => {
  it('lists the objects of one kind or of all three', async () => {
    vi.mocked(listObjects).mockResolvedValue([{ id: OBJ }]);
    const one = await request(app).get('/api/org-knowledge/objects?kind=duty');
    expect(one.body).toEqual({ data: [{ id: OBJ }] });
    expect(listObjects).toHaveBeenCalledWith(db, 'duty');
    await request(app).get('/api/org-knowledge/objects');
    expect(listObjects).toHaveBeenLastCalledWith(db, null);
  });

  it('refuses an unknown kind with 400', async () => {
    const res = await request(app).get('/api/org-knowledge/objects?kind=role');
    expect(res.status).toBe(400);
    expect(listObjects).not.toHaveBeenCalled();
  });

  it('lists who holds one object', async () => {
    vi.mocked(peopleWithObject).mockResolvedValue([{ displayName: 'Bram' }]);
    const res = await request(app).get(`/api/org-knowledge/objects/${OBJ}/people`);
    expect(res.body).toEqual({ data: [{ displayName: 'Bram' }] });
    expect(peopleWithObject).toHaveBeenCalledWith(db, OBJ);
  });
});

describe('without the SQL backend', () => {
  it('answers 503 everywhere', async () => {
    vi.resetModules();
    process.env.USE_SQL = 'false';
    const { default: noSql } = await import('./workbench.js');
    const plain = mountRouterAs(noSql, () => analyst);
    for (const [method, path] of [['get', `/api/contexts/${CTX}/workbench`], ['post', `/api/contexts/${CTX}/knowledge`],
      ['get', '/api/org-knowledge/objects'], ['get', `/api/org-knowledge/objects/${OBJ}/people`]]) {
      expect((await request(plain)[method](path).send({})).status).toBe(503);
    }
    process.env.USE_SQL = 'true';
  });
});
