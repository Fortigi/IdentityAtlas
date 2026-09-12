/**
 * Tests for scim's crawler.json configSchema — which fields each auth method
 * (BasicAuth, ApiToken, OAuth2CC) requires, exercised through the
 * manifest-driven validateCrawlerConfig() engine.
 */
import { describe, it, expect } from 'vitest';
import { validateCrawlerConfig } from '@api/crawlerManifests.js';

const v = (config) => validateCrawlerConfig('scim', config);
const BASE = 'https://api.example.com/scim/v2';

describe('validateCrawlerConfig (scim)', () => {
  it('errors when baseUrl is missing', () => {
    expect(v({ authMethod: 'ApiToken', apiToken: 't' })).toMatch(/baseUrl/);
  });
  it('errors when baseUrl is an empty string', () => {
    expect(v({ baseUrl: '', authMethod: 'ApiToken', apiToken: 't' })).toMatch(/baseUrl/);
  });
  it('errors when authMethod is missing', () => {
    expect(v({ baseUrl: BASE })).toMatch(/authMethod/);
  });
  it('rejects an auth method this crawler does not implement (X.509 / ROPC are deferred)', () => {
    expect(v({ baseUrl: BASE, authMethod: 'OAuth2ROPC', tokenEndpoint: 't', clientId: 'c', clientSecret: 's', username: 'u', password: 'p' })).toMatch(/authMethod/);
    expect(v({ baseUrl: BASE, authMethod: 'ClientCert', certificate: 'x' })).toMatch(/authMethod/);
  });

  it('BasicAuth: valid with username + password', () => {
    expect(v({ baseUrl: BASE, authMethod: 'BasicAuth', username: 'u', password: 'p' })).toBeNull();
  });
  it('BasicAuth: errors without password', () => {
    expect(v({ baseUrl: BASE, authMethod: 'BasicAuth', username: 'u' })).toMatch(/password/);
  });
  it('BasicAuth: errors without username', () => {
    expect(v({ baseUrl: BASE, authMethod: 'BasicAuth', password: 'p' })).toMatch(/username/);
  });

  it('ApiToken: valid with apiToken', () => {
    expect(v({ baseUrl: BASE, authMethod: 'ApiToken', apiToken: 't' })).toBeNull();
  });
  it('ApiToken: errors without apiToken', () => {
    expect(v({ baseUrl: BASE, authMethod: 'ApiToken' })).toMatch(/apiToken/);
  });

  it('OAuth2CC: valid with tokenEndpoint + clientId + clientSecret', () => {
    expect(v({ baseUrl: BASE, authMethod: 'OAuth2CC', tokenEndpoint: 'https://idp/t', clientId: 'c', clientSecret: 's' })).toBeNull();
  });
  it('OAuth2CC: errors without clientSecret (the field the vault re-supplies)', () => {
    expect(v({ baseUrl: BASE, authMethod: 'OAuth2CC', tokenEndpoint: 'https://idp/t', clientId: 'c' })).toMatch(/clientSecret/);
  });
  it('OAuth2CC: errors without tokenEndpoint', () => {
    expect(v({ baseUrl: BASE, authMethod: 'OAuth2CC', clientId: 'c', clientSecret: 's' })).toMatch(/tokenEndpoint/);
  });

  it('accepts the optional sync settings the wizard writes', () => {
    expect(v({
      baseUrl: BASE, authMethod: 'ApiToken', apiToken: 't',
      systemName: 'SAP CIS', pageSize: 50,
      selectedObjects: { users: true, groups: true, groupMembers: false },
      selectedAttributes: { user: ['department'], group: [] },
      userTypeMapping: [{ userType: 'service', principalType: 'ServicePrincipal' }, { userType: '', principalType: 'User' }],
    })).toBeNull();
  });

  it('rejects a principalType outside the Identity Atlas vocabulary', () => {
    expect(v({
      baseUrl: BASE, authMethod: 'ApiToken', apiToken: 't',
      userTypeMapping: [{ userType: 'service', principalType: 'Robot' }],
    })).toMatch(/principalType/);
  });
});
