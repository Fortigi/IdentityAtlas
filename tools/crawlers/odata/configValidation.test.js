/**
 * Tests for odata's crawler.json configSchema — which fields each auth method
 * (FormCookie, OAuth2CC, OAuth2ROPC, ApiToken, CookieString, BasicAuth) requires,
 * exercised through the manifest-driven validateCrawlerConfig() engine.
 */
import { describe, it, expect } from 'vitest';
import { validateCrawlerConfig } from '@api/crawlerManifests.js';

const v = (config) => validateCrawlerConfig('odata', config);

describe('validateCrawlerConfig (odata)', () => {
  it('errors when baseUrl is missing', () => {
    expect(v({ authMethod: 'ApiToken', apiToken: 'x' })).toMatch(/baseUrl/);
  });

  it('errors when authMethod is missing', () => {
    expect(v({ baseUrl: 'https://odata.example.com' })).toMatch(/authMethod/);
  });

  it('errors on an unknown authMethod (enum)', () => {
    expect(v({ baseUrl: 'https://odata.example.com', authMethod: 'Nope' })).toMatch(/authMethod/);
  });

  it('errors when a typed field has the wrong type', () => {
    expect(v({ baseUrl: 'https://odata.example.com', authMethod: 'ApiToken', apiToken: 'x', pageSize: 'big' })).toMatch(/pageSize/);
  });

  it('FormCookie: valid with username + password', () => {
    expect(v({ baseUrl: 'https://o', authMethod: 'FormCookie', username: 'u', password: 'p' })).toBeNull();
  });
  it('FormCookie: errors without password', () => {
    expect(v({ baseUrl: 'https://o', authMethod: 'FormCookie', username: 'u' })).toMatch(/password/);
  });

  it('OAuth2CC: valid with tokenEndpoint + clientId + clientSecret', () => {
    expect(v({ baseUrl: 'https://o', authMethod: 'OAuth2CC', tokenEndpoint: 'https://o/t', clientId: 'c', clientSecret: 's' })).toBeNull();
  });
  it('OAuth2CC: errors without clientSecret', () => {
    expect(v({ baseUrl: 'https://o', authMethod: 'OAuth2CC', tokenEndpoint: 'https://o/t', clientId: 'c' })).toMatch(/clientSecret/);
  });

  it('OAuth2ROPC: valid with all five fields', () => {
    expect(v({ baseUrl: 'https://o', authMethod: 'OAuth2ROPC', tokenEndpoint: 'https://o/t', clientId: 'c', clientSecret: 's', username: 'u', password: 'p' })).toBeNull();
  });
  it('OAuth2ROPC: errors without username', () => {
    expect(v({ baseUrl: 'https://o', authMethod: 'OAuth2ROPC', tokenEndpoint: 'https://o/t', clientId: 'c', clientSecret: 's', password: 'p' })).toMatch(/username/);
  });

  it('ApiToken: valid with apiToken', () => {
    expect(v({ baseUrl: 'https://o', authMethod: 'ApiToken', apiToken: 't' })).toBeNull();
  });
  it('ApiToken: errors without apiToken', () => {
    expect(v({ baseUrl: 'https://o', authMethod: 'ApiToken' })).toMatch(/apiToken/);
  });

  it('CookieString: valid with cookieString', () => {
    expect(v({ baseUrl: 'https://o', authMethod: 'CookieString', cookieString: 'c=1' })).toBeNull();
  });
  it('BasicAuth: errors without password', () => {
    expect(v({ baseUrl: 'https://o', authMethod: 'BasicAuth', username: 'u' })).toMatch(/password/);
  });
});
