/**
 * Tests for midpoint's crawler.json configSchema — which fields each auth method
 * (BasicAuth, ApiToken, OAuth2CC, OAuth2ROPC) requires, exercised through the
 * manifest-driven validateCrawlerConfig() engine.
 */
import { describe, it, expect } from 'vitest';
import { validateCrawlerConfig } from '@api/crawlerManifests.js';

const v = (config) => validateCrawlerConfig('midpoint', config);

describe('validateCrawlerConfig (midpoint)', () => {
  it('errors when baseUrl is missing', () => {
    expect(v({ authMethod: 'ApiToken', apiToken: 't' })).toMatch(/baseUrl/);
  });
  it('errors when authMethod is missing', () => {
    expect(v({ baseUrl: 'https://mp.example.com' })).toMatch(/authMethod/);
  });
  it('errors on an unknown authMethod (enum)', () => {
    expect(v({ baseUrl: 'https://mp', authMethod: 'FormCookie' })).toMatch(/authMethod/);
  });

  it('BasicAuth: valid with username + password', () => {
    expect(v({ baseUrl: 'https://mp', authMethod: 'BasicAuth', username: 'u', password: 'p' })).toBeNull();
  });
  it('BasicAuth: errors without password', () => {
    expect(v({ baseUrl: 'https://mp', authMethod: 'BasicAuth', username: 'u' })).toMatch(/password/);
  });

  it('ApiToken: valid with apiToken', () => {
    expect(v({ baseUrl: 'https://mp', authMethod: 'ApiToken', apiToken: 't' })).toBeNull();
  });

  it('OAuth2CC: valid with tokenEndpoint + clientId + clientSecret', () => {
    expect(v({ baseUrl: 'https://mp', authMethod: 'OAuth2CC', tokenEndpoint: 'https://mp/t', clientId: 'c', clientSecret: 's' })).toBeNull();
  });
  it('OAuth2CC: errors without clientSecret', () => {
    expect(v({ baseUrl: 'https://mp', authMethod: 'OAuth2CC', tokenEndpoint: 'https://mp/t', clientId: 'c' })).toMatch(/clientSecret/);
  });

  it('OAuth2ROPC: valid with all five fields', () => {
    expect(v({ baseUrl: 'https://mp', authMethod: 'OAuth2ROPC', tokenEndpoint: 'https://mp/t', clientId: 'c', clientSecret: 's', username: 'u', password: 'p' })).toBeNull();
  });
  it('OAuth2ROPC: errors without username', () => {
    expect(v({ baseUrl: 'https://mp', authMethod: 'OAuth2ROPC', tokenEndpoint: 'https://mp/t', clientId: 'c', clientSecret: 's', password: 'p' })).toMatch(/username/);
  });
});
