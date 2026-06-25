/**
 * Authorization tests for the self-service crawler protocol (fgc_ key auth).
 *
 * SEC-NEW-2: the job-orchestration endpoints (/crawlers/jobs/claim, complete,
 * fail, phases, /crawlers/configs/:id/mark-delta-mode) are the web<->worker
 * protocol. /claim returns the vaulted clientSecret, so any valid crawler key
 * could otherwise drain the queue and harvest another system's credentials.
 * They now require the privileged worker (the 'admin' crawler permission).
 *
 * SEC-NEW-3: the delta-token endpoints take a systemId and must be scoped to the
 * systems the calling crawler may access (crawlerHasSystemAccess). The built-in
 * worker (systemIds=null) keeps full access.
 *
 * These drive the real selfServiceCrawlersRouter via supertest with a stub
 * middleware that sets req.crawler to the crawler-under-test. crawlerAuth's
 * helpers (crawlerHasPermission / crawlerHasSystemAccess) run for real; only the
 * DB and secret-vault dependencies are mocked.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

process.env.USE_SQL = 'true'; // crawlers.js captures this at module-load time

const { mockDbQuery } = vi.hoisted(() => ({ mockDbQuery: vi.fn() }));

// db.query (import * as db) — selfService handlers call db.query(...) directly.
vi.mock('../db/connection.js', () => ({ query: (...a) => mockDbQuery(...a) }));
// Secret vault + manifest + post-crawl pipeline are not under test here.
vi.mock('../secrets/crawlerSecrets.js', () => ({
  injectJobSecret: async (job) => ({ ...job.config, clientSecret: 'INJECTED' }),
  deleteJobSecret: async () => {},
}));
vi.mock('../crawlerManifests.js', () => ({ getPushModeType: () => 'custom-connector' }));
vi.mock('../postCrawlJobs.js', () => ({ runPostCrawlJobs: async () => {} }));
// adminCrawlersRouter's gate is irrelevant here; keep it a passthrough.
vi.mock('../middleware/auth.js', () => ({ requirePermission: () => (_q, _s, n) => n() }));

const { selfServiceCrawlersRouter } = await import('./crawlers.js');

// Build an app that injects a chosen req.crawler, like crawlerAuthMiddleware would.
function appAs(crawler) {
  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => { req.crawler = crawler; next(); }, selfServiceCrawlersRouter);
  return app;
}

const worker = { id: 1, displayName: 'Built-in Worker', permissions: ['ingest', 'refreshViews', 'admin'], systemIds: null };
const ingestOnly = { id: 2, displayName: 'External', permissions: ['ingest'], systemIds: [7] };

beforeEach(() => mockDbQuery.mockReset());

describe('SEC-NEW-2: job-orchestration endpoints require a worker (admin) crawler key', () => {
  it('rejects an ingest-only key from claiming a job (403) — no secret handed out', async () => {
    const res = await request(appAs(ingestOnly)).post('/api/crawlers/jobs/claim');
    expect(res.status).toBe(403);
    expect(mockDbQuery).not.toHaveBeenCalled(); // never reached the claim query
  });

  it('allows the worker to claim (reaches the handler; empty queue → job null)', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(appAs(worker)).post('/api/crawlers/jobs/claim');
    expect(res.status).toBe(200);
    expect(res.body.job).toBeNull();
  });

  it('rejects an ingest-only key from completing/failing/mark-delta-mode (403)', async () => {
    for (const path of ['/api/crawlers/jobs/5/complete', '/api/crawlers/jobs/5/fail', '/api/crawlers/configs/5/mark-delta-mode']) {
      const res = await request(appAs(ingestOnly)).post(path).send({});
      expect(res.status, `${path} must 403 for an ingest-only key`).toBe(403);
    }
  });
});

describe('SEC-NEW-3: delta-token endpoints are scoped to the crawler\'s systems', () => {
  it('rejects reading a token for a system the crawler cannot access (403)', async () => {
    // ingestOnly is scoped to system 7; ask for system 9.
    const res = await request(appAs(ingestOnly)).get('/api/crawlers/delta-tokens/users-delta?systemId=9');
    expect(res.status).toBe(403);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it('allows reading a token for an in-scope system', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(appAs(ingestOnly)).get('/api/crawlers/delta-tokens/users-delta?systemId=7');
    expect(res.status).toBe(200);
  });

  it('the worker (systemIds=null) may read any system\'s token', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(appAs(worker)).get('/api/crawlers/delta-tokens/users-delta?systemId=999');
    expect(res.status).toBe(200);
  });

  it('rejects an out-of-scope delta-token write (403)', async () => {
    const res = await request(appAs(ingestOnly))
      .put('/api/crawlers/delta-tokens/users-delta')
      .send({ systemId: 9, token: 'abc' });
    expect(res.status).toBe(403);
  });
});
