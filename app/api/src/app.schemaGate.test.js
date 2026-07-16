// Verifies the resilient-startup gate wired into the Express app: /api/health
// (and the other bootstrap endpoints) stay 200 while migrations run, while every
// schema-dependent /api endpoint — the worker data-plane AND the human/UI reads
// (#696) — returns 503 Retry-After until the schema is ready. The crawler
// self-service endpoints (whoami/rotate) are allow-listed so a worker can still
// authenticate and back off cleanly.

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

  it('returns 503 with Retry-After on a human/UI read endpoint while migrating (#696)', async () => {
    // The gap this fixes: schema-dependent reads used to hit a not-yet-migrated
    // schema and 500. Now they get a graceful, retryable 503 like the worker gate.
    armStartupGate();
    const res = await request(app).get('/api/resources');
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('30');
    expect(res.body.error).toMatch(/migration in progress/i);
  });

  it('keeps the crawler self-service endpoints reachable while migrating (allow-listed, not 503)', async () => {
    armStartupGate();
    // whoami is allow-listed, so it falls through the gate to crawler auth
    // (401 without an API key in SQL mode) — letting a worker authenticate and
    // then back off on the data-plane 503s it gets elsewhere.
    const whoami = await request(app).get('/api/crawlers/whoami');
    expect(whoami.status).not.toBe(503);
    expect(whoami.status).toBe(401);
  });

  it('keeps the bootstrap endpoints (version) reachable while migrating', async () => {
    armStartupGate();
    const res = await request(app).get('/api/version');
    expect(res.status).toBe(200);
  });

  it('stops gating human/UI reads once the schema is ready (falls through, not 503)', async () => {
    armStartupGate();
    markSchemaReady();
    const res = await request(app).get('/api/resources');
    expect(res.status).not.toBe(503);
  });
});
