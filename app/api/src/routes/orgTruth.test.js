import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../test-utils/routeTestKit.js';

vi.mock('../db/connection.js');

import { queryOne } from '../db/connection.js';
import router from './orgTruth.js';

const app = mountRouter(router);

beforeEach(() => {
  vi.clearAllMocks();
  queryOne.mockResolvedValue(undefined); // no WorkerConfig override: the env default decides
});

describe('the composed org-truth router', () => {
  it('answers 404 for every /org-truth path while the feature is off', async () => {
    process.env.FEATURE_ORG_TRUTH = 'false';
    for (const path of ['/api/org-truth', '/api/org-truth/sources', '/api/org-truth/runs/abc/anything']) {
      const r = await request(app).get(path);
      expect(r.status, path).toBe(404);
      expect(r.body).toEqual({ error: 'This feature is not enabled' });
    }
  });

  it('answers 501, naming the method and path, for a path no sub-router claims yet', async () => {
    process.env.FEATURE_ORG_TRUTH = 'true';
    const r = await request(app).post('/api/org-truth/no-such-thing').send({});
    expect(r.status).toBe(501);
    expect(r.body).toEqual({ error: 'Not built yet: POST /org-truth/no-such-thing' });
    expect((await request(app).get('/api/org-truth')).status).toBe(501);
  });

  it('leaves every other /api path alone', async () => {
    process.env.FEATURE_ORG_TRUTH = 'true';
    expect((await request(app).get('/api/contexts')).status).toBe(404);
    expect((await request(app).get('/api/org-truthful')).status).toBe(404);
  });
});
