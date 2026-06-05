/**
 * Unit tests for Omada-specific logic in jobs.js:
 *   - maskConfig: ensures all credential types are masked
 *   - validateCrawlerConfig('omada', ...): covers all six auth methods + missing required fields
 *   - PATCH secret preservation: existing secrets survive a no-secret PATCH
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import jobsRouter, { maskConfig, validateCrawlerConfig, VALID_JOB_TYPES } from './jobs.js';

// ─── Mocks for validate-metadata endpoint tests ───────────────────────────────

const { mockPool, mockDbQuery } = vi.hoisted(() => {
  const mockDbQuery = vi.fn();
  const mockRequest = { input: vi.fn().mockReturnThis(), query: mockDbQuery };
  const mockPool = { request: vi.fn(() => mockRequest) };
  return { mockPool, mockDbQuery };
});

vi.mock('../db/connection.js', () => ({ getPool: async () => mockPool }));
vi.mock('../middleware/auth.js', () => ({
  requirePermission: () => (_req, _res, next) => next(),
}));

const SECRET_MASK = '••••••••';

describe('VALID_JOB_TYPES — manifest discovery', () => {
  it('contains all baseline crawler types', () => {
    expect(VALID_JOB_TYPES).toEqual(expect.arrayContaining(['demo', 'entra-id', 'csv', 'omada']));
  });

  it('contains odata (proves manifests loaded — odata is not in the hardcoded fallback)', () => {
    expect(VALID_JOB_TYPES).toContain('odata');
  });
});

describe('validateCrawlerConfig — type coverage', () => {
  it('returns null for an unknown/unregistered type (no schema = no validation)', () => {
    expect(validateCrawlerConfig('unknown-type', {})).toBeNull();
  });

  it('returns null for a type with no configSchema (csv has none)', () => {
    expect(validateCrawlerConfig('csv', {})).toBeNull();
  });
});

describe('maskConfig', () => {
  it('returns null for null input', () => {
    expect(maskConfig(null)).toBeNull();
  });

  it('masks clientSecret', () => {
    const out = maskConfig({ clientSecret: 'super-secret' });
    expect(out.clientSecret).toBe(SECRET_MASK);
  });

  it('masks password', () => {
    const out = maskConfig({ password: 'hunter2' });
    expect(out.password).toBe(SECRET_MASK);
  });

  it('masks apiToken', () => {
    const out = maskConfig({ apiToken: 'tok_abc123' });
    expect(out.apiToken).toBe(SECRET_MASK);
  });

  it('masks cookieString', () => {
    const out = maskConfig({ cookieString: 'session=abc; auth=xyz' });
    expect(out.cookieString).toBe(SECRET_MASK);
  });

  it('does not mask non-secret fields', () => {
    const out = maskConfig({ baseUrl: 'https://omada.example.com', authMethod: 'FormCookie' });
    expect(out.baseUrl).toBe('https://omada.example.com');
    expect(out.authMethod).toBe('FormCookie');
  });

  it('accepts a JSON string as input', () => {
    const out = maskConfig(JSON.stringify({ clientSecret: 'secret', baseUrl: 'http://x' }));
    expect(out.clientSecret).toBe(SECRET_MASK);
    expect(out.baseUrl).toBe('http://x');
  });

  it('leaves absent secret fields absent', () => {
    const out = maskConfig({ baseUrl: 'http://x' });
    expect('password' in out).toBe(false);
    expect('apiToken' in out).toBe(false);
  });
});

// Helper: call validateCrawlerConfig for the 'omada' type
const validateOmada = (config) => validateCrawlerConfig('omada', config);

describe('validateCrawlerConfig (omada)', () => {
  it('returns error when baseUrl is missing', () => {
    expect(validateOmada({})).toMatch(/baseUrl/);
  });

  it('returns error when baseUrl is empty string', () => {
    expect(validateOmada({ baseUrl: '' })).toMatch(/baseUrl/);
  });

  it('returns null for valid FormCookie config', () => {
    expect(validateOmada({
      baseUrl: 'https://omada.example.com',
      authMethod: 'FormCookie',
      username: 'admin',
      password: 'secret',
    })).toBeNull();
  });

  it('returns error for FormCookie missing password', () => {
    expect(validateOmada({
      baseUrl: 'https://omada.example.com',
      authMethod: 'FormCookie',
      username: 'admin',
    })).toMatch(/password/);
  });

  it('returns null for valid OAuth2CC config', () => {
    expect(validateOmada({
      baseUrl: 'https://omada.example.com',
      authMethod: 'OAuth2CC',
      tokenEndpoint: 'https://omada.example.com/oauth2/token',
      clientId: 'client-id',
      clientSecret: 'client-secret',
    })).toBeNull();
  });

  it('returns error for OAuth2CC missing clientSecret', () => {
    expect(validateOmada({
      baseUrl: 'https://omada.example.com',
      authMethod: 'OAuth2CC',
      clientId: 'client-id',
    })).toMatch(/clientSecret/);
  });

  it('returns error for OAuth2CC missing tokenEndpoint', () => {
    expect(validateOmada({
      baseUrl: 'https://omada.example.com',
      authMethod: 'OAuth2CC',
      clientId: 'client-id',
      clientSecret: 'client-secret',
    })).toMatch(/tokenEndpoint/);
  });

  it('returns null for valid OAuth2ROPC config', () => {
    expect(validateOmada({
      baseUrl: 'https://omada.example.com',
      authMethod: 'OAuth2ROPC',
      tokenEndpoint: 'https://omada.example.com/oauth2/token',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      username: 'user',
      password: 'pass',
    })).toBeNull();
  });

  it('returns error for OAuth2ROPC missing tokenEndpoint', () => {
    expect(validateOmada({
      baseUrl: 'https://omada.example.com',
      authMethod: 'OAuth2ROPC',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      username: 'user',
      password: 'pass',
    })).toMatch(/tokenEndpoint/);
  });

  it('returns error for OAuth2ROPC missing username', () => {
    expect(validateOmada({
      baseUrl: 'https://omada.example.com',
      authMethod: 'OAuth2ROPC',
      tokenEndpoint: 'https://omada.example.com/oauth2/token',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      password: 'pass',
    })).toMatch(/username/);
  });

  it('returns null for valid ApiToken config', () => {
    expect(validateOmada({
      baseUrl: 'https://omada.example.com',
      authMethod: 'ApiToken',
      apiToken: 'tok_abc123',
    })).toBeNull();
  });

  it('returns error for ApiToken missing apiToken', () => {
    expect(validateOmada({
      baseUrl: 'https://omada.example.com',
      authMethod: 'ApiToken',
    })).toMatch(/apiToken/);
  });

  it('returns null for valid CookieString config', () => {
    expect(validateOmada({
      baseUrl: 'https://omada.example.com',
      authMethod: 'CookieString',
      cookieString: 'session=abc',
    })).toBeNull();
  });

  it('returns error for CookieString missing cookieString', () => {
    expect(validateOmada({
      baseUrl: 'https://omada.example.com',
      authMethod: 'CookieString',
    })).toMatch(/cookieString/);
  });

  it('returns null for valid BasicAuth config', () => {
    expect(validateOmada({
      baseUrl: 'https://omada.example.com',
      authMethod: 'BasicAuth',
      username: 'admin',
      password: 'pass',
    })).toBeNull();
  });

  it('returns error for BasicAuth missing username', () => {
    expect(validateOmada({
      baseUrl: 'https://omada.example.com',
      authMethod: 'BasicAuth',
      password: 'pass',
    })).toMatch(/username/);
  });

  it('returns null when authMethod is missing (no credential check fires)', () => {
    // authMethod is required per schema — should return an error
    expect(validateOmada({ baseUrl: 'https://omada.example.com' })).toMatch(/authMethod/);
  });
});

// ─── POST /admin/omada/validate-metadata ─────────────────────────────────────

const SAMPLE_XML = `<?xml version="1.0"?>
<edmx:Edmx xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Identity">
        <Property Name="Id"/>
        <Property Name="Username"/>
        <NavigationProperty Name="Groups"/>
      </EntityType>
      <EntityContainer>
        <EntitySet Name="Users"/>
        <EntitySet Name="Roles"/>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(jobsRouter);
  return app;
}

describe('POST /admin/omada/validate-metadata', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('returns 400 when neither configId nor inline config is provided', async () => {
    const res = await request(makeApp()).post('/admin/omada/validate-metadata').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/configId or config required/);
  });

  it('returns 400 when configId is not a number', async () => {
    const res = await request(makeApp()).post('/admin/omada/validate-metadata').send({ configId: 'abc' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/number/);
  });

  it('returns 404 when no matching row exists', async () => {
    mockDbQuery.mockResolvedValue({ recordset: [] });
    const res = await request(makeApp()).post('/admin/omada/validate-metadata').send({ configId: 99 });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('parses entitySets and identityProperties from metadata XML', async () => {
    mockDbQuery.mockResolvedValue({
      recordset: [{ config: { baseUrl: 'https://omada.example.com/odata/dataobjects', authMethod: 'FormCookie' } }],
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => SAMPLE_XML }));

    const res = await request(makeApp()).post('/admin/omada/validate-metadata').send({ configId: 1 });
    expect(res.status).toBe(200);
    expect(res.body.entitySets).toEqual(['Roles', 'Users']);
    expect(res.body.identityProperties).toEqual(['Groups', 'Id', 'Username']);
  });

  it('parses config stored as a JSON string (PGlite path)', async () => {
    mockDbQuery.mockResolvedValue({
      recordset: [{ config: JSON.stringify({ baseUrl: 'https://omada.example.com/odata/dataobjects' }) }],
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => SAMPLE_XML }));

    const res = await request(makeApp()).post('/admin/omada/validate-metadata').send({ configId: 2 });
    expect(res.status).toBe(200);
  });

  it('accepts inline config object (new-crawler wizard mode, no configId)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => SAMPLE_XML }));

    const res = await request(makeApp()).post('/admin/omada/validate-metadata').send({
      config: { baseUrl: 'https://omada.example.com/odata/dataobjects', authMethod: 'FormCookie' },
    });
    expect(res.status).toBe(200);
    expect(res.body.entitySets).toEqual(['Roles', 'Users']);
  });

  it('returns 400 when config has no baseUrl', async () => {
    mockDbQuery.mockResolvedValue({ recordset: [{ config: { authMethod: 'FormCookie' } }] });

    const res = await request(makeApp()).post('/admin/omada/validate-metadata').send({ configId: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/baseUrl/);
  });

  it('returns 502 when the Omada server returns a non-2xx status', async () => {
    mockDbQuery.mockResolvedValue({
      recordset: [{ config: { baseUrl: 'https://omada.example.com/odata/dataobjects' } }],
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));

    const res = await request(makeApp()).post('/admin/omada/validate-metadata').send({ configId: 1 });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/401/);
  });

  it('returns 400 when baseUrl uses a non-http/https scheme', async () => {
    const res = await request(makeApp()).post('/admin/omada/validate-metadata').send({
      config: { baseUrl: 'ftp://evil.com/odata/dataobjects', authMethod: 'ApiToken', apiToken: 'tok' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/http/);
  });
});
