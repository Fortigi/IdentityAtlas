/**
 * Tests for Omada's crawler.json configSchema — which fields each auth
 * method (FormCookie, OAuth2CC, OAuth2ROPC, ApiToken, CookieString,
 * BasicAuth) requires — exercised through the generic, manifest-driven
 * validateCrawlerConfig() engine in app/api/src/crawlerManifests.js.
 *
 * The engine itself (maskConfig, manifest discovery) has no Omada-specific
 * behavior and is tested separately in
 * app/api/src/routes/jobs.configValidation.test.js.
 */
import { describe, it, expect } from 'vitest';
import { validateCrawlerConfig } from '../../../app/api/src/crawlerManifests.js';

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
