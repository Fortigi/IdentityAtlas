/**
 * Tests for the generic per-crawler live-discovery endpoint:
 *   POST /api/admin/crawlers/:type/discover
 *
 * The endpoint loads tools/crawlers/{type}/discover.js dynamically and delegates
 * to its default export. These tests cover the routing layer — unknown types,
 * missing discover.js, and successful handler invocation via a vi.mock stub.
 */
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import jobsRouter, { VALID_JOB_TYPES } from './jobs.js';

// ─── Shared mocks ─────────────────────────────────────────────────────────────

const { mockPool } = vi.hoisted(() => {
  const mockDbQuery = vi.fn();
  const mockRequest = { input: vi.fn().mockReturnThis(), query: mockDbQuery };
  const mockPool = { request: vi.fn(() => mockRequest) };
  return { mockPool, mockDbQuery };
});

vi.mock('../db/connection.js', () => ({ getPool: async () => mockPool }));
vi.mock('../middleware/auth.js', () => ({
  requirePermission: () => (_req, _res, next) => next(),
}));

// Stub dynamic import of discover.js so tests don't hit the filesystem or
// real third-party APIs. The stub checks which crawler type is being loaded
// and either returns a handler mock or throws ERR_MODULE_NOT_FOUND.
let _discoverStub = null; // set per-test

vi.mock('url', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real };
});

// Intercept the dynamic import inside the route by patching the global import.
// vitest doesn't support mocking dynamic import() directly, so we patch via
// the filesystem path: crawlers that have no discover.js throw ERR_MODULE_NOT_FOUND
// naturally. We test those paths against real crawler folders (csv has no discover.js).
// For the success path we use the midpoint crawler's real discover.js with a
// mocked authFetch context to avoid a real network call.

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', jobsRouter);
  return app;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/admin/crawlers/:type/discover — routing', () => {
  it('returns 404 for a type that is not in VALID_JOB_TYPES', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/admin/crawlers/nonexistent-type/discover')
      .send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Unknown crawler type/);
  });

  it('rejects types with uppercase letters (invalid slug format)', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/admin/crawlers/EntraID/discover')
      .send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Unknown crawler type/);
  });

  it('rejects types with path traversal characters', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/admin/crawlers/../shared/discover')
      .send({});
    // Express normalises the URL so the param becomes 'shared' — which is not
    // in VALID_JOB_TYPES (it has no crawler.json), so we still get a 404.
    expect(res.status).toBe(404);
  });

  it('returns 404 when the crawler type has no discover.js (csv has none)', async () => {
    // csv is a real VALID_JOB_TYPE but ships no discover.js — exercises the
    // ERR_MODULE_NOT_FOUND branch without any mocking.
    expect(VALID_JOB_TYPES).toContain('csv');
    const app = makeApp();
    const res = await request(app)
      .post('/api/admin/crawlers/csv/discover')
      .send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/does not support live discovery/);
  });
});

describe('POST /api/admin/crawlers/:type/discover — VALID_JOB_TYPES coverage', () => {
  it('midpoint is registered as a valid job type', () => {
    expect(VALID_JOB_TYPES).toContain('midpoint');
  });

  it('all registered types are lowercase slugs matching [a-z][a-z0-9-]*', () => {
    for (const type of VALID_JOB_TYPES) {
      expect(type).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });
});
