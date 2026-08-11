// Unit tests for routes/contextPlugins.js — id validation + plugin 404.
// DB, plugin registry, and runner mocked (no plugin execution / DB).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../test-utils/routeTestKit.js';

process.env.USE_SQL = 'true';

vi.mock('../db/connection.js');   // picks up src/db/__mocks__/connection.js
import { query, queryOne } from '../db/connection.js';
vi.mock('../middleware/auth.js', () => ({ requirePermission: () => (_q, _s, next) => next() }));
const getPlugin = vi.fn();
vi.mock('../contexts/plugins/registry.js', () => ({ REGISTERED_PLUGINS: [], getPlugin: (...a) => getPlugin(...a) }));
vi.mock('../contexts/plugins/runner.js', () => ({
  enqueueRun: vi.fn(), dryRun: vi.fn(), getRun: vi.fn(), listRuns: vi.fn(),
}));
vi.mock('../db/columnCache.js', () => ({ getPrincipalColumns: vi.fn(async () => []) }));

const { default: router } = await import('./contextPlugins.js');
const app = mountRouter(router);

beforeEach(() => { query.mockReset(); queryOne.mockReset(); getPlugin.mockReset(); });

describe('GET /context-plugins/runs/:id — validation', () => {
  it('400 on a malformed run id', async () => {
    const res = await request(app).get('/api/context-plugins/runs/not-a-uuid');
    expect(res.status).toBe(400);
  });
});

describe('POST /context-plugins/:name/dry-run — branching', () => {
  it('404 when the plugin name is unknown', async () => {
    getPlugin.mockReturnValue(null);
    const res = await request(app).post('/api/context-plugins/no-such-plugin/dry-run').send({});
    expect(res.status).toBe(404);
  });
});

describe('DELETE /context-plugins/trees — validation', () => {
  it('400 when algorithmId is not a uuid', async () => {
    const res = await request(app).delete('/api/context-plugins/trees').send({ algorithmId: 'nope' });
    expect(res.status).toBe(400);
  });
});
