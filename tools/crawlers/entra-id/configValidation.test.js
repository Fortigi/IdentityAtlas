/**
 * Tests for entra-id's crawler.json configSchema — app-registration auth
 * (tenantId/clientId/clientSecret required) or managed-identity auth (tenantId
 * only), exercised through the manifest-driven validateCrawlerConfig() engine.
 */
import { describe, it, expect } from 'vitest';
import { validateCrawlerConfig } from '@api/crawlerManifests.js';

const v = (config) => validateCrawlerConfig('entra-id', config);

describe('validateCrawlerConfig (entra-id)', () => {
  it('valid with tenantId + clientId + clientSecret', () => {
    expect(v({ tenantId: 't', clientId: 'c', clientSecret: 's' })).toBeNull();
  });

  it('errors when all fields are missing', () => {
    expect(v({})).toMatch(/tenantId|clientId|clientSecret/);
  });
  it('errors without clientSecret', () => {
    expect(v({ tenantId: 't', clientId: 'c' })).toMatch(/clientSecret/);
  });
  it('errors without clientId', () => {
    expect(v({ tenantId: 't', clientSecret: 's' })).toMatch(/clientId/);
  });
  it('errors without tenantId', () => {
    expect(v({ clientId: 'c', clientSecret: 's' })).toMatch(/tenantId/);
  });

  it('authMethod ClientSecret is the same as leaving it out', () => {
    expect(v({ authMethod: 'ClientSecret', tenantId: 't', clientId: 'c', clientSecret: 's' })).toBeNull();
    expect(v({ authMethod: 'ClientSecret', tenantId: 't', clientId: 'c' })).toMatch(/clientSecret/);
  });

  it('a managed identity needs neither clientId nor clientSecret', () => {
    expect(v({ authMethod: 'ManagedIdentity', tenantId: 't' })).toBeNull();
  });
  it('a managed identity still needs the tenant', () => {
    expect(v({ authMethod: 'ManagedIdentity' })).toMatch(/tenantId/);
  });
  it('rejects an unknown authMethod instead of treating it as one of the two', () => {
    expect(v({ authMethod: 'Certificate', tenantId: 't', clientId: 'c', clientSecret: 's' })).toMatch(/authMethod|allowed values/);
  });
});
