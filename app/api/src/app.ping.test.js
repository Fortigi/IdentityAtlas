// /api/ping (#908) is the minimal liveness probe: always 200 with the exact
// JSON body {"status":"ok"} — no auth, no DB, and available even while the
// schema-migration gate holds every schema-dependent endpoint at 503.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
vi.hoisted(() => { process.env.USE_SQL = 'true'; });
import request from 'supertest';
import { createApp } from './app.js';
import { armStartupGate, _resetForTest } from './startupState.js';

describe('/api/ping — liveness endpoint', () => {
  let app;
  beforeEach(() => {
    _resetForTest();
    app = createApp();
  });
  afterEach(() => _resetForTest());

  it('returns 200 with exactly {"status":"ok"} as JSON, without authentication', async () => {
    const res = await request(app).get('/api/ping');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.text).toBe('{"status":"ok"}');
  });

  it('stays 200 while the schema is still migrating (no DB dependency)', async () => {
    armStartupGate();
    const res = await request(app).get('/api/ping');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});
