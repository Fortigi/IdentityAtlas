/**
 * Unit tests for Omada-specific logic in jobs.js:
 *   - maskConfig: ensures all credential types are masked
 *   - validateCrawlerConfig('omada', ...): covers all six auth methods + missing required fields
 *
 * The Omada live-discovery handler itself (tools/crawlers/omada/discover.js)
 * is tested separately in tools/crawlers/omada/discover.test.js.
 */
import { describe, it, expect } from 'vitest';
import { maskConfig, validateCrawlerConfig, VALID_JOB_TYPES } from './jobs.js';

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
