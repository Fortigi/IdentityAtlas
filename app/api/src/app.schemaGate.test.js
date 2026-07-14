// Verifies the resilient-startup gate wired into the Express app: /api/health
// stays 200 (so the platform startup probe passes) while reporting readiness,
// and the worker data-plane (job claim + ingest) returns 503 until the schema
// is ready — without blocking human/UI endpoints.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// crawlerAuth.js captures USE_SQL at module-load time; set it before the app
// (and its middleware) are imported so the worker mounts behave like the real
// SQL path (401 without a key) instead of the mock-mode "SQL not configured"
// 503 — otherwise we couldn't tell our migration-gate 503 apart from theirs.
vi.hoisted(() => { process.env.USE_SQL = 'true'; });
import request from 'supertest';
import { createApp } from './app.js';
import { armStartupGate, markSchemaReady, _resetForTest } from './startupState.js';

describe('schema-migrating gate', () => {
  let app;
  beforeEach(() => {
    _resetForTest();
    app = createApp();
  });
  afterEach(() => _resetForTest());

  it('health is always 200 and reports schemaReady before and after migration', async () => {
    armStartupGate();
    const during = await request(app).get('/api/health');
    expect(during.status).toBe(200);
    expect(during.body).toMatchObject({ status: 'ok', schemaReady: false });

    markSchemaReady();
    const after = await request(app).get('/api/health');
    expect(after.status).toBe(200);
    expect(after.body.schemaReady).toBe(true);
  });

  it('returns 503 with Retry-After on ingest while migrating', async () => {
    armStartupGate();
    const res = await request(app).post('/api/ingest/contexts').send({ records: [] });
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('30');
    expect(res.body.error).toMatch(/migration in progress/i);
  });

  it('returns 503 on the worker job-claim endpoint while migrating', async () => {
    armStartupGate();
    const res = await request(app).post('/api/crawlers/jobs/claim').send({});
    expect(res.status).toBe(503);
  });

  it('stops gating once the schema is ready (falls through to auth, not 503)', async () => {
    armStartupGate();
    markSchemaReady();
    const ingest = await request(app).post('/api/ingest/contexts').send({ records: [] });
    expect(ingest.status).not.toBe(503);
    const claim = await request(app).post('/api/crawlers/jobs/claim').send({});
    expect(claim.status).not.toBe(503);
  });

  it('never gates when the gate was not armed (tests / mock mode)', async () => {
    // No armStartupGate() call — isSchemaReady() is true, so the worker
    // endpoints behave exactly as before this change.
    const ingest = await request(app).post('/api/ingest/contexts').send({ records: [] });
    expect(ingest.status).not.toBe(503);
  });
});
