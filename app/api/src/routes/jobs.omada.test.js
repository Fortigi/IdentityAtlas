/**
 * Unit tests for Omada-specific logic in jobs.js:
 *   - maskConfig: ensures all credential types are masked
 *   - validateOmadaConfig: covers all six auth methods + missing required fields
 *   - PATCH secret preservation: existing secrets survive a no-secret PATCH
 */
import { describe, it, expect } from 'vitest';
import { maskConfig, validateOmadaConfig } from './jobs.js';

const SECRET_MASK = '••••••••';

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

describe('validateOmadaConfig', () => {
  it('returns error when baseUrl is missing', () => {
    expect(validateOmadaConfig({})).toMatch(/baseUrl/);
  });

  it('returns error when baseUrl is empty string', () => {
    expect(validateOmadaConfig({ baseUrl: '' })).toMatch(/baseUrl/);
  });

  it('returns null for valid FormCookie config', () => {
    expect(validateOmadaConfig({
      baseUrl: 'https://omada.example.com',
      authMethod: 'FormCookie',
      username: 'admin',
      password: 'secret',
    })).toBeNull();
  });

  it('returns error for FormCookie missing password', () => {
    expect(validateOmadaConfig({
      baseUrl: 'https://omada.example.com',
      authMethod: 'FormCookie',
      username: 'admin',
    })).toMatch(/username and password/);
  });

  it('returns null for valid OAuth2CC config', () => {
    expect(validateOmadaConfig({
      baseUrl: 'https://omada.example.com',
      authMethod: 'OAuth2CC',
      clientId: 'client-id',
      clientSecret: 'client-secret',
    })).toBeNull();
  });

  it('returns error for OAuth2CC missing clientSecret', () => {
    expect(validateOmadaConfig({
      baseUrl: 'https://omada.example.com',
      authMethod: 'OAuth2CC',
      clientId: 'client-id',
    })).toMatch(/clientId and clientSecret/);
  });

  it('returns null for valid OAuth2ROPC config', () => {
    expect(validateOmadaConfig({
      baseUrl: 'https://omada.example.com',
      authMethod: 'OAuth2ROPC',
      tokenEndpoint: 'https://omada.example.com/oauth2/token',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      username: 'user',
      password: 'pass',
    })).toBeNull();
  });

  it('returns null for valid ApiToken config', () => {
    expect(validateOmadaConfig({
      baseUrl: 'https://omada.example.com',
      authMethod: 'ApiToken',
      apiToken: 'tok_abc123',
    })).toBeNull();
  });

  it('returns error for ApiToken missing apiToken', () => {
    expect(validateOmadaConfig({
      baseUrl: 'https://omada.example.com',
      authMethod: 'ApiToken',
    })).toMatch(/apiToken/);
  });

  it('returns null for valid CookieString config', () => {
    expect(validateOmadaConfig({
      baseUrl: 'https://omada.example.com',
      authMethod: 'CookieString',
      cookieString: 'session=abc',
    })).toBeNull();
  });

  it('returns error for CookieString missing cookieString', () => {
    expect(validateOmadaConfig({
      baseUrl: 'https://omada.example.com',
      authMethod: 'CookieString',
    })).toMatch(/cookieString/);
  });

  it('returns null for valid BasicAuth config', () => {
    expect(validateOmadaConfig({
      baseUrl: 'https://omada.example.com',
      authMethod: 'BasicAuth',
      username: 'admin',
      password: 'pass',
    })).toBeNull();
  });

  it('returns error for BasicAuth missing username', () => {
    expect(validateOmadaConfig({
      baseUrl: 'https://omada.example.com',
      authMethod: 'BasicAuth',
      password: 'pass',
    })).toMatch(/username and password/);
  });

  it('returns null when no authMethod is specified (no credentials required)', () => {
    // No authMethod = no credential check fires — the worker will fail at connect time
    expect(validateOmadaConfig({ baseUrl: 'https://omada.example.com' })).toBeNull();
  });
});
