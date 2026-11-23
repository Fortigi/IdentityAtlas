// GET /api/context-owner/tree: an owner's own tree, and nothing for anyone else.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../db/connection.js');
vi.mock('../auth/ownerTree.js', () => ({ loadOwnerTree: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requirePermission: () => (_req, _res, next) => next() }));
import { loadOwnerTree } from '../auth/ownerTree.js';

const { default: router } = await import('./contextOwnerAccess.js');

function appAs(user) {
  const app = express();
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use('/api', router);
  return app;
}

beforeEach(() => {
  loadOwnerTree.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('GET /context-owner/tree', () => {
  it.each([[undefined], [{ name: 'An admin' }]])('answers an empty tree for someone who is not an owner (%o)', async (user) => {
    const res = await request(appAs(user)).get('/api/context-owner/tree');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(loadOwnerTree).not.toHaveBeenCalled();
  });

  it('builds the tree from the scope the middleware resolved', async () => {
    const owner = { contexts: [{ id: 'c', role: 'Accountable' }], contextIds: ['c'] };
    loadOwnerTree.mockResolvedValueOnce([{ id: 'c', children: [] }]);
    const res = await request(appAs({ contextOwner: owner })).get('/api/context-owner/tree');
    expect(res.body).toEqual([{ id: 'c', children: [] }]);
    expect(loadOwnerTree.mock.calls[0][1]).toEqual(owner);
  });

  it('hides the reason of a failure', async () => {
    loadOwnerTree.mockRejectedValueOnce(new Error('secret table detail'));
    const res = await request(appAs({ contextOwner: { contexts: [], contextIds: [] } })).get('/api/context-owner/tree');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to load your contexts' });
  });
});
