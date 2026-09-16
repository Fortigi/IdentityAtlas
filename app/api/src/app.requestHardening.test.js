// End-to-end wiring of the request-layer hardening in createApp():
//   H-07  auth-off cross-site write guard + Host allow-list (421)
//   M-04  crawler auth runs before the 50 MB ingest parser
//   M-09  'trust proxy' from the environment, per-caller limiter keys, and the
//         SPA fallback no longer spending the public API quota
//   L-17  CSP connect-src no longer lists Microsoft Graph
// The DB is the shared manual mock; auth is off (the authConfig default).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
vi.hoisted(() => { process.env.USE_SQL = 'true'; });
vi.mock('./db/connection.js');
import request from 'supertest';
import { query, queryOne } from './db/connection.js';
import { createApp } from './app.js';

const ENV_KEYS = ['BEHIND_TLS', 'TRUST_PROXY', 'TRUST_PROXY_HOPS', 'ALLOWED_HOSTS', 'PUBLIC_BASE_URL'];
let savedEnv;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  query.mockReset();
  queryOne.mockReset();
  query.mockResolvedValue({ rows: [], rowCount: 0 });
  queryOne.mockResolvedValue(null);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('H-07 — auth off: cross-site writes and foreign Host names', () => {
  it('refuses a cross-site form post to clean-database before the handler runs', async () => {
    const res = await request(createApp())
      .post('/api/admin/clean-database')
      .set('Sec-Fetch-Site', 'cross-site')
      .set('Origin', 'https://attacker.example')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('confirm=DELETE+ALL+DATA');
    expect(res.status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });

  it('still accepts the same wipe from a non-browser client with the confirmation body', async () => {
    const res = await request(createApp())
      .post('/api/admin/clean-database')
      .send({ confirm: 'DELETE ALL DATA' });
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Database cleaned');
  });

  it('answers 421 for a dotted host name that is not configured, but keeps health reachable', async () => {
    const app = createApp();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rebound = await request(app).get('/api/systems').set('Host', 'rebind.attacker.example:3001');
    const health = await request(app).get('/api/health').set('Host', 'rebind.attacker.example:3001');
    warn.mockRestore();
    expect(rebound.status).toBe(421);
    expect(health.status).toBe(200);
  });

  it('serves the host named by PUBLIC_BASE_URL', async () => {
    process.env.PUBLIC_BASE_URL = 'https://atlas.example.com';
    const res = await request(createApp()).get('/api/version').set('Host', 'atlas.example.com');
    expect(res.status).toBe(200);
  });

  it('lets the UI send its same-app header through a CORS preflight from an allowed dev origin', async () => {
    const res = await request(createApp())
      .options('/api/systems')
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'x-requested-with');
    expect(res.headers['access-control-allow-headers']).toMatch(/X-Requested-With/);
  });
});

describe('M-04 — crawler auth before the ingest body parser', () => {
  it('rejects a bad crawler key without parsing the body (malformed JSON is never read)', async () => {
    const res = await request(createApp())
      .post('/api/ingest/principals')
      .set('Authorization', 'Bearer fgc_badk3yzz')
      .set('Content-Type', 'application/json')
      .send('{"records": [ this is not json');
    expect(res.status).toBe(401);
  });
});

describe('M-09 — proxy-aware limiter keys', () => {
  const remaining = (res) => Number(res.headers['ratelimit-remaining']);

  it('does not trust X-Forwarded-For by default: spoofed addresses share one bucket', async () => {
    const app = createApp();
    const a = await request(app).get('/api/version').set('X-Forwarded-For', '203.0.113.1');
    const b = await request(app).get('/api/version').set('X-Forwarded-For', '203.0.113.2');
    expect(remaining(b)).toBe(remaining(a) - 1);
  });

  it('behind a TLS proxy, two clients forwarded by the proxy get separate buckets', async () => {
    process.env.BEHIND_TLS = 'true';
    const app = createApp();
    expect(app.get('trust proxy')).toBe(1);
    const a = await request(app).get('/api/version').set('X-Forwarded-For', '203.0.113.1');
    const b = await request(app).get('/api/version').set('X-Forwarded-For', '203.0.113.2');
    expect(remaining(b)).toBe(remaining(a));
  });

  it('loading the SPA shell does not spend the public API quota', async () => {
    const app = createApp();
    const before = await request(app).get('/api/version');
    await request(app).get('/some/deep/link');
    await request(app).get('/another/page');
    const after = await request(app).get('/api/version');
    expect(remaining(after)).toBe(remaining(before) - 1);
  });
});

describe('L-17 — CSP connect-src', () => {
  it('allows Entra sign-in but not Microsoft Graph', async () => {
    const res = await request(createApp()).get('/api/health');
    const csp = res.headers['content-security-policy'];
    const connectSrc = csp.split(';').map(s => s.trim()).find(s => s.startsWith('connect-src'));
    expect(connectSrc).toContain('https://login.microsoftonline.com');
    expect(connectSrc).not.toContain('graph.microsoft.com');
  });
});
